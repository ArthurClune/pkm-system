// pattern: Functional Core
// A page title's namespace is the tree it lives in: the segment before its
// first "/". [[AWS/EC2]] and [[AWS/Lambda]] share "aws". PageLink stamps it
// as data-ns so styles.css can colour whole trees (pkm-r71a); which trees get
// a colour is decided in the stylesheet, not here.

export function pageNamespace(title: string): string | undefined {
  const slash = title.indexOf("/");
  if (slash <= 0) return undefined;
  const prefix = title.slice(0, slash).trim().toLowerCase();
  return prefix === "" ? undefined : prefix;
}
