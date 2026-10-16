export function run(s: string): unknown {
  return JSON.parse(s)();
}
