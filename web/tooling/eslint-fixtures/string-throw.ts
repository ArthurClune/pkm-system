// Fixture: @typescript-eslint/only-throw-error must flag throwing a string
// rather than an Error.
export function boom(): void {
  throw "boom";
}
