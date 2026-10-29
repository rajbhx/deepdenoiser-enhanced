/**
 * Frames arbitrary PCM chunks for a causal denoising model, compensates the
 * model's intrinsic look-ahead and flushes its tail. The model itself receives
 * real audio first (not prepended zeros). Output has exactly the input length.
 *
 * Each stream owns a single pending frame and output scratch buffer. Full
 * frames are read directly from the caller's chunk instead of copying a whole
 * multi-second chunk on every push. Callers must not mutate input until the
 * returned promise resolves, and must call push/finish sequentially.
 */
export class AlignedDenoiseStream {
  private readonly pending: Float32Array;
  private pendingLength = 0;
  private readonly frameOutput: Float32Array;
  private skip: number;
  private received = 0;
  private emitted = 0;
  private finished = false;
  private readonly delaySamples: number;

  constructor(
    private readonly hopSize: number,
    delaySamples: number,
    private readonly processFrame: (frame: Float32Array, output: Float32Array) => Promise<Float32Array>,
  ) {
    if (!Number.isInteger(hopSize) || hopSize <= 0 ||
        !Number.isInteger(delaySamples) || delaySamples < 0) {
      throw new Error("Invalid denoiser frame size or model delay");
    }
    this.pending = new Float32Array(hopSize);
    this.frameOutput = new Float32Array(hopSize);
    this.skip = delaySamples;
    this.delaySamples = delaySamples;
  }

  /** Feed real samples; call sequentially and append the returned samples. */
  async push(input: Float32Array): Promise<Float32Array> {
    if (this.finished) throw new Error("Denoise stream is already finished");
    this.received += input.length;
    const full = Math.floor((this.pendingLength + input.length) / this.hopSize) * this.hopSize;
    const output = this.makeOutput(full);
    let offset = 0;
    let written = 0;

    if (this.pendingLength) {
      const count = Math.min(this.hopSize - this.pendingLength, input.length);
      this.pending.set(input.subarray(0, count), this.pendingLength);
      this.pendingLength += count;
      offset += count;
      if (this.pendingLength === this.hopSize) {
        written = await this.processOne(this.pending, output, written);
        this.pendingLength = 0;
      }
    }
    while (offset + this.hopSize <= input.length) {
      written = await this.processOne(input.subarray(offset, offset + this.hopSize), output, written);
      offset += this.hopSize;
    }
    if (offset < input.length) {
      this.pendingLength = input.length - offset;
      this.pending.set(input.subarray(offset), 0);
    }
    this.emitted += written;
    if (written !== output.length) throw new Error("Denoiser produced an unexpected number of samples");
    return output;
  }

  /** Feed silence through the delay and return the rest, capped to input size. */
  async finish(): Promise<Float32Array> {
    if (this.finished) throw new Error("Denoise stream is already finished");
    this.finished = true;
    const length = Math.ceil((this.pendingLength + this.delaySamples) / this.hopSize) * this.hopSize;
    const output = this.makeOutput(length);
    let written = 0;
    for (let offset = 0; offset < length; offset += this.hopSize) {
      // The first frame contains the unconsumed real samples; the rest is zero.
      this.pending.fill(0, offset === 0 ? this.pendingLength : 0);
      written = await this.processOne(this.pending, output, written);
    }
    this.pendingLength = 0;
    this.emitted += written;
    if (written !== output.length || this.emitted !== this.received) {
      throw new Error(`Denoiser returned ${this.emitted} of ${this.received} samples`);
    }
    return output;
  }

  private makeOutput(full: number): Float32Array {
    // Account for delay before allocating, avoiding a later trimmed copy.
    const available = Math.max(0, full - this.skip);
    return new Float32Array(Math.min(available, this.received - this.emitted));
  }

  private async processOne(input: Float32Array, output: Float32Array, written: number): Promise<number> {
    const frame = await this.processFrame(input, this.frameOutput);
    if (frame.length !== this.hopSize) throw new Error("Denoiser returned an invalid frame size");
    const skip = Math.min(this.skip, frame.length);
    this.skip -= skip;
    const count = Math.min(frame.length - skip, output.length - written);
    if (count > 0) {
      output.set(frame.subarray(skip, skip + count), written);
      written += count;
    }
    return written;
  }
}
