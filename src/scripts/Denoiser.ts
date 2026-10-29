import metadata from "@/assets/model/model_metadata.json";
import { InferenceSession, Tensor } from "onnxruntime-react-native";

/** Recurrent state for ONE denoise stream. Never share between pipelines. */
export interface StreamState {
    states: Tensor | Tensor[];
    stateBuffers: Float32Array[];
    attenLimDb: Tensor;
    attenLimDbData: Float32Array;
    inputFrameData: Float32Array;
    inputFrame: Tensor;
}

export class DeepFilterNet {
    private session: InferenceSession | null = null;
    private readonly hopSize: number;
    private readonly fftSize: number;
    private readonly stateInputNames: string[];
    private readonly stateOutputNames: string[];
    private readonly hasSingleStateTensor: boolean;
    private readonly statesShape: number[];
    private readonly statesLen: number;
    private readonly inputNames: string[];
    private readonly outputNames: string[];

    /**
     * Streaming state is now owned by the CALLER, not by this class. The ONNX
     * session is a process-wide singleton shared by the file-denoise and live
     * recording screens; keeping recurrent state on the session meant one
     * screen could reset the other's state mid-stream (AUD-01).
     */
    public createStream(attenLimDbValue: number = 0.0): StreamState {
        const { states, stateBuffers, attenLimDb, attenLimDbData } =
            this.initStates(attenLimDbValue);
        const inputFrameData = new Float32Array(this.hopSize);
        const inputFrame = new Tensor("float32", inputFrameData, [this.hopSize]);
        return {
            states,
            stateBuffers,
            attenLimDb,
            attenLimDbData,
            inputFrameData,
            inputFrame,
        };
    }

    /** Safe to call mid-stream (AUD-16): mutates the tensor's backing buffer. */
    public setStreamAttenLimDb(state: StreamState, value: number): void {
        state.attenLimDbData[0] = value;
    }

    constructor() {
        this.hopSize = metadata.hop_size;
        this.fftSize = metadata.fft_size;
        this.inputNames = metadata.inputs.map((i) => i.name);
        this.outputNames = metadata.outputs.map((o) => o.name);

        this.stateInputNames = metadata.state_input_names.length
            ? [...metadata.state_input_names]
            : this.inputNames.filter((name) => name !== "input_frame" && name !== "atten_lim_db");
        this.stateOutputNames = this.stateInputNames.map((name) => {
            if (!this.inputNames.includes(name)) throw new Error(`Missing model state input: ${name}`);
            const output = `new_${name}`;
            if (!this.outputNames.includes(output)) throw new Error(`Missing model state output: ${output}`);
            return output;
        });
        this.hasSingleStateTensor = this.stateInputNames.includes("states");

        if (this.hasSingleStateTensor) {
            const statesMeta = metadata.inputs.find((i) => i.name === "states");
            if (!statesMeta) throw new Error("Metadata for 'states' input not found.");
            this.statesShape = statesMeta.shape;
            this.statesLen = this.statesShape.reduce((a, b) => a * b, 1);
        } else {
            this.statesShape = [];
            this.statesLen = 0;
        }
    }

    public lastEngine = "not-loaded";

