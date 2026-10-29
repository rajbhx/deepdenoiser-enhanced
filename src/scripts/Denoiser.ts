import metadata from "@/assets/model/model_metadata.json";
import { InferenceSession, Tensor } from "onnxruntime-react-native";
import { AlignedDenoiseStream } from "./alignedDenoiseStream";

/** Recurrent state for ONE denoise stream. Never share between pipelines. */
export interface StreamState {
    states: Tensor | Tensor[];
    stateBuffers: Float32Array[];
    attenLimDb: Tensor;
    attenLimDbData: Float32Array;
    /** Cached dry/wet coefficient; keyed to the actual float32 strength value. */
    wetMixAttenDb: number | null;
    wetMix: number;
    inputFrameData: Float32Array;
    inputFrame: Tensor;
    /** Stable tensor maps are owned by this stream and never shared with other streams. */
    feeds: Record<string, Tensor>;
    reusableOutputs: Record<string, Tensor> | null;
    outputReuse: "probe" | "enabled" | "disabled";
    /** Dry signal delayed to match the causal model before mixing. */
    dryDelay: Float32Array;
    dryDelayIndex: number;
}

export class DeepFilterNet {
    private session: InferenceSession | null = null;
    private readonly hopSize: number;
    private readonly delaySamples: number;
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
        const feeds: Record<string, Tensor> = { input_frame: inputFrame };
        if (this.inputNames.includes("atten_lim_db")) feeds.atten_lim_db = attenLimDb;
        if (this.hasSingleStateTensor) {
            feeds.states = states as Tensor;
        } else {
            this.stateInputNames.forEach((name, index) => { feeds[name] = (states as Tensor[])[index]; });
        }
        const reusableOutputs = this.createReusableOutputs();
        return {
            states,
            stateBuffers,
            attenLimDb,
            attenLimDbData,
            wetMixAttenDb: null,
            wetMix: 1,
            inputFrameData,
            inputFrame,
            feeds,
            reusableOutputs,
            outputReuse: reusableOutputs ? "probe" : "disabled",
            dryDelay: new Float32Array(this.delaySamples),
            dryDelayIndex: 0,
        };
    }

    /** Safe to call mid-stream (AUD-16): mutates the tensor's backing buffer. */
    public setStreamAttenLimDb(state: StreamState, value: number): void {
        if (!Number.isFinite(value)) throw new Error("Invalid denoise strength");
        state.attenLimDbData[0] = Math.max(0, Math.min(40, value));
    }

    constructor() {
        this.hopSize = metadata.hop_size;
        this.delaySamples = metadata.algorithmic_delay_samples;
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
    /** Most recent stream's verified model-output path (for local diagnostics). */
    public lastOutputBufferMode: "not-tested" | "reuse" | "standard" = "not-tested";

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

    /** Preallocate fixed float outputs only; unknown/dynamic models use the standard path. */
    private createReusableOutputs(): Record<string, Tensor> | null {
        const outputs: Record<string, Tensor> = {};
        for (const output of metadata.outputs) {
            if (output.type !== "tensor(float)" ||
                !output.shape.every(size => Number.isSafeInteger(size) && size > 0)) return null;
            const length = output.shape.reduce((a, b) => a * b, 1);
            // Refuse surprising model metadata rather than risking a large allocation.
            if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) return null;
            outputs[output.name] = new Tensor("float32", new Float32Array(length), output.shape);
        }
        return Object.keys(outputs).length ? outputs : null;
    }

    /**
     * React Native's ORT binding can write into output tensors supplied by the
     * caller. Probe once per stream against ordinary inference on the same
     * inputs; enable reuse only if every result is bit-for-bit equal and the
     * binding returns our actual tensors. Some runtimes ignore preallocation.
     */
    private async runFrame(state: StreamState): Promise<Awaited<ReturnType<InferenceSession["run"]>>> {
        if (!this.session) throw new Error("Session not initialized");
        const session = this.session;
        const outputs = state.reusableOutputs;
        if (!outputs || state.outputReuse === "disabled") {
            this.lastOutputBufferMode = "standard";
            return session.run(state.feeds);
        }
        if (state.outputReuse === "probe") {
            const standard = await session.run(state.feeds);
            try {
                const candidate = await session.run(state.feeds, outputs);
                const supported = Object.keys(outputs).every(name => {
                    if (candidate[name] !== outputs[name]) return false;
                    const expected = standard[name]?.data;
                    const actual = candidate[name]?.data;
                    if (!(expected instanceof Float32Array) || !(actual instanceof Float32Array) ||
                        expected.length !== actual.length) return false;
                    const expectedBits = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
                    const actualBits = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
                    for (let i = 0; i < expectedBits.length; i++) {
                        if (expectedBits[i] !== actualBits[i]) return false;
                    }
                    return true;
                });
                state.outputReuse = supported ? "enabled" : "disabled";
            } catch {
                state.outputReuse = "disabled";
            }
            if (state.outputReuse === "disabled") state.reusableOutputs = null;
            this.lastOutputBufferMode = state.outputReuse === "enabled" ? "reuse" : "standard";
            // Use the independently verified standard result for the probe frame.
            return standard;
        }
        try {
            const result = await session.run(state.feeds, outputs);
            if (Object.keys(outputs).some(name => result[name] !== outputs[name])) {
                // The run succeeded but the binding stopped honoring reuse.
                state.outputReuse = "disabled";
                state.reusableOutputs = null;
            }
            this.lastOutputBufferMode = state.outputReuse === "enabled" ? "reuse" : "standard";
            return result;
        } catch {
            // Output buffers are distinct from inputs. A failed preallocated
            // run cannot advance our recurrent state, so retry this frame once
            // using the conventional API before surfacing any error.
            state.outputReuse = "disabled";
            state.reusableOutputs = null;
            this.lastOutputBufferMode = "standard";
            return session.run(state.feeds);
        }
    }

    public async processFrame(
        state: StreamState,
        frame: Float32Array,
        dest?: Float32Array,
        destOffset = 0,
    ): Promise<Float32Array> {
        if (!this.session) throw new Error("Session not initialized");

        const { stateBuffers, inputFrameData } = state;
        if (frame.length > this.hopSize) throw new Error("Denoiser input exceeds one frame");
        for (const sample of frame) {
            if (!Number.isFinite(sample)) throw new Error("Input audio contains a non-finite sample");
        }

        // Full, non-aliasing frames overwrite every sample. Short frames must
        // clear the tail (AUD-15); preserve the previous clear-first behavior
        // for any unusual caller supplying a view of this same backing buffer.
        if (frame.length < this.hopSize || frame.buffer === inputFrameData.buffer) {
            inputFrameData.fill(0);
        }
        inputFrameData.set(frame);

        const results = await this.runFrame(state);

        const outFrameRaw = results[this.outputNames[0]]?.data as Float32Array | undefined;
        if (!outFrameRaw || outFrameRaw.length !== this.hopSize) {
            throw new Error("Denoiser returned an invalid audio frame");
        }
        for (const sample of outFrameRaw) {
            if (!Number.isFinite(sample)) {
                throw new Error("Denoiser produced non-finite audio; no output was saved");
            }
        }

        // Keep the recurrent normalization divisor positive. Long digital
        // silence can otherwise underflow it to zero on Android accelerators.
        for (let j = 0; j < stateBuffers.length; j++) {
            const next = results[this.stateOutputNames[j]]?.data as Float32Array | undefined;
            if (!next || next.length !== stateBuffers[j].length) {
                throw new Error(`Denoiser returned invalid state: ${this.stateOutputNames[j]}`);
            }
            stateBuffers[j].set(next);
            if (this.stateInputNames[j] === "band_unit_norm_state") {
                for (let i = 0; i < stateBuffers[j].length; i++) {
                    const value = stateBuffers[j][i];
                    if (!Number.isFinite(value)) throw new Error("Denoiser normalization state is non-finite");
                    stateBuffers[j][i] = Math.max(value, 1e-12);
                }
            }
        }

        // This bundled model has no atten_lim_db input. Its UI convention is
        // 0 dB = strongest and 40 dB = nearly original, so mix the output with
        // a dry signal delayed by exactly the model's measured latency.
        const output = dest ?? new Float32Array(this.hopSize);
        const nativeStrength = this.inputNames.includes("atten_lim_db");
        const attenuation = state.attenLimDbData[0];
        if (!nativeStrength && state.wetMixAttenDb !== attenuation) {
            // Use the stored float32 value, exactly as before. A direct
            // mutation by a caller also invalidates this per-stream cache.
            state.wetMix = Math.pow(10, -attenuation / 20);
            state.wetMixAttenDb = attenuation;
        }
        const wet = nativeStrength ? 1 : state.wetMix;
        for (let i = 0; i < this.hopSize; i++) {
            let dry = inputFrameData[i];
            if (state.dryDelay.length) {
                dry = state.dryDelay[state.dryDelayIndex];
                state.dryDelay[state.dryDelayIndex] = inputFrameData[i];
                state.dryDelayIndex = (state.dryDelayIndex + 1) % state.dryDelay.length;
            }
            output[destOffset + i] = outFrameRaw[i] * wet + dry * (1 - wet);
        }
        return output;
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
                // DeepFilterNet's running statistics are not zero-initialized.
                // A zero unit-norm state divides by zero on the first frame.
                if (meta.name === "erb_norm_state" || meta.name === "band_unit_norm_state") {
                    const start = meta.name === "erb_norm_state" ? -60 : 0.001;
                    const end = meta.name === "erb_norm_state" ? -90 : 0.0001;
                    for (let i = 0; i < size; i++) {
                        buffer[i] = start + (end - start) * i / Math.max(1, size - 1);
                    }
                }
                stateBuffers.push(buffer);
                states.push(
                    new Tensor("float32", buffer, meta.shape),
                );
            }
        }

        if (!Number.isFinite(attenLimDbValue)) throw new Error("Invalid denoise strength");
        const attenLimDbData = new Float32Array([Math.max(0, Math.min(40, attenLimDbValue))]);
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
        const results: Float32Array[] = [];
        for (let i = 0; i < audioFeeds.length; i++) {
            const feed = audioFeeds[i];
            const state = this.createStream(attenLimDbValue);
            const aligned = new AlignedDenoiseStream(this.hopSize, this.delaySamples, (frame, output) =>
                this.processFrame(state, frame, output));
            const chunks: Float32Array[] = [];
            // Limit intermediate allocations for callers supplying long audio.
            const chunkSize = this.hopSize * 100;
            for (let offset = 0; offset < feed.length; offset += chunkSize) {
                chunks.push(await aligned.push(feed.subarray(offset, offset + chunkSize)));
                if (onProgress) {
                    const progress = Math.round(Math.min(offset + chunkSize, feed.length) / feed.length * 99);
                    if (audioFeeds.length > 1) (onProgress as (p: number, i: number) => void)(progress, i);
                    else (onProgress as (p: number) => void)(progress);
                }
            }
            chunks.push(await aligned.finish());
            const output = new Float32Array(feed.length);
            let offset = 0;
            for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
            if (onProgress) {
                if (audioFeeds.length > 1) (onProgress as (p: number, i: number) => void)(100, i);
                else (onProgress as (p: number) => void)(100);
            }
            results.push(output);
        }
        return results;
    }
}
