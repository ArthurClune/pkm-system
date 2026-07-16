// Fixture: @typescript-eslint/no-floating-promises must flag the un-awaited,
// un-voided promise.
async function persist(): Promise<void> {}

export function run(): void {
  persist();
}