    public async loadModel(
        modelPath: string,
        mode: "auto" | "xnnpack" | "cpu" | "nnapi" | "gpu" = "auto",
        threads: 2 | 4 | 8 = 4,
    ): Promise<void> {
        const base = {
            graphOptimizationLevel: "all" as const,
            interOpNumThreads: 1,
            intraOpNumThreads: threads,
        };

        const tryCreate = async (
            label: string,
            providers: (string | Record<string, unknown>)[],
        ) => {
            console.log(`[DeepFilterNet] ENGINE trying ${label} threads=${threads}`);
            this.session = await InferenceSession.create(modelPath, {
                ...base,
                executionProviders: providers as string[],
            });
            this.lastEngine = `${label} x${threads}`;
            console.log(`[DeepFilterNet] LOADED engine=${this.lastEngine}`);
        };

        const xnnpackCpu = ["xnnpack", "cpu"];
        const cpuOnly = ["cpu"];
        // NNAPI with CPU partitioning (stable on Adreno 640)
        const nnapiSoft = [
            { name: "nnapi", useFP16: false, cpuDisabled: false },
            "xnnpack",
            "cpu",
        ];
        // Prefer non-CPU NNAPI devices (GPU/DSP when the driver allows).
        // Often fails on DeepFilterNet ops — we fall back.
        const nnapiGpuPrefer = [
            { name: "nnapi", useFP16: false, cpuDisabled: true },
            "xnnpack",
            "cpu",
        ];

        // There is no OpenCL/Vulkan EP in onnxruntime-react-native.
        // "gpu" = best-effort Adreno path via Android NNAPI GPU/DSP.
        let attempts: { label: string; providers: (string | Record<string, unknown>)[] }[];
        if (mode === "cpu") {
            attempts = [{ label: "cpu", providers: cpuOnly }];
        } else if (mode === "xnnpack" || mode === "auto") {
            attempts = [
                { label: "xnnpack+cpu", providers: xnnpackCpu },
                { label: "cpu", providers: cpuOnly },
            ];
        } else if (mode === "gpu") {
            attempts = [
                { label: "nnapi-gpu-prefer", providers: nnapiGpuPrefer },
                { label: "nnapi+xnnpack+cpu", providers: nnapiSoft },
                { label: "xnnpack+cpu", providers: xnnpackCpu },
                { label: "cpu", providers: cpuOnly },
            ];
        } else {
            // nnapi
            attempts = [
                { label: "nnapi+xnnpack+cpu", providers: nnapiSoft },
                { label: "xnnpack+cpu", providers: xnnpackCpu },
                { label: "cpu", providers: cpuOnly },
            ];
        }

        let lastError: unknown;
        for (const attempt of attempts) {
            try {
                await tryCreate(attempt.label, attempt.providers);
                return;
            } catch (e) {
                lastError = e;
                console.warn(`[DeepFilterNet] ${attempt.label} failed: ${e}`);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    public async processFrame(
        state: StreamState,
        frame: Float32Array,
        dest?: Float32Array,
        destOffset = 0,
    ): Promise<Float32Array> {
        if (!this.session) throw new Error("Session not initialized");

        const { states, stateBuffers, attenLimDb, inputFrameData, inputFrame } = state;

        // Clear the tail so a short final frame never replays stale samples (AUD-15).
        inputFrameData.fill(0);
        inputFrameData.set(frame);

        const feeds: Record<string, Tensor> = {
            input_frame: inputFrame
        };

        if (this.inputNames.includes("atten_lim_db")) {
            feeds["atten_lim_db"] = attenLimDb;
        }

        if (this.hasSingleStateTensor) {
            feeds["states"] = states as Tensor;
        } else {
            const stateTensors = states as Tensor[];
            for (let j = 0; j < stateTensors.length; j++) {
                feeds[this.stateInputNames[j]] = stateTensors[j];
            }
        }

        const results = await this.session.run(feeds);

        // Copy output state data back into the pre-allocated state tensors
        // (buffer reuse — no new Tensor objects per frame, avoiding GC churn
        // across the 100k+ frames of a long file).
        if (this.hasSingleStateTensor) {
            const nextStateRaw = results[this.stateOutputNames[0]].data as Float32Array;
            stateBuffers[0].set(nextStateRaw);
        } else {
            for (let j = 0; j < this.stateInputNames.length; j++) {
                const nextMultiStateRaw = results[this.stateOutputNames[j]].data as Float32Array;
                stateBuffers[j].set(nextMultiStateRaw);
            }
        }

        // Write output directly into `dest` when provided, avoiding an extra
        // allocation + copy in the caller's hot loop.
        const outFrameRaw = results[this.outputNames[0]].data as Float32Array;
        if (dest) {
            dest.set(outFrameRaw, destOffset);
            return dest;
        }
        return outFrameRaw;
    }

    public async release(): Promise<void> {
        if (this.session) {
            try {
                await this.session.release();
                this.session = null;
            } catch (e) {
                console.error("Failed to release InferenceSession:", e);
            }
        }
    }

    private initStates(attenLimDbValue: number = 0.0): {
        states: Tensor | Tensor[];
        stateBuffers: Float32Array[];
        attenLimDb: Tensor;
        attenLimDbData: Float32Array;
    } {
        let states: Tensor | Tensor[];
        let stateBuffers: Float32Array[];

        if (this.hasSingleStateTensor) {
            const buffer = new Float32Array(this.statesLen);
            stateBuffers = [buffer];
            states = new Tensor("float32", buffer, this.statesShape);
        } else {
            states = [];
            stateBuffers = [];
            const stateInputsMeta = this.stateInputNames.map((name) => {
                const meta = metadata.inputs.find((input) => input.name === name);
                if (!meta) throw new Error(`Missing metadata for model state: ${name}`);
                return meta;
            });
            for (const meta of stateInputsMeta) {
                const size = meta.shape.reduce((a, b) => a * b, 1);
                const buffer = new Float32Array(size);
                stateBuffers.push(buffer);
                states.push(
                    new Tensor("float32", buffer, meta.shape),
                );
            }
        }

        const attenLimDbData = new Float32Array([attenLimDbValue]);
        const attenLimDb = new Tensor("float32", attenLimDbData, [1]);
        return { states, stateBuffers, attenLimDb, attenLimDbData };
    }

    /**
     * Denoise audio feed(s).
     */
    public async denoise(
        audio: Float32Array | Float32Array[],
        onProgress?: ((p: number) => void) | ((p: number, i: number) => void),
        attenLimDbValue: number = 0.0,
    ): Promise<Float32Array | Float32Array[]> {
        if (!this.session) {
            throw new Error("Model not loaded. Please call loadModel() first.");
        }

        const isArray = Array.isArray(audio);
        const feeds = isArray ? audio : [audio];

        // Validate amplitude range for each feed
        for (const feed of feeds) {
            let maxAmplitude = 0;
            for (let i = 0; i < feed.length; i++) {
                const abs = Math.abs(feed[i]);
                if (abs > maxAmplitude) maxAmplitude = abs;
            }
            if (maxAmplitude > 2.0) {
                console.warn(`Audio amplitude (${maxAmplitude}) exceeds expected [-1.0, 1.0] range. Ensure input is float32 PCM.`);
            }
        }

        const results = await this.runDenoiseLoop(feeds, onProgress, attenLimDbValue);

        return isArray ? results : results[0];
    }

    private async runDenoiseLoop(
        audioFeeds: Float32Array[],
        onProgress?: ((p: number) => void) | ((p: number, i: number) => void),
        attenLimDbValue: number = 0.0,
    ): Promise<Float32Array[]> {
        if (!this.session) throw new Error("Session not initialized");

        const numFeeds = audioFeeds.length;
        const origLen = audioFeeds[0].length;

        // ALIGNMENT: Prepend fftSize zeros for delay compensation
        const hopSizePadding = (this.hopSize - (origLen % this.hopSize)) % this.hopSize;
        const totalPadding = this.fftSize + hopSizePadding;
        const paddedLen = origLen + totalPadding;
        const numSteps = Math.ceil(paddedLen / this.hopSize);

        // Prepare resources for all feeds
        const feedStates = audioFeeds.map(() => {
            const { states, attenLimDb } = this.initStates(attenLimDbValue);
            const inputFrameData = new Float32Array(this.hopSize);
            const inputFrame = new Tensor("float32", inputFrameData, [this.hopSize]);
            const paddedAudio = new Float32Array(paddedLen);
            return {
                states,
                attenLimDb,
                inputFrameData,
                inputFrame,
                paddedAudio,
                enhancedAudio: new Float32Array(numSteps * this.hopSize),
            };
        });

        // Initialize padded audio buffers
        for (let i = 0; i < numFeeds; i++) {
            feedStates[i].paddedAudio.set(audioFeeds[i], this.fftSize);
        }

        let lastReportedProgress = -1;

        for (let step = 0; step < numSteps; step++) {
            const start = step * this.hopSize;

            const inferencePromises = feedStates.map(async (f) => {
                f.inputFrameData.set(f.paddedAudio.subarray(start, start + this.hopSize));

                const feeds: Record<string, Tensor> = {
                    input_frame: f.inputFrame
                };

                if (this.inputNames.includes("atten_lim_db")) {
                    feeds["atten_lim_db"] = f.attenLimDb;
                }

                if (this.hasSingleStateTensor) {
                    feeds["states"] = f.states as Tensor;
                } else {
                    const stateTensors = f.states as Tensor[];
                    for (let j = 0; j < stateTensors.length; j++) {
                        feeds[this.stateInputNames[j]] = stateTensors[j];
                    }
                }

                const results = await this.session!.run(feeds);

                const outFrameRaw = results[this.outputNames[0]].data as Float32Array;
                f.enhancedAudio.set(outFrameRaw, start);

                if (this.hasSingleStateTensor) {
                    const nextStateRaw = results[this.stateOutputNames[0]].data as Float32Array;
                    f.states = new Tensor("float32", nextStateRaw, this.statesShape);
                } else {
                    const newStates: Tensor[] = [];
                    for (let j = 0; j < this.stateInputNames.length; j++) {
                        const nextMultiStateRaw = results[this.stateOutputNames[j]].data as Float32Array;
                        const originalShape = (f.states as Tensor[])[j].dims;
                        newStates.push(new Tensor("float32", nextMultiStateRaw, originalShape));
                    }
                    f.states = newStates;
                }
            });

            await Promise.all(inferencePromises);

            if (onProgress) {
                const progress = Math.round(((step + 1) / numSteps) * 100);
                if (progress > lastReportedProgress) {
                    if (numFeeds > 1) {
                        for (let i = 0; i < numFeeds; i++) {
                            (onProgress as (p: number, i: number) => void)(progress, i);
                        }
                    } else {
                        (onProgress as (p: number) => void)(progress);
                    }
                    lastReportedProgress = progress;
                }
            }
        }

        return feedStates.map(f => f.enhancedAudio.slice(this.fftSize, origLen + this.fftSize));
    }

}