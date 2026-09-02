# pattern: Imperative Shell
"""Driver library + CLI for exercising this repo's web app in the iOS
simulator's Safari, via safaridriver/selenium.

Consolidates three proven ad-hoc scripts (pkm-youp's autogrow check,
pkm-ikk0's seed + drag-and-drop check) into one reusable module: a small
`Api` client for seeding/reading data over HTTP, a `session()` driver
context manager, and page-interaction helpers (focus, textarea value
injection, synthetic drag sweep, screenshots).

Run as a CLI:
    uv run --with selenium python .claude/skills/ipad-simulator/scripts/simpad.py <cmd>

Subcommands: up, down, shot, udid. See `--help` on each for options, or
the module docstrings below for the importable library API.

Hard safety rules (do not relax these, even temporarily):
  1. Never use port 8974 (prod), 8975 (pnpm's own e2e harness), or 8977
     (perf harness). This tool defaults to 8978 and `up`/`down` refuse the
     other three outright.
  2. Never kill processes by name pattern (e.g. `pkill uvicorn`) -- other
     dev servers on this machine share process names. Only kill pids
     obtained from `lsof -ti tcp:<this tool's own port>`.
  3. Never call `launchctl bootout` or `launchctl kickstart` -- that is
     prod's launchd service. This tool only starts/stops its own
     subprocess.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

# selenium is imported lazily inside the functions that need it, so that
# `simpad.py up/down/shot/udid` (pure subprocess/HTTP work) don't require
# it to be installed -- only `session()` and its callers do.

REPO_ROOT = Path(__file__).resolve().parents[4]
FORBIDDEN_PORTS = {8974, 8975, 8977}
DEFAULT_PORT = 8978
DEFAULT_DEVICE = "iPad Air 11-inch (M4)"
DEFAULT_PASSWORD = "e2e-pw"
UID_RE = re.compile(r"^[a-zA-Z0-9_-]{6,32}$")


# --------------------------------------------------------------------------
# HTTP API client (stdlib urllib, no selenium) -- login, seed, read, delete.
# --------------------------------------------------------------------------

class Api:
    """Thin urllib client for this app's /api routes, cookie-authenticated."""

    def __init__(self, port: int = DEFAULT_PORT, password: str = DEFAULT_PASSWORD) -> None:
        self.base = f"http://127.0.0.1:{port}"
        self.password = password
        self._cookie: str | None = None

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        """Issue one request; returns parsed JSON (or None for empty body)."""
        req = urllib.request.Request(self.base + path, method=method)
        req.add_header("Content-Type", "application/json")
        if self._cookie:
            req.add_header("Cookie", self._cookie)
        data = json.dumps(body).encode() if body is not None else None
        with urllib.request.urlopen(req, data=data) as resp:
            set_cookie = resp.headers.get("Set-Cookie")
            if set_cookie:
                self._cookie = set_cookie.split(";")[0]
            raw = resp.read()
            return json.loads(raw) if raw else None

    def login(self) -> Any:
        """POST /api/login with the fixed e2e password; stores the session cookie."""
        return self.request("POST", "/api/login", {"password": self.password})

    def post_ops(self, ops: list[dict[str, Any]], client_id: str = "simpad") -> Any:
        """POST /api/ops, wrapping `ops` in the required batch envelope."""
        batch = {
            "client_id": client_id,
            "batch_id": f"{client_id}-{int(time.time() * 1000)}",
            "ops": ops,
        }
        return self.request("POST", "/api/ops", batch)

    def get_page(self, title: str) -> Any:
        """GET /api/page/{title}."""
        return self.request("GET", f"/api/page/{quote(title, safe='/')}")

    def delete_page(self, title: str) -> Any:
        """DELETE /api/page/{title}."""
        return self.request("DELETE", f"/api/page/{quote(title, safe='/')}")


def seed_page(api: Api, title: str, texts: list[str], uid_prefix: str | None = None) -> list[str]:
    """Create `title` and one top-level block per string in `texts`; returns the uids used.

    The default prefix is time-based so repeated seeds in one server lifetime
    don't collide (a duplicate uid makes /api/ops answer 400).
    """
    if uid_prefix is None:
        uid_prefix = f"sp{int(time.time() * 1000) % 10**9:09d}"
    uids = [f"{uid_prefix}{i:03d}" for i in range(len(texts))]
    for uid in uids:
        assert UID_RE.fullmatch(uid), f"uid {uid!r} violates server UID_RE (6-32 chars, [A-Za-z0-9_-])"
    ops: list[dict[str, Any]] = [{"op": "create_page", "page_title": title}]
    for i, (uid, text) in enumerate(zip(uids, texts)):
        ops.append({
            "op": "create",
            "uid": uid,
            "page_title": title,
            "parent_uid": None,
            "order_idx": i,
            "text": text,
        })
    api.post_ops(ops)
    return uids


