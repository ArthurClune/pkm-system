export function idOf(s: string): unknown {
  return JSON.parse(s).id;
}
