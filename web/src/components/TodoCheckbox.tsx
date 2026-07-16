// pattern: Imperative Shell
// Reads BlockEditContext to decide whether the checkbox is interactive --
// runtime React context, not a pure rendering decision.
import { useContext } from "react";
import { BlockEditContext } from "../contexts";

/** Clickable where an edit context exists (the editable outline); read-only
 * everywhere else (backlinks, query results, sidebar panels). */
export function TodoCheckbox({ done }: { done: boolean }) {
  const edit = useContext(BlockEditContext);
  return (
    <input type="checkbox" className="todo-checkbox"
           aria-label={done ? "DONE" : "TODO"}
           checked={done} disabled={edit === null}
           onChange={() => edit?.toggleTodo()} />
  );
}
