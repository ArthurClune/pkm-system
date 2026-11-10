// pattern: Imperative Shell

/** Writes `text` to the clipboard. False when the Clipboard API is missing
 * (an insecure origin) or the write is refused, so a caller can show the text
 * to select by hand. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
