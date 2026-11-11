// The page globals the perf payloads install (instrument.js,
// react-commits.js) and check.ts's own init scripts set, as check.ts's
// page.evaluate bodies read them.

interface PerfCounters {
  st: number;
  si: number;
  raf: number;
  stFired: number;
  siFired: number;
  rafFired: number;
  fetch: number;
  ws: number;
  xhr: number;
  longtasks: number;
  longtaskMs: number;
  maxLongtask: number;
  mut: number;
  mutOutside: number;
  fetchUrls: Record<string, number>;
  wsUrls: Record<string, number>;
  resetAt: number;
}

interface ReactCounters {
  commits: number;
  rendered: number;
  visited: number;
  maxRendered: number;
}

interface PerfMark {
  name: string;
  startTime: number;
}

interface Window {
  __perf: PerfCounters;
  __perfReset: () => void;
  __perfMutStart: (rootSel: string) => boolean;
  __perfMutStop: () => void;
  __perfMO?: MutationObserver;
  __react?: ReactCounters;
  __reactReset?: () => void;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: object;
  __realNow: () => number;
  __docStart: number;
  __marks: PerfMark[];
  __searchMs?: Promise<number>;
}
