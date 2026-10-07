// pattern: Imperative Shell
// Upload a pasted/dropped/picked file and describe it as block markdown.
import { apiFetch } from "../api/client";
import type { Sha256Hex } from "../api/brands";
import type { components } from "../api/types";

// Generated from the server's AssetUploadResponse model; kept under the
// short AssetInfo name the callers already use.
export type AssetInfo = components["schemas"]["AssetUploadResponse"];

// Per-tab upload clock: every successful upload (fresh or dedup hit) stamps
// its sha, so a release can tell that these bytes were uploaded again after
// an undo and must be kept.
let clock = 0;
const lastUpload = new Map<Sha256Hex, number>();

export function uploadClock(): number {
  return clock;
}

export function uploadedSince(sha: Sha256Hex, since: number): boolean {
  return (lastUpload.get(sha) ?? 0) > since;
}

/** Stamp a sha as uploaded now. uploadAsset calls it; tests call it directly. */
export function recordUpload(sha: Sha256Hex): void {
  lastUpload.set(sha, ++clock);
}

/** Test seam: the clock is module state. */
export function resetUploadClock(): void {
  clock = 0;
  lastUpload.clear();
}

export async function uploadAsset(file: File): Promise<AssetInfo> {
  const form = new FormData();
  form.append("file", file);
  // no Content-Type header: the browser sets the multipart boundary
  const info = await apiFetch<AssetInfo>(
    "/api/assets", { method: "POST", body: form });
  recordUpload(info.sha256);
  return info;
}

export function assetMarkdown(info: AssetInfo): string {
  return info.mime.startsWith("image/")
    ? `![${info.filename}](${info.url})`
    : `[${info.filename}](${info.url})`;
}
