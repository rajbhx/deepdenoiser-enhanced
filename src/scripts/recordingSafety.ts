import * as fs from "expo-file-system";
import { AudioStudioModule } from "@siteed/audio-studio";

/** Fail closed before inspecting or modifying a recording after an uncertain Stop. */
export function assertNativeRecorderIdle(): void {
  let status: { isRecording?: boolean; isPaused?: boolean; isWriterActive?: boolean };
  try { status = AudioStudioModule.status(); }
  catch { throw new Error("Cannot confirm the recorder has stopped. Force-stop and reopen the app before recovery."); }
  if (!status || typeof status.isWriterActive !== "boolean") {
    throw new Error("Cannot confirm the recorder has stopped. Force-stop and reopen the app before recovery.");
  }
  if (status.isRecording || status.isPaused || status.isWriterActive) {
    throw new Error("Wait until the recorder has stopped before accessing private files.");
  }
}

export type RecordingQueueIssue = "overloaded" | "error";
export interface RecordingQueueSnapshot {
  /** Includes the in-flight chunk; this is not end-to-end microphone latency. */
  pendingChunks: number;
  pendingSamples: number;
  overloaded: boolean;
  hasError: boolean;
}

/** Bounded, ordered live work. After overload, native recording remains the source of truth. */
export class BoundedRecordingQueue {
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;
  private samples = 0;
  public overloaded = false;
  public error: Error | null = null;

  constructor(
    private readonly maxChunks: number,
    private readonly maxSamples: number,
    private readonly consume: (samples: Float32Array) => Promise<void>,
    private readonly onIssue?: (issue: RecordingQueueIssue) => void,
  ) {}

  /** Read-only approximate backlog for the interface, including in-flight work. */
  snapshot(): RecordingQueueSnapshot {
    return { pendingChunks: this.depth, pendingSamples: this.samples, overloaded: this.overloaded, hasError: !!this.error };
  }

  /** Report an asynchronous or stream-format failure without changing the fallback path. */
  fail(error: unknown): void {
    if (this.error) return;
    this.error = error instanceof Error ? error : new Error(String(error));
    this.notify("error");
  }

  private notify(issue: RecordingQueueIssue): void {
    try { this.onIssue?.(issue); }
    catch (error) { console.warn("Recording status observer failed:", error); }
  }

  enqueue(input: Float32Array): boolean {
    if (this.overloaded || this.error) return false;
    if (this.depth >= this.maxChunks || this.samples + input.length > this.maxSamples) {
      // Stop accepting permanently: the accepted samples must be a prefix.
      this.overloaded = true;
      this.notify("overloaded");
      return false;
    }
    const copy = new Float32Array(input);
    this.depth++;
    this.samples += copy.length;
    this.chain = this.chain.then(async () => {
      if (this.error) return;
      try { await this.consume(copy); }
      catch (error) { this.fail(error); }
    }).finally(() => {
      this.depth--;
      this.samples -= copy.length;
    });
    return true;
  }

  async drain(): Promise<void> {
    let chain = this.chain;
    while (true) {
      await chain;
      if (chain === this.chain) return;
      chain = this.chain;
    }
  }
}

/** Recordings are written durably here from the first sample, even before Stop. */
export function recordingsDir(): fs.Directory {
  const dir = new fs.Directory(fs.Paths.document, "recordings");
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
}

function tag(bytes: Uint8Array, start: number, value: string): boolean {
  return [...value].every((letter, i) => bytes[start + i] === letter.charCodeAt(0));
}

/**
 * Verify the recorder's fixed 44-byte mono PCM16 WAV header. After an app
 * interruption the data is still there but the final size fields can be zero;
 * repair just those fields in place, leaving the actual samples untouched.
 * Call only when the recorder is no longer writing this file.
 */
export function ensureRecordingWavHeader(file: fs.File): number {
  if (!file.exists || file.size < 44) throw new Error("Recording has no WAV header");
  const dataBytes = file.size - 44;
  if (dataBytes % 2 || dataBytes > 0xffffffff - 36) throw new Error("Recording has an invalid or unsupported PCM length");
  const handle = file.open();
  try {
    const header = handle.readBytes(44);
    if (header.length !== 44 || !tag(header, 0, "RIFF") || !tag(header, 8, "WAVE") ||
        !tag(header, 12, "fmt ") || !tag(header, 36, "data")) {
      throw new Error("Recording has an unrecognized WAV header");
    }
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 ||
        view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 48000 ||
        view.getUint16(34, true) !== 16) {
      throw new Error("Recording is not 48 kHz mono PCM16");
    }
    if (view.getUint32(4, true) !== dataBytes + 36 || view.getUint32(40, true) !== dataBytes) {
      view.setUint32(4, dataBytes + 36, true);
      view.setUint32(40, dataBytes, true);
      handle.offset = 0;
      handle.writeBytes(header);
    }
    return dataBytes;
  } finally { handle.close(); }
}

/**
 * Verify every streamed byte against the complete native WAV, then supply any
 * missing final samples. A mismatch returns false without committing a tail;
 * callers must reprocess the authoritative WAV instead of publishing a partial
 * or out-of-order cleaned recording.
 */
export async function reconcileRecording(
  nativeWav: fs.File,
  streamedPcm: fs.File,
  onTail: (samples: Float32Array) => Promise<void>,
): Promise<boolean> {
  const totalBytes = ensureRecordingWavHeader(nativeWav);
  if (!streamedPcm.exists || streamedPcm.size % 2 || streamedPcm.size > totalBytes) return false;
  const wav = nativeWav.open();
  const stream = streamedPcm.open();
  const block = 128 * 1024;
  try {
    wav.offset = 44;
    let compared = 0;
    while (compared < streamedPcm.size) {
      const length = Math.min(block, streamedPcm.size - compared);
      const expected = wav.readBytes(length);
      const actual = stream.readBytes(length);
      if (expected.length !== length || actual.length !== length) throw new Error("Could not read recording samples");
      for (let i = 0; i < length; i++) if (expected[i] !== actual[i]) return false;
      compared += length;
      // Keep the interface responsive for long recordings.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    let remaining = totalBytes - compared;
    while (remaining > 0) {
      const length = Math.min(block, remaining);
      const bytes = wav.readBytes(length);
      if (bytes.length !== length) throw new Error("Recording ended before its expected length");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const samples = new Float32Array(length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      await onTail(samples);
      remaining -= length;
    }
    return true;
  } finally { stream.close(); wav.close(); }
}
