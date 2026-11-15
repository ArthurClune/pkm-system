// Re-export barrel, no runtime behaviour of its own (FCIS-exempt). Query
// results and plain tables share DataTable, the toolbar and the view state,
// so they load as one lazy chunk rather than two chunks and a shared third,
// which would add files to every install's precache.
export { PlainTable } from "./PlainTable";
export { QueryResults } from "./QueryResults";
