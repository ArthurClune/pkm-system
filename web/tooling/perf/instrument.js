// addInitScript payload: counts timers / fetch / WebSocket / XHR / longtasks
// into window.__perf. Installed before app code so it sees every call.
(() => {
  const w = window;
  /** @typedef {"fetchUrls" | "wsUrls" | "resetAt"} NotACounter */
  /** @type {Exclude<keyof PerfCounters, NotACounter>[]} */
  const KEYS = ["st", "si", "raf", "stFired", "siFired", "rafFired",
                "fetch", "ws", "xhr", "longtasks", "longtaskMs", "maxLongtask",
                "mut", "mutOutside"];
  /** @type {PerfCounters} */
  const P = { st: 0, si: 0, raf: 0, stFired: 0, siFired: 0, rafFired: 0,
              fetch: 0, ws: 0, xhr: 0, longtasks: 0, longtaskMs: 0, maxLongtask: 0,
              mut: 0, mutOutside: 0, fetchUrls: {}, wsUrls: {}, resetAt: 0 };
  w.__perf = P;
  w.__perfReset = () => {
    for (const k of KEYS) P[k] = 0;
    P.fetchUrls = {};
    P.wsUrls = {};
    P.resetAt = Date.now();
  };
  P.resetAt = Date.now();

  /** @param {string | URL} u */
  const path = (u) => {
    try { return new URL(u, w.location.href).pathname; } catch { return String(u); }
  };

  const _st = w.setTimeout;
  w.setTimeout = function (fn, d, ...a) {
    P.st++;
    if (typeof fn === "function") {
      const orig = fn;
      fn = /** @this {unknown} */ function () { P.stFired++; return orig.apply(this, arguments); };
    }
    return _st.call(w, fn, d, ...a);
  };
  const _si = w.setInterval;
  w.setInterval = function (fn, d, ...a) {
    P.si++;
    if (typeof fn === "function") {
      const orig = fn;
      fn = /** @this {unknown} */ function () { P.siFired++; return orig.apply(this, arguments); };
    }
    return _si.call(w, fn, d, ...a);
  };
  const _raf = w.requestAnimationFrame;
  if (_raf) {
    w.requestAnimationFrame = function (fn) {
      P.raf++;
      return _raf.call(w, /** @this {unknown} */ function (time) {
        P.rafFired++; return fn.call(this, time);
      });
    };
  }

  const _fetch = w.fetch;
  w.fetch = function (input, init) {
    P.fetch++;
    const u = typeof input === "string" ? input : (input && "url" in input && input.url) || "";
    const k = path(u);
    P.fetchUrls[k] = (P.fetchUrls[k] || 0) + 1;
    return _fetch.call(w, input, init);
  };

  // Typed by the overloads' common prefix, so a call forwards whichever
  // overload the page used.
  /**
   * @type {(this: XMLHttpRequest, m: string, u: string | URL,
   *   ...rest: unknown[]) => void}
   */
  const _open = w.XMLHttpRequest && w.XMLHttpRequest.prototype.open;
  if (_open) {
    /**
     * @this {XMLHttpRequest}
     * @param {string} m
     * @param {string | URL} u
     * @param {...unknown} rest
     */
    w.XMLHttpRequest.prototype.open = function (m, u, ...rest) {
      P.xhr++;
      const k = path(u);
      P.fetchUrls[k] = (P.fetchUrls[k] || 0) + 1;
      return _open.call(this, m, u, ...rest);
    };
  }

  // A construct trap keeps the real constructor's prototype, constants and
  // arguments, so `new WebSocket(...)` behaves as before, counted.
  w.WebSocket = new Proxy(w.WebSocket, {
    construct(target, args, newTarget) {
      P.ws++;
      const k = path(args[0]);
      P.wsUrls[k] = (P.wsUrls[k] || 0) + 1;
      return Reflect.construct(target, args, newTarget);
    },
  });

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        P.longtasks++;
        P.longtaskMs += e.duration;
        if (e.duration > P.maxLongtask) P.maxLongtask = e.duration;
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* longtask unsupported */ }

  // Mutation accounting for the typing scenarios: how much of the DOM churns
  // per keystroke, split by whether the mutation lands inside the block the
  // caret is in (expected) or elsewhere in the outline (re-render fan-out).
  w.__perfMutStart = (rootSel) => {
    if (w.__perfMO) w.__perfMO.disconnect();
    P.mut = 0; P.mutOutside = 0;
    const root = document.querySelector(rootSel) || document.body;
    const mo = new MutationObserver((recs) => {
      const active = document.activeElement;
      const focused = active && active.closest
        ? active.closest("[data-uid], .block, li") : null;
      for (const r of recs) {
        P.mut++;
        const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (!focused || !t || !focused.contains(t)) P.mutOutside++;
      }
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    w.__perfMO = mo;
    return true;
  };
  w.__perfMutStop = () => { if (w.__perfMO) w.__perfMO.disconnect(); };
})();
