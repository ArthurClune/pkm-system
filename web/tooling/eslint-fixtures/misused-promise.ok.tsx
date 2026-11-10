async function save(): Promise<void> {}
export function SaveButton() {
  return <button onClick={() => void save()}>Save</button>;
}