# --------------------------------------------------------------------------
# simctl helpers (device discovery/boot) -- used by both the CLI and
# session().
# --------------------------------------------------------------------------

def _simctl_devices() -> dict[str, Any]:
    out = subprocess.run(["xcrun", "simctl", "list", "devices", "-j"],
                          capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["devices"]


def find_device_udid(name: str = DEFAULT_DEVICE) -> str:
    """Return the UDID of a matching, ideally already-Booted, simulator device.

    Prefers a booted device with a matching name; falls back to the first
    matching device of any state (caller is responsible for booting it).
    Raises if no device with that name exists at all.
    """
    devices = _simctl_devices()
    candidates: list[tuple[str, str]] = []  # (state, udid)
    for runtime_devices in devices.values():
        for d in runtime_devices:
            if d.get("name") == name:
                candidates.append((d.get("state", ""), d["udid"]))
    if not candidates:
        raise RuntimeError(f"no simulator device named {name!r} found")
    for state, udid in candidates:
        if state == "Booted":
            return udid
    return candidates[0][1]


def find_booted_udid(name: str = DEFAULT_DEVICE) -> str:
    """Return the UDID of the currently-Booted device matching `name`, booting it if needed."""
    udid = find_device_udid(name)
    devices = _simctl_devices()
    for runtime_devices in devices.values():
        for d in runtime_devices:
            if d["udid"] == udid and d.get("state") == "Booted":
                return udid
    subprocess.run(["xcrun", "simctl", "boot", udid], check=True)
    subprocess.run(["xcrun", "simctl", "bootstatus", udid, "-b"], check=True)
    return udid


# --------------------------------------------------------------------------
# CLI: up / down / shot / udid
# --------------------------------------------------------------------------

def _check_port_allowed(port: int) -> None:
    if port in FORBIDDEN_PORTS:
        raise SystemExit(
            f"refusing port {port}: reserved for prod (8974), pnpm's own "
            f"e2e harness (8975), or the perf harness (8977). Use the "
            f"default {DEFAULT_PORT} or another free port."
        )


def _pid_file(port: int) -> Path:
    return Path(tempfile.gettempdir()) / f"simpad-{port}.pid"


def _log_file(port: int) -> Path:
    return Path(tempfile.gettempdir()) / f"simpad-{port}.log"


def _needs_build(web_dir: Path) -> bool:
    dist_index = web_dir / "dist" / "index.html"
    if not dist_index.is_file():
        return True
    dist_mtime = dist_index.stat().st_mtime
    src_dir = web_dir / "src"
    newest_src = max((p.stat().st_mtime for p in src_dir.rglob("*") if p.is_file()),
                      default=0.0)
    return newest_src > dist_mtime


def cmd_up(port: int, device: str, no_build: bool) -> None:
    """Boot the simulator device (if needed), build the SPA (if stale), start the e2e server."""
    _check_port_allowed(port)

    udid = find_booted_udid(device)

    web_dir = REPO_ROOT / "web"
    server_dir = REPO_ROOT / "server"
    if not no_build and _needs_build(web_dir):
        subprocess.run(["pnpm", "build"], cwd=web_dir, env={**os.environ, "CI": "true"},
                        check=True)

    log_path = _log_file(port)
    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            ["uv", "run", "python", "tests/e2e_serve.py"],
            cwd=server_dir,
            env={**os.environ, "E2E_PORT": str(port)},
            stdout=log_f, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    _pid_file(port).write_text(str(proc.pid))

    deadline = time.time() + 60
    url = f"http://127.0.0.1:{port}/"
    up = False
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    up = True
                    break
        except (urllib.error.URLError, ConnectionError):
            pass
        time.sleep(0.5)
    if not up:
        raise SystemExit(f"server did not respond with 200 on {url} within 60s; see {log_path}")

    print(f"UDID={udid}")
    print(f"PORT={port}")
    print(f"LOG={log_path}")


def cmd_down(port: int, shutdown_sim: bool) -> None:
    """Kill only the pids listening on `port`, then optionally shut down booted iPads."""
    _check_port_allowed(port)

    out = subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True)
    pids = [int(p) for p in out.stdout.split()]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if pids:
        time.sleep(3)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    pid_file = _pid_file(port)
    if pid_file.exists():
        pid_file.unlink()

    print(f"killed pids on port {port}: {pids}")

    if shutdown_sim:
        devices = _simctl_devices()
        booted_ipads = [
            d["udid"] for runtime_devices in devices.values() for d in runtime_devices
            if d.get("state") == "Booted" and "iPad" in d.get("name", "")
        ]
        for udid in booted_ipads:
            subprocess.run(["xcrun", "simctl", "shutdown", udid], check=True)
        print(f"shut down simulators: {booted_ipads}")


