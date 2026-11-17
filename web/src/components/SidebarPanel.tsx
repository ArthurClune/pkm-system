// pattern: Imperative Shell
import type { BlockUid, RawTitle } from "../api/brands";
import { EditableSidebarPanel } from "./EditableSidebarPanel";
import { PageLink } from "./PageLink";

export function SidebarPanel({ title, uid, seedTemplate, onSeedTemplateHandled, onClose }: {
  title: RawTitle; uid?: BlockUid; seedTemplate?: boolean;
  onSeedTemplateHandled?: () => void; onClose: () => void;
}) {
  return (
    <section className="sidebar-panel" aria-label={`sidebar: ${title}`}>
      <header className="sidebar-panel-header">
        <h2 className="sidebar-panel-title"><PageLink title={title} tag={false} /></h2>
        <button className="panel-close" onClick={onClose} aria-label="close panel">
          ×
        </button>
      </header>
      <EditableSidebarPanel title={title} uid={uid} seedTemplate={seedTemplate}
                            onSeedTemplateHandled={onSeedTemplateHandled} />
    </section>
  );
}
