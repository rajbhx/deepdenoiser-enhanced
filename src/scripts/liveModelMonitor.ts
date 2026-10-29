/**
 * Read-only, bounded observation of the recording stream.
 *
 * The recording's AlignedDenoiseStream already compensates the model delay.
 * Input and output samples below use that stream's sample index, not wall-clock
 * arrival time. The plots represent the live accepted prefix and are NOT proof
 * that the final native WAV or its reconciliation succeeded.
 *
 * Nothing here writes to audio buffers or files. Analysis is deliberately
 * sampled and scheduled outside the recording promise chain. If it cannot
 * keep up, chart columns are omitted; recording/model work has priority.
 */
export const LIVE_SAMPLE_RATE = 48_000;
export const LIVE_FFT_SIZE = 1024;
export const LIVE_PERIOD_SAMPLES = 6000; // At most eight chart columns per second.
export const LIVE_BANDS = 16;
export const LIVE_COLUMNS = 32;
export const LIVE_MIN_HZ = 90;
export const LIVE_MAX_HZ = 12_000;
const RING_SAMPLES = LIVE_SAMPLE_RATE * 5;
const MIN_DB = -80;
const MAX_DB = 0;

export interface SpectrumColumn {
  /** Audio sample index / LIVE_PERIOD_SAMPLES, not a clock timestamp. */
  index: number;
  input: number[];
  output: number[];
  /** -3..-1 quieter, 0 little measured change, 1..3 louder; not a noise label. */
  change: number[];
}

export interface LiveModelSnapshot {
  modelFrames: number;
  latestIndex: number;
  columns: SpectrumColumn[];
  visualizationAvailable: boolean;
}

/** A sample-indexed ring that can detect missing data rather than invent it. */
class IndexedRing {
  private readonly data = new Float32Array(RING_SAMPLES);
  private start = 0;
  private end = 0;
  private populated = false;

  clear(): void { this.populated = false; }

  write(start: number, samples: Float32Array): void {
    if (!samples.length) return;
    if (!this.populated || start !== this.end) {
      this.start = start;
      this.end = start;
      this.populated = true;
    }
    const first = Math.max(0, samples.length - this.data.length);
    for (let i = first; i < samples.length; i++) this.data[(start + i) % this.data.length] = samples[i];
    this.end = start + samples.length;
    this.start = Math.max(this.start, this.end - this.data.length);
  }

  copyEndingAt(end: number, length: number): Float32Array | null {
    const start = end - length;
    if (!this.populated || start < this.start || end > this.end) return null;
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) output[i] = this.data[(start + i) % this.data.length];
    return output;
  }
}

const hann = Float64Array.from({ length: LIVE_FFT_SIZE }, (_, i) =>
  0.5 - 0.5 * Math.cos(2 * Math.PI * i / (LIVE_FFT_SIZE - 1)));
const windowSum = hann.reduce((sum, value) => sum + value, 0);
const amplitudeFactor = 2 / windowSum;
const bandRanges = Array.from({ length: LIVE_BANDS }, (_, index) => {
  const ratio = LIVE_MAX_HZ / LIVE_MIN_HZ;
  const low = LIVE_MIN_HZ * Math.pow(ratio, index / LIVE_BANDS);
  const high = LIVE_MIN_HZ * Math.pow(ratio, (index + 1) / LIVE_BANDS);
  const first = Math.max(1, Math.floor(low * LIVE_FFT_SIZE / LIVE_SAMPLE_RATE));
  const last = Math.min(LIVE_FFT_SIZE / 2, Math.max(first + 1, Math.ceil(high * LIVE_FFT_SIZE / LIVE_SAMPLE_RATE)));
  return { first, last };
});

/** Magnitudes for a display FFT. This is not the model's own internal mask. */
export function analyzeSpectrum(samples: Float32Array): number[] {
  if (samples.length !== LIVE_FFT_SIZE) throw new Error("Spectrum window must contain exactly 1024 samples");
  const real = new Float64Array(LIVE_FFT_SIZE);
  const imag = new Float64Array(LIVE_FFT_SIZE);
  // Iterative radix-2 FFT with bit-reversal permutation.
  let reversed = 0;
  for (let i = 0; i < LIVE_FFT_SIZE; i++) {
    const sample = Number.isFinite(samples[i]) ? samples[i] : 0;
    real[reversed] = sample * hann[i];
    let bit = LIVE_FFT_SIZE >> 1;
    while (reversed & bit) { reversed ^= bit; bit >>= 1; }
    reversed ^= bit;
  }
  for (let width = 2; width <= LIVE_FFT_SIZE; width *= 2) {
    const angle = -2 * Math.PI / width;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let base = 0; base < LIVE_FFT_SIZE; base += width) {
      let wr = 1, wi = 0;
      for (let j = 0; j < width / 2; j++) {
        const a = base + j;
        const b = a + width / 2;
        const tr = wr * real[b] - wi * imag[b];
        const ti = wr * imag[b] + wi * real[b];
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
        const nextWr = wr * stepReal - wi * stepImag;
        wi = wr * stepImag + wi * stepReal;
        wr = nextWr;
      }
    }
  }
  return bandRanges.map(({ first, last }) => {
    let peakPower = 0;
    for (let bin = first; bin < last; bin++) {
      peakPower = Math.max(peakPower, real[bin] * real[bin] + imag[bin] * imag[bin]);
    }
    const db = 10 * Math.log10(Math.max(peakPower * amplitudeFactor * amplitudeFactor, 1e-12));
    return Math.max(MIN_DB, Math.min(MAX_DB, db));
  });
}