def cmd_shot(path: str, device: str) -> None:
    """Screenshot the booted iPad simulator to an absolute path."""
    if not Path(path).is_absolute():
        raise SystemExit("refusing relative path; pass an absolute path")
    udid = find_booted_udid(device)
    subprocess.run(["xcrun", "simctl", "io", udid, "screenshot", path], check=True)
    print(path)


def cmd_udid(device: str) -> None:
    """Print the booted (or best-match) device UDID."""
    print(find_device_udid(device))


# --------------------------------------------------------------------------
# selenium-driven page interaction (imports selenium lazily)
# --------------------------------------------------------------------------

@contextmanager
def session(port: int = DEFAULT_PORT, udid: str | None = None,
            password: str = DEFAULT_PASSWORD) -> Iterator[Any]:
    """Context manager yielding a logged-in Safari-on-simulator webdriver.

    Builds capabilities exactly as the proven ad-hoc scripts did
    (`platformName: ios`, `safari:useSimulator: True`,
    `safari:deviceUDID`), logs in via an in-page fetch to /api/login, and
    always quits the driver on exit.
    """
    from selenium import webdriver
    from selenium.webdriver.safari.options import Options as SafariOptions

    if udid is None:
        udid = find_booted_udid()

    sopts = SafariOptions()
    sopts.set_capability("platformName", "ios")
    sopts.set_capability("safari:useSimulator", True)
    sopts.set_capability("safari:deviceUDID", udid)
    sopts.set_capability("browserName", "safari")

    driver = webdriver.Safari(options=sopts)
    driver.set_script_timeout(20)
    try:
        base = f"http://localhost:{port}"
        driver.get(f"{base}/login")
        time.sleep(1)
        login_script = f"""
        var callback = arguments[arguments.length - 1];
        fetch('/api/login', {{
          method: 'POST',
          headers: {{'Content-Type': 'application/json'}},
          body: JSON.stringify({{password: {json.dumps(password)}}})
        }}).then(r => r.json()).then(j => callback(JSON.stringify(j)))
          .catch(e => callback('ERROR:' + e));
        """
        driver.execute_async_script(login_script)
        yield driver
    finally:
        driver.quit()


def goto(driver: Any, port: int, path: str) -> None:
    """Navigate to `path` on the local server, wait for load, and (re)install error capture."""
    driver.get(f"http://localhost:{port}{path}")
    time.sleep(1.5)
    install_error_capture(driver)


_ERR_CAPTURE_JS = """
if (!window.__simpadErrorsInstalled) {
  window.__simpadErrors = [];
  window.onerror = function(msg, src, line, col, err) {
    window.__simpadErrors.push({msg: String(msg), line: line, col: col, stack: err && err.stack});
  };
  window.addEventListener('unhandledrejection', function(e) {
    window.__simpadErrors.push({msg: 'unhandledrejection: ' + String(e.reason), stack: e.reason && e.reason.stack});
  });
  window.__simpadErrorsInstalled = true;
}
return 'installed';
"""


def install_error_capture(driver: Any) -> None:
    """Install window.onerror/unhandledrejection capture into window.__simpadErrors (idempotent)."""
    driver.execute_script(_ERR_CAPTURE_JS)


def js_errors(driver: Any) -> list[dict[str, Any]]:
    """Return the errors captured by install_error_capture() so far."""
    return driver.execute_script("return window.__simpadErrors || [];")


_DISPATCH_CLICK_JS = """
var sel = arguments[0], idx = arguments[1];
var els = document.querySelectorAll(sel);
var el = els[idx];
if (!el) return 'NOT_FOUND';
el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, view: window}));
el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
return 'DISPATCHED';
"""


