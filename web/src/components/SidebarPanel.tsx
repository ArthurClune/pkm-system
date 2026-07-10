// pattern: Imperative Shell
import { EditableSidebarPanel } from "./EditableSidebarPanel";
import { PageLink } from "./PageLink";

export function SidebarPanel({ title, onClose }:
    { title: string; onClose: () => void }) {
  return (
    <section className="sidebar-panel" aria-label={`sidebar: ${title}`}>
      <header className="sidebar-panel-header">
        <h2 className="sidebar-panel-title"><PageLink title={title} tag={false} /></h2>
        <button className="panel-close" onClick={onClose} aria-label="close panel">
          ×
        </button>
      </header>
      <EditableSidebarPanel title={title} />
    </section>
  );
}
