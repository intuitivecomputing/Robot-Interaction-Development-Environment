import fixWebmDuration from 'fix-webm-duration';

// Chrome's MediaRecorder writes a broken (often Infinity) duration into WebM blobs — patch it back in.
export async function finalizeRecordingBlob(
  chunks: BlobPart[],
  mimeType: string,
  durationMs: number
): Promise<Blob> {
  const rawBlob = new Blob(chunks, { type: mimeType });

  if (!mimeType.startsWith('audio/webm')) {
    return rawBlob;
  }

  try {
    return await fixWebmDuration(rawBlob, durationMs, { logger: false });
  } catch (e) {
    console.warn('Could not patch WebM duration header, sending as-is.', e);
    return rawBlob;
  }
}