def dispatch_click(driver: Any, selector: str, index: int = 0) -> str:
    """Fire synthetic mousedown/mouseup/click on the `index`-th match of `selector`.

    Never use element.click(): on iPadOS Safari via safaridriver, a real
    click starts native text selection (or has crashed the driver session
    outright in past runs) rather than reliably focusing the element.
    Synthetic MouseEvents avoid both failure modes.
    """
    return driver.execute_script(_DISPATCH_CLICK_JS, selector, index)


_FIND_TA_JS = """
var ta = document.querySelector('textarea.block-input');
if (!ta) return null;
return {
  offsetHeight: ta.offsetHeight,
  scrollHeight: ta.scrollHeight,
  clientHeight: ta.clientHeight,
  computedHeight: getComputedStyle(ta).height,
  value: ta.value
};
"""


def textarea_info(driver: Any) -> dict[str, Any] | None:
    """Return offset/scroll/client heights, computed height, and value of the focused block textarea."""
    return driver.execute_script(_FIND_TA_JS)


def focus_block(driver: Any, index: int = 0) -> dict[str, Any] | None:
    """Click the `index`-th .block-text into edit mode and return its textarea_info()."""
    dispatch_click(driver, ".block-text", index)
    time.sleep(0.5)
    return textarea_info(driver)


_SET_TEXTAREA_JS = """
var ta = document.querySelector('textarea.block-input');
if (!ta) return 'NO_TA';
var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setter.call(ta, arguments[0]);
ta.dispatchEvent(new Event('input', {bubbles: true}));
return 'OK';
"""


def set_textarea(driver: Any, text: str) -> str:
    """Set the focused block textarea's value via the native setter + input event.

    React/controlled textareas ignore .value assignment through send_keys
    or plain property set (the framework's own setter intercepts it); this
    goes through HTMLTextAreaElement.prototype's setter directly, which
    bypasses that and fires a real 'input' event so the app's onChange
    handler sees the change.
    """
    return driver.execute_script(_SET_TEXTAREA_JS, text)


def rect(driver: Any, selector: str, index: int = 0) -> dict[str, float] | None:
    """Return getBoundingClientRect() of the `index`-th match of `selector`, or None."""
    return driver.execute_script(
        "var els = document.querySelectorAll(arguments[0]); var el = els[arguments[1]];"
        "if (!el) return null; var r = el.getBoundingClientRect();"
        "return {top: r.top, left: r.left, right: r.right, bottom: r.bottom,"
        " width: r.width, height: r.height};",
        selector, index,
    )


def text_of_all(driver: Any, selector: str) -> list[str]:
    """Return textContent of every element matching `selector`."""
    return driver.execute_script(
        "return Array.prototype.map.call(document.querySelectorAll(arguments[0]),"
        " function(el) { return el.textContent; });",
        selector,
    )


def screenshot(abs_path: str, device: str = DEFAULT_DEVICE) -> None:
    """Screenshot the simulator *screen* to `abs_path` (must be absolute).

    Uses `xcrun simctl io ... screenshot`, which shows what is really on
    screen. The WebDriver screenshot (`page_screenshot`) renders the document
    only: verified 2026-09-02 that it omits `position: fixed` overlays
    portalled to <body> (the block menu was in the DOM, visible, and absent
    from the image), so never use it to judge popover/menu placement.
    """
    if not Path(abs_path).is_absolute():
        raise ValueError("refusing relative path; pass an absolute path")
    subprocess.run(["xcrun", "simctl", "io", find_device_udid(device), "screenshot", abs_path],
                   check=True, capture_output=True)


def page_screenshot(driver: Any, abs_path: str) -> None:
    """WebDriver document screenshot (no Safari chrome, no fixed overlays); see screenshot()."""
    if not Path(abs_path).is_absolute():
        raise ValueError("refusing relative path; pass an absolute path")
    driver.get_screenshot_as_file(abs_path)


