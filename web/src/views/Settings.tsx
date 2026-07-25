// pattern: Imperative Shell
import { useEffect } from "react";

interface SettingsSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

// A plain list of sections, not one hand-built layout, so the next setting
// (pkm-7myl says "we'll be adding a few more soon") is a new entry here
// rather than a rewrite of the page.
const SECTIONS: SettingsSection[] = [
  {
    id: "export",
    title: "Export",
    body: (
      <>
        <p>
          {/* Moved from the Help page (pkm-uvqf shipped it there; pkm-7myl
              gives whole-db export its own home now that Settings exists).
              Plain download navigation -- the session cookie carries auth. */}
          <a className="settings-export-link" href="/api/export.zip" download>
            Export whole database as Markdown (.zip)
          </a>
        </p>
        <p className="settings-note">
          {/* The zip bundles every uploaded asset alongside the markdown and
              is built server-side before the download starts, so nothing
              appears to happen for a while on large databases. */}
          The export includes all uploaded files, so for large databases it
          can take a minute or more to start downloading.
        </p>
      </>
    ),
  },
];

export function Settings() {
  useEffect(() => { document.title = "Settings — pkm"; }, []);

  return (
    <article className="settings-page">
      <h1 className="page-title">Settings</h1>
      {SECTIONS.map((section) => (
        <section key={section.id} className="settings-section" aria-label={section.title}>
          <h2>{section.title}</h2>
          {section.body}
        </section>
      ))}
    </article>
  );
}