export function compareSpectra(input: Float32Array, output: Float32Array, index: number): SpectrumColumn {
  const before = analyzeSpectrum(input);
  const after = analyzeSpectrum(output);
  const quantize = (db: number) => Math.max(0, Math.min(5, Math.floor((db - MIN_DB) / (MAX_DB - MIN_DB) * 6)));
  return {
    index,
    input: before.map(quantize),
    output: after.map(quantize),
    change: before.map((value, i) => {
      const delta = after[i] - value;
      if (Math.abs(delta) < 3) return 0;
      return Math.sign(delta) * Math.min(3, Math.ceil(Math.abs(delta) / 10));
    }),
  };
}

export class LiveModelMonitor {
  private readonly input = new IndexedRing();
  private readonly output = new IndexedRing();
  private inputSamples = 0;
  private outputSamples = 0;
  private frames = 0;
  private lastAttempt = 0;
  private latestIndex = 0;
  private columns: SpectrumColumn[] = [];
  private enabled = true;
  private disposed = false;
  private failed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  /** Count successful logical model frames, not ONNX internal executions. */
  noteModelFrame(): void { if (!this.disposed) this.frames++; }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.input.clear();
    this.output.clear();
    this.columns = [];
    this.lastAttempt = Math.floor(this.outputSamples / LIVE_PERIOD_SAMPLES);
    this.latestIndex = this.lastAttempt;
  }

  /**
   * Observe one successfully written accepted chunk and its aligned output.
   * `allowAnalysis` can be false when the recording queue is busy. Missing
   * display columns remain blank and cannot affect the actual stream.
   */
  observe(original: Float32Array, cleaned: Float32Array, allowAnalysis: boolean): void {
    if (this.disposed) return;
    const inputStart = this.inputSamples;
    const outputStart = this.outputSamples;
    this.inputSamples += original.length;
    this.outputSamples += cleaned.length;
    if (!this.enabled || this.failed) return;
    try {
      const index = Math.floor(this.outputSamples / LIVE_PERIOD_SAMPLES);
      this.latestIndex = index;
      this.columns = this.columns.filter(column => column.index > index - LIVE_COLUMNS);
      if (!allowAnalysis) {
        // Stop copying visual samples too; resume only when a fresh matched window exists.
        this.input.clear();
        this.output.clear();
        this.lastAttempt = index;
        this.generation++;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        return;
      }
      this.input.write(inputStart, original);
      this.output.write(outputStart, cleaned);
      if (!index || index <= this.lastAttempt) return;
      this.lastAttempt = index;
      if (this.timer !== null) return;
      const end = index * LIVE_PERIOD_SAMPLES;
      const before = this.input.copyEndingAt(end, LIVE_FFT_SIZE);
      const after = this.output.copyEndingAt(end, LIVE_FFT_SIZE);
      if (!before || !after) return; // Never compare mismatched or missing samples.
      const generation = this.generation;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.disposed || !this.enabled || this.generation !== generation) return;
        try {
          const column = compareSpectra(before, after, index);
          // A newer observed index can make a delayed column fall outside the view.
          if (index > this.latestIndex - LIVE_COLUMNS) this.columns.push(column);
        } catch (error) { this.fail(error); }
      }, 0);
    } catch (error) { this.fail(error); }
  }

  snapshot(): LiveModelSnapshot {
    return { modelFrames: this.frames, latestIndex: this.latestIndex, columns: this.columns.slice(), visualizationAvailable: !this.failed };
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.input.clear();
    this.output.clear();
    this.columns = [];
  }

  private fail(error: unknown): void {
    this.failed = true;
    this.columns = [];
    console.warn("Live visualization unavailable; recording continues:", error);
  }
}
