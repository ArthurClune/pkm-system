// pattern: Functional Core
export function TodoCheckbox({ done }: { done: boolean }) {
  return (
    <input type="checkbox" className="todo-checkbox"
           aria-label={done ? "DONE" : "TODO"}
           checked={done} readOnly disabled />
  );
}
