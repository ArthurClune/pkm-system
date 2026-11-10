function take(n: number): number {
  return n;
}
export function run(s: string): number {
  const v: unknown = JSON.parse(s);
  return typeof v === "number" ? take(v) : 0;
}
