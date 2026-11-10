export function run(s: string): unknown {
  const v: unknown = JSON.parse(s);
  return typeof v === "function" ? v.name : undefined;
}
