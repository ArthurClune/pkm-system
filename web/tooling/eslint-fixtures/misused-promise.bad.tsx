// Fixture: @typescript-eslint/no-misused-promises must flag the
// promise-returning function passed to a void-returning event handler slot.
async function save(): Promise<void> {}

export function SaveButton() {
  return <button onClick={save}>Save</button>;
}
