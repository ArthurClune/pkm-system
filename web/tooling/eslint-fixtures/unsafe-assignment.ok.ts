export function isNull(s: string): boolean {
  const v: unknown = JSON.parse(s);
  return v === null;
}