# The in-page synthetic HTML5 drag sweep from pkm-ikk0's check_dnd.py:
# dragstart on row `fromIdx`'s drag handle, `events` dragover events marching
# clientY from the top of the drop zone toward row `toIdx`, sampling
# defaultPrevented and the .drop-indicator's position on each, then drop +
# dragend. Kept verbatim (proven on iPadOS 26) -- do not further wrap it.
DND_SWEEP_JS = """
var callback = arguments[arguments.length - 1];
var cfg = arguments[0];
try {
  var zone = document.querySelector(".outline-drop-zone");
  var rows = zone ? Array.prototype.slice.call(zone.querySelectorAll("[data-uid]")) : [];
  var startRow = rows[cfg.fromIdx];
  var handle = startRow ? startRow.querySelector('.bullet[draggable="true"]') : null;
  if (!zone || !handle || rows.length === 0) {
    callback(JSON.stringify({error: "no drop zone / drag handle", rowsFound: rows.length}));
    return;
  }
  var transfer = new DataTransfer();
  var fire = function(el, type, x, y) {
    var ev = new DragEvent(type, {bubbles: true, cancelable: true,
                                   clientX: x, clientY: y, dataTransfer: transfer});
    var t0 = performance.now();
    el.dispatchEvent(ev);
    return {ms: performance.now() - t0, prevented: ev.defaultPrevented};
  };
  var zoneBox = zone.getBoundingClientRect();
  var rowsBox = rows.map(function(r) { return r.getBoundingClientRect(); });
  var targetRow = rows[cfg.toIdx];
  var targetBox = targetRow.getBoundingClientRect();

  var dragstart = fire(handle, "dragstart", 40, rowsBox[cfg.fromIdx].top + 10);
  setTimeout(function() {
    var top = Math.max(zoneBox.top + 5, rowsBox[0].top);
    var bottom = targetBox.top + targetBox.height / 2;
    var samples = [];
    var notPrevented = 0;
    var i = 0;
    var indicatorTops = [];
    function step() {
      if (i >= cfg.events) {
        var dragend_and_drop = function() {
          var dropRes = fire(zone, "drop", 200, bottom);
          var dragendRes = fire(handle, "dragend", 200, bottom);
          setTimeout(function() {
            callback(JSON.stringify({
              events: samples.length, notPrevented: notPrevented,
              dragstartMs: dragstart.ms, samples: samples,
              indicatorTops: indicatorTops,
              dropMs: dropRes.ms, dropPrevented: dropRes.prevented,
              dragendMs: dragendRes.ms,
              rowsFound: rows.length,
            }));
          }, 500);
        };
        dragend_and_drop();
        return;
      }
      var y = top + ((bottom - top) * i) / (cfg.events - 1);
      var got = fire(zone, "dragover", 200, y);
      samples.push(got.ms);
      if (!got.prevented) notPrevented++;
      var ind = document.querySelector(".drop-indicator");
      indicatorTops.push(ind ? ind.getBoundingClientRect().top : null);
      i++;
      setTimeout(step, cfg.paceMs);
    }
    step();
  }, 100);
} catch (e) {
  callback(JSON.stringify({error: String(e), stack: e.stack}));
}
"""


def dnd_sweep(driver: Any, from_idx: int, to_idx: int, events: int, pace_ms: int) -> dict[str, Any]:
    """Run DND_SWEEP_JS dragging row `from_idx` toward row `to_idx`; returns the parsed result."""
    cfg = {"fromIdx": from_idx, "toIdx": to_idx, "events": events, "paceMs": pace_ms}
    raw = driver.execute_async_script(DND_SWEEP_JS, cfg)
    return json.loads(raw)


# --------------------------------------------------------------------------
# argparse CLI
# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_up = sub.add_parser("up", help="boot simulator + build (if stale) + start e2e server")
    p_up.add_argument("--port", type=int, default=DEFAULT_PORT)
    p_up.add_argument("--device", default=DEFAULT_DEVICE)
    p_up.add_argument("--no-build", action="store_true")

    p_down = sub.add_parser("down", help="stop the e2e server for --port")
    p_down.add_argument("--port", type=int, default=DEFAULT_PORT)
    p_down.add_argument("--shutdown-sim", action="store_true")

    p_shot = sub.add_parser("shot", help="screenshot the booted iPad simulator")
    p_shot.add_argument("path", help="absolute output path")
    p_shot.add_argument("--device", default=DEFAULT_DEVICE)

    sub.add_parser("udid", help="print the booted (or matching) device UDID").add_argument(
        "--device", default=DEFAULT_DEVICE)

    args = parser.parse_args()

    if args.cmd == "up":
        cmd_up(args.port, args.device, args.no_build)
    elif args.cmd == "down":
        cmd_down(args.port, args.shutdown_sim)
    elif args.cmd == "shot":
        cmd_shot(args.path, args.device)
    elif args.cmd == "udid":
        cmd_udid(args.device)
    else:
        parser.print_help()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
