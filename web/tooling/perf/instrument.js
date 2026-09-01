// addInitScript payload: counts timers / fetch / WebSocket / XHR / longtasks
// into window.__perf. Installed before app code so it sees every call.
(() => {
  const w = window;
  const KEYS = ["st", "si", "raf", "stFired", "siFired", "rafFired",
                "fetch", "ws", "xhr", "longtasks", "longtaskMs", "maxLongtask",
                "mut", "mutOutside"];
  const P = {};
  for (const k of KEYS) P[k] = 0;
  P.fetchUrls = {};
  P.wsUrls = {};
  w.__perf = P;
  w.__perfReset = () => {
    for (const k of KEYS) P[k] = 0;
    P.fetchUrls = {};
    P.wsUrls = {};
    P.resetAt = Date.now();
  };
  P.resetAt = Date.now();

  const path = (u) => {
    try { return new URL(u, w.location.href).pathname; } catch { return String(u); }
  };

  const _st = w.setTimeout;
  w.setTimeout = function (fn, d, ...a) {
    P.st++;
    if (typeof fn === "function") {
      const orig = fn;
      fn = function () { P.stFired++; return orig.apply(this, arguments); };
    }
    return _st.call(w, fn, d, ...a);
  };
  const _si = w.setInterval;
  w.setInterval = function (fn, d, ...a) {
    P.si++;
    if (typeof fn === "function") {
      const orig = fn;
      fn = function () { P.siFired++; return orig.apply(this, arguments); };
    }
    return _si.call(w, fn, d, ...a);
  };
  const _raf = w.requestAnimationFrame;
  if (_raf) {
    w.requestAnimationFrame = function (fn) {
      P.raf++;
      return _raf.call(w, function () { P.rafFired++; return fn.apply(this, arguments); });
    };
  }

  const _fetch = w.fetch;
  w.fetch = function (input, init) {
    P.fetch++;
    const u = typeof input === "string" ? input : (input && input.url) || "";
    const k = path(u);
    P.fetchUrls[k] = (P.fetchUrls[k] || 0) + 1;
    return _fetch.call(w, input, init);
  };

  const _open = w.XMLHttpRequest && w.XMLHttpRequest.prototype.open;
  if (_open) {
    w.XMLHttpRequest.prototype.open = function (m, u, ...rest) {
      P.xhr++;
      const k = path(u);
      P.fetchUrls[k] = (P.fetchUrls[k] || 0) + 1;
      return _open.call(this, m, u, ...rest);
    };
  }

  const _WS = w.WebSocket;
  function WSWrap(url, protocols) {
    P.ws++;
    const k = path(url);
    P.wsUrls[k] = (P.wsUrls[k] || 0) + 1;
    return protocols === undefined ? new _WS(url) : new _WS(url, protocols);
  }
  WSWrap.prototype = _WS.prototype;
  WSWrap.CONNECTING = 0; WSWrap.OPEN = 1; WSWrap.CLOSING = 2; WSWrap.CLOSED = 3;
  w.WebSocket = WSWrap;

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
