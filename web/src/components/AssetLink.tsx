// pattern: Imperative Shell
// Bare /assets/<sha256>/<filename> URLs autolinked by tokenize.ts's
// asset-link rule (pkm-gdi5). The assistant panel mentions assets this way
// ("here's the chart at /assets/<sha>/name.jpeg"); clicking should open the
// block that actually references the asset, not the raw file. Resolution
// goes through GET /api/search?exact=true: the FTS5 unicode61 tokenizer keeps
// a 64-hex sha as one token, so a block whose text contains the asset URL
// is an exact match on the sha. No referencing block (or a failed lookup,
// e.g. offline) falls back to opening the asset itself.
import { useContext } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api/typedClient";
import { SidebarContext } from "../contexts";
import { pagePath } from "../paths";

export function AssetLink({ url, sha, filename }: {
  url: string; sha: string; filename: string;
}) {
  const { openInSidebar } = useContext(SidebarContext);
  const navigate = useNavigate();

  const go = async (shiftKey: boolean) => {
    try {
      const result = await apiGet("/api/search", {
        query: { q: sha, exact: true },
      });
      const hit = result.blocks[0];
      if (hit) {
        if (shiftKey) openInSidebar(hit.page_title, hit.uid);
        else navigate(`${pagePath(hit.page_title)}#${hit.uid}`);
        return;
      }
    } catch {
      // fall through: open the raw asset below
    }
    window.open(url, "_blank", "noopener");
  };

  return (
    <a
      href={url}
      title={url}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void go(e.shiftKey);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void go(e.shiftKey);
        }
      }}
    >
      {filename}
    </a>
  );
}
