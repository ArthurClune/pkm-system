export function idOf(s: string): unknown {
  const v: unknown = JSON.parse(s);
  if (typeof v === "object" && v !== null && "id" in v) return v.id;
  return undefined;
}
