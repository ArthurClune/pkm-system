// pattern: Imperative Shell
import { useCallback, useContext, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { BacklinksSection } from "../components/BacklinksSection";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { PageTitle } from "../components/PageTitle";
import { UnlinkedSection } from "../components/UnlinkedSection";
import { BlockStampsContext } from "../contexts";
import { titleFromPathname } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { substituteMissingDaily } from "../outline/missingPage";
import { useOutlinePageLoad } from "../outline/useOutlinePageLoad";
import { useScrollFlashTarget } from "../useScrollFlashTarget";
import { EditablePage } from "./EditablePage";

export function PageView() {
  const { pathname, hash } = useLocation();
  const title = titleFromPathname(pathname);
  const { payload, error, reload } =
    useOutlinePageLoad(title, substituteMissingDaily);
  const [linkedRefreshGeneration, setLinkedRefreshGeneration] = useState(0);
  const { stamps } = useContext(BlockStampsContext);

  const onLinked = useCallback(() => {
    setLinkedRefreshGeneration((generation) => generation + 1);
  }, []);
  const resync = useCallback(() => reload("resync"), [reload]);
  useResync(resync); // rejected batch or reconnect: guarded authoritative read
  useEffect(() => { document.title = `${title} — pkm`; }, [title]);

  // A block ref navigated here with the target uid as the hash (pkm-pzdu):
  // once the payload has rendered, scroll to that block and flash it. A bare
  // "#" carries no target; a uid not on the page (deleted, or inside a
  // collapsed subtree) is a no-op inside the hook.
  useScrollFlashTarget(hash.length > 1 ? hash.slice(1) : null, payload);

  if (error) return <p className="error">Could not load "{title}": {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefProvider seed={payload.block_ref_texts}>
      <article className="page">
        <PageTitle title={payload.page.title} />
        <EditablePage key={payload.page.title} title={payload.page.title}
                      initial={payload.blocks} composer stamps={stamps}
                      refCounts={payload.block_ref_counts} />
      </article>
      <BacklinksSection
        key={`bl-${title}`}
        title={payload.page.title}
        initial={payload.backlinks}
        refreshGeneration={linkedRefreshGeneration}
      />
      <UnlinkedSection
        key={`ul-${title}`}
        title={payload.page.title}
        onLinked={onLinked}
      />
    </BlockRefProvider>
  );
}
