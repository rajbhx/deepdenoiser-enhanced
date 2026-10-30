import { copyFileWithSha256, fingerprintFile, linkPrivateFileNoReplace } from "@/modules/AudioProcessorModule";
import * as fs from "expo-file-system";
import { outputDir, reservePrivateTemp } from "./denoiseCache";
import { ensureRecordingWavHeader, inspectRecordingWavHeader } from "./recordingSafety";

/**
 * Copy and verify an interrupted WAV, then fix only the new file's two length
 * fields. This cannot reconstruct missing samples; the caller must warn first.
 * The original is read-only throughout, and failed repairs leave it untouched.
 */
export async function repairRecordingCopy(original: fs.File, assertSafe: () => void): Promise<fs.File> {
  assertSafe();
  const inspection = inspectRecordingWavHeader(original);
  if (!inspection.needsRepair) throw new Error("The recording header does not need repair.");
  const size = original.size;
  const before = await fingerprintFile(original.uri);
  if (before.bytes !== size || !/^[a-f0-9]{64}$/i.test(before.sha256)) {
    throw new Error("The original could not be verified. It was not changed.");
  }
  assertSafe();
  const dir = outputDir();
  const pending = reservePrivateTemp(dir, "_pending_repair_");
  try {
    const copied = await copyFileWithSha256(original.uri, pending.uri);
    const [copyFingerprint, after] = await Promise.all([fingerprintFile(pending.uri), fingerprintFile(original.uri)]);
    const hash = before.sha256.toLowerCase();
    if (copied.toLowerCase() !== hash || copyFingerprint.bytes !== size || copyFingerprint.sha256.toLowerCase() !== hash ||
        after.bytes !== size || after.sha256.toLowerCase() !== hash || original.size !== size) {
      throw new Error("The recording changed or its copy could not be verified. The original was not changed.");
    }
    assertSafe();
    const copyInspection = inspectRecordingWavHeader(pending);
    if (!copyInspection.needsRepair || copyInspection.dataBytes !== inspection.dataBytes ||
        copyInspection.declaredDataBytes !== inspection.declaredDataBytes ||
        copyInspection.declaredRiffBytes !== inspection.declaredRiffBytes) {
      throw new Error("The copied recording changed before repair. The original was not changed.");
    }
    const handle = pending.open();
    try {
      const header = handle.readBytes(44);
      if (header.length !== 44) throw new Error("Could not read the copied WAV header.");
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      view.setUint32(4, inspection.dataBytes + 36, true);
      view.setUint32(40, inspection.dataBytes, true);
      handle.offset = 0;
      handle.writeBytes(header);
    } finally { handle.close(); }
    ensureRecordingWavHeader(pending);
    assertSafe();
    for (let attempt = 0; attempt < 32; attempt++) {
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}_${attempt}`;
      const dest = new fs.File(dir, `recovered_${suffix}_original.wav`);
      if (await linkPrivateFileNoReplace(pending.uri, dest.uri)) return dest;
    }
    throw new Error("Could not save a separate repaired copy. The original was not changed.");
  } finally {
    if (pending.exists) {
      try { pending.delete(); } catch { /* best effort; never remove the original */ }
    }
  }
}
