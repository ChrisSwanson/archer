export interface DownloadArtifact {
  readonly data: string;
  readonly mimeType: "image/svg+xml" | "image/png";
  readonly width: number;
  readonly height: number;
  readonly revision: string;
  readonly lastGood: boolean;
}
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
/** Transport validation only; rendering and provenance remain in the shared core. */
export function readArtifact(raw: unknown, format: "svg" | "png", revision: string): DownloadArtifact {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Archer returned an unreadable export.");
  const value = raw as Record<string, unknown>,
    mime = format === "svg" ? "image/svg+xml" : "image/png";
  if (
    value.encoding !== "base64" ||
    value.mimeType !== mime ||
    value.revision !== revision ||
    typeof value.lastGood !== "boolean" ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4 ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    Number(value.width) <= 0 ||
    Number(value.height) <= 0 ||
    Number(value.width) > 16000 ||
    Number(value.height) > 16000 ||
    Number(value.width) * Number(value.height) > 32000000
  )
    throw new Error("Archer returned an invalid or oversized export. Try a smaller scale.");
  try {
    const bytes = atob(value.data);
    if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("empty or too large");
  } catch {
    throw new Error("Archer returned unreadable export bytes.");
  }
  return value as unknown as DownloadArtifact;
}
export function saveArtifact(artifact: DownloadArtifact, filename: string): void {
  const binary = atob(artifact.data),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: artifact.mimeType })),
    link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revocation follows the download click in another task; never before it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
