// pattern: Functional Core
// How an uploaded file's name appears in block markdown.

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
