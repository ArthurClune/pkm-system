// pattern: Imperative Shell
// The bar above a table or query result: the filter box, the row count, and
// the saved view's state. Reset and Save appear only while the view differs
// from what is saved.
import { island } from "./island";

export function TableToolbar({ filter, onFilter, count, dirty, saved, canSave,
                               refusal, onReset, onSave, onEditAsText }: {
  filter: string;
  onFilter: (text: string) => void;
  count: string;
  dirty: boolean;
  saved: boolean;
  canSave: boolean;
  /** Why this view cannot be saved; shown in Save's place. */
  refusal: string | null;
  onReset: () => void;
  onSave: () => void;
  onEditAsText?: () => void;
}) {
  return (
    <div className="table-toolbar" {...island}>
      <input type="search" className="input-control table-filter"
             aria-label="Filter" placeholder="Filter" value={filter}
             onChange={(e) => onFilter(e.target.value)} />
      <span className="table-count">{count}</span>
      {saved && !dirty && <span className="table-saved">✓ saved view</span>}
      {dirty && (
        <>
          <button type="button" className="btn-secondary btn-compact"
                  onClick={onReset}>Reset</button>
          {refusal !== null
            ? <span className="table-refusal">{refusal}</span>
            : <button type="button" className="btn-secondary btn-compact"
                      disabled={!canSave} onClick={onSave}>Save this view</button>}
        </>
      )}
      {onEditAsText && (
        <button type="button" className="btn-secondary btn-compact table-edit-text"
                onClick={onEditAsText}>Edit as text</button>
      )}
    </div>
  );
}
