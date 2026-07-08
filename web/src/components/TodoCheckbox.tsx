// pattern: Functional Core
export function TodoCheckbox({ done }: { done: boolean }) {
  return (
    <input type="checkbox" className="todo-checkbox"
           checked={done} readOnly disabled />
  );
}
