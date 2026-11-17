// pattern: Imperative Shell
import { useCallback, useContext, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { BacklinksSection } from "../components/BacklinksSection";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { PageTitle } from "../components/PageTitle";
import { UnlinkedSection } from "../components/UnlinkedSection";
import { BlockStampsContext } from "../contexts";
import { parseBlockUid } from "../ids";
import { titleFromPathname } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { substituteMissingDaily } from "../outline/missingPage";
import { useOutlinePageLoad } from "../outline/useOutlinePageLoad";
import { useRestoresHistoryScroll } from "../useHistoryScrollRestore";
import { useScrollFlashTarget } from "../useScrollFlashTarget";
import { wantsTemplateSeed } from "../templates/pageTemplates";
import { EditablePage } from "./EditablePage";

export function PageView() {
  const location = useLocation();
  const { pathname, search, hash, key } = location;
  const seedState: unknown = location.state;
  const navigate = useNavigate();
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

  // A block ref navigated here with the target uid as the hash:
  // once the payload has rendered, scroll to that block and flash it. A bare
  // "#", a malformed hash, or a uid not on the page is a no-op inside the
  // hook. A uid inside a collapsed subtree is revealed first: EditablePage
  // expands its hiding ancestors and reports when the rows have rendered,
  // which re-runs the hook. The location key makes a repeat click on the
  // same link jump again. Back or forward to an entry the reader scrolled
  // leaves the block alone: the offset they left it at is restored instead.
  const restoresScroll = useRestoresHistoryScroll();
  const target = hash.length > 1 && !restoresScroll ? parseBlockUid(hash.slice(1)) : null;
  const [revealed, setRevealed] = useState(0);
  const onRevealed = useCallback(() => setRevealed((n) => n + 1), []);
  useScrollFlashTarget(target, payload, { navigation: key, revealed });
  // Replacing the entry without its state is what stops a reload or a later
  // back/forward to it from seeding again.
  const dropSeedMarker = useCallback(() => {
    void navigate({ pathname, search, hash }, { replace: true });
  }, [navigate, pathname, search, hash]);

  if (error) return <p className="error">Could not load "{title}": {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefProvider seed={payload.block_ref_texts}>
      <article className="page">
        <PageTitle title={payload.page.title} />
        <EditablePage key={payload.page.title} title={payload.page.title}
                      initial={payload.blocks} stamps={stamps}
                      refCounts={payload.block_ref_counts}
                      reveal={target} revealNavigation={key}
                      onRevealed={onRevealed}
                      seedTemplate={wantsTemplateSeed(seedState)}
                      onSeedTemplateHandled={dropSeedMarker} />
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
