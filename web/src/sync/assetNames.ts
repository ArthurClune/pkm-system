// pattern: Functional Core
// How an uploaded file's name appears in block markdown.
import type { components } from "../api/types";

/** A file name as markdown link text: "[" and "]" become "(" and ")" so the
 * label can never open "[[" or close early. Display only; the stored and
 * downloaded name is untouched. Twin of assets_core.asset_label. */
export function assetLabel(filename: string): string {
  return filename.replace(/\[/g, "(").replace(/\]/g, ")");
}

/** The file name a bare /assets/<sha>/<segment> URL shows: the segment
 * decoded, or as written when it is not valid percent-encoding (a legacy
 * name holding a stray "%"). */
export function assetNameFromSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The markdown an upload inserts: an image embed for images, a plain link
 * otherwise. */
export function assetMarkdown(
  info: Pick<components["schemas"]["AssetUploadResponse"], "filename" | "mime" | "url">,
): string {
  const bang = info.mime.startsWith("image/") ? "!" : "";
  return `${bang}[${assetLabel(info.filename)}](${info.url})`;
}
