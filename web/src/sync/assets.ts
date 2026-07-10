// pattern: Imperative Shell
// Upload a pasted/dropped/picked file and describe it as block markdown.
import { apiFetch } from "../api/client";
import type { components } from "../api/types";

// Generated from the server's AssetUploadResponse model; kept under the
// short AssetInfo name the callers already use.
export type AssetInfo = components["schemas"]["AssetUploadResponse"];

export function uploadAsset(file: File): Promise<AssetInfo> {
  const form = new FormData();
  form.append("file", file);
  // no Content-Type header: the browser sets the multipart boundary
  return apiFetch<AssetInfo>("/api/assets", { method: "POST", body: form });
}

export function assetMarkdown(info: AssetInfo): string {
  return info.mime.startsWith("image/")
    ? `![${info.filename}](${info.url})`
    : `[${info.filename}](${info.url})`;
}
