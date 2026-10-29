/**
 * Frames arbitrary PCM chunks for a causal denoising model, compensates the
 * model's intrinsic look-ahead and flushes its tail. The model itself receives
 * real audio first (not prepended zeros). Output has exactly the input length.
 */
export class AlignedDenoiseStream {
  private pending = new Float32Array(0);
  private skip: number;
  private received = 0;
  private emitted = 0;
  private finished = false;

  constructor(
    private readonly hopSize: number,
    delaySamples: number,
    private readonly processFrame: (frame: Float32Array) => Promise<Float32Array>,
  ) {
    if (!Number.isInteger(hopSize) || hopSize <= 0 ||
        !Number.isInteger(delaySamples) || delaySamples < 0) {
      throw new Error("Invalid denoiser frame size or model delay");
    }
    this.skip = delaySamples;
    this.delaySamples = delaySamples;
  }

  private readonly delaySamples: number;

  /** Feed real samples; call sequentially and append the returned samples. */
  async push(input: Float32Array): Promise<Float32Array> {
    if (this.finished) throw new Error("Denoise stream is already finished");
    this.received += input.length;
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending);
    joined.set(input, this.pending.length);
    const full = Math.floor(joined.length / this.hopSize) * this.hopSize;
    this.pending = joined.slice(full);
    return this.process(joined.subarray(0, full), this.received);
  }

  /** Feed silence through the delay and return the rest, capped to input size. */
  async finish(): Promise<Float32Array> {
    if (this.finished) throw new Error("Denoise stream is already finished");
    this.finished = true;
    const length = Math.ceil((this.pending.length + this.delaySamples) / this.hopSize) * this.hopSize;
    const padded = new Float32Array(length);
    padded.set(this.pending);
    this.pending = new Float32Array(0);
    const tail = await this.process(padded, this.received);
    if (this.emitted !== this.received) {
      throw new Error(`Denoiser returned ${this.emitted} of ${this.received} samples`);
    }
    return tail;
  }

  private async process(input: Float32Array, outputLimit: number): Promise<Float32Array> {
    const maxOutput = Math.min(input.length, outputLimit - this.emitted);
    const output = new Float32Array(Math.max(0, maxOutput));
    let written = 0;
    for (let offset = 0; offset < input.length; offset += this.hopSize) {
      const frame = await this.processFrame(input.subarray(offset, offset + this.hopSize));
      if (frame.length !== this.hopSize) throw new Error("Denoiser returned an invalid frame size");
      const skip = Math.min(this.skip, frame.length);
      this.skip -= skip;
      const count = Math.min(frame.length - skip, output.length - written);
      if (count > 0) {
        output.set(frame.subarray(skip, skip + count), written);
        written += count;
      }
    }
    this.emitted += written;
    return written === output.length ? output : output.slice(0, written);
  }
}
