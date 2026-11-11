function take(n: number): number {
  return n;
}
export function run(s: string): number {
  return take(JSON.parse(s));
}
