export function load(s: string): string[] {
  const v: unknown = JSON.parse(s);
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
