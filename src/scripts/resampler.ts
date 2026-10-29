/**
 * Chunk-independent, streaming PCM resampler.
 *
 * Unlike re-starting linear interpolation for each read, output sample
 * positions and the previous sample are carried across boundaries. When
 * downsampling, two Butterworth low-pass sections reject frequencies above
 * the destination Nyquist limit before interpolation. The caller keeps one
 * instance per file and calls finish() exactly once at EOF.
 */
class LowPass {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;

  constructor(sampleRate: number, cutoff: number) {
    const omega = 2 * Math.PI * cutoff / sampleRate;
    const cosine = Math.cos(omega);
    const alpha = Math.sin(omega) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 - cosine) / (2 * a0);
    this.b1 = (1 - cosine) / a0;
    this.b2 = this.b0;
    this.a1 = -2 * cosine / a0;
    this.a2 = (1 - alpha) / a0;
  }

  sample(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export class StreamingResampler {
  private readonly ratio: number;
  private readonly filters: LowPass[];
  private inputCount = 0;
  private outputCount = 0;
  private previous = 0;
  private ended = false;

  constructor(private readonly inputRate: number, private readonly outputRate: number) {
    if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate <= 0 || outputRate <= 0) {
      throw new Error("Sample rates must be finite positive numbers.");
    }
    this.ratio = inputRate / outputRate;
    this.filters = inputRate > outputRate
      ? [new LowPass(inputRate, outputRate * 0.46), new LowPass(inputRate, outputRate * 0.46)]
      : [];
  }

  push(input: Int16Array | Float32Array): Float32Array {
    if (this.ended) throw new Error("Resampler is already finished.");
    if (input.length === 0) return new Float32Array(0);
    const values = new Float32Array(input.length);
    const isInt16 = input instanceof Int16Array;
    for (let i = 0; i < input.length; i++) {
      let value = isInt16 ? input[i] / 32768 : input[i];
      for (const filter of this.filters) value = filter.sample(value);
      values[i] = value;
    }

    const start = this.inputCount;
    const end = start + values.length - 1;
    const initialPos = this.outputCount * this.ratio;
    const capacity = Math.max(0, Math.ceil((end - initialPos) / this.ratio) + 1);
    const output = new Float32Array(capacity);
    let written = 0;
    while (true) {
      const pos = this.outputCount * this.ratio;
      // A sample after pos must be available. The final sample is retained for
      // the next chunk (or filled by finish() at EOF).
      if (pos >= end) break;
      const left = Math.floor(pos);
      const fraction = pos - left;
      const a = left === start - 1 ? this.previous : values[left - start];
      const b = values[left + 1 - start];
      output[written++] = a + (b - a) * fraction;
      this.outputCount++;
    }
    this.inputCount += values.length;
    this.previous = values[values.length - 1];
    return output.subarray(0, written);
  }

  finish(): Float32Array {
    if (this.ended) return new Float32Array(0);
    this.ended = true;
    if (this.inputCount === 0) return new Float32Array(0);
    const targetCount = Math.ceil(this.inputCount * this.outputRate / this.inputRate - 1e-12);
    const remaining = Math.max(0, targetCount - this.outputCount);
    const tail = new Float32Array(remaining);
    tail.fill(this.previous);
    this.outputCount += remaining;
    return tail;
  }
}
