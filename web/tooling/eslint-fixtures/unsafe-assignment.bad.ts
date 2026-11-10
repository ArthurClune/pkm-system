export function isNull(s: string): boolean {
  const v = JSON.parse(s);
  return v === null;
}
