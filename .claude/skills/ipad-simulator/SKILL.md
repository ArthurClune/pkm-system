---
name: ipad-simulator
description: Use when a change needs verifying on real iPadOS Safari/WebKit rather than desktop Chromium — touch or drag-handle behaviour, textarea auto-grow, popover placement, PWA layout, "does this work on the iPad?" — or when someone reaches for the iOS Simulator, safaridriver, or `xcrun simctl`.
---

# iPad simulator verification

## Overview

Playwright covers Chromium only. The iOS Simulator on this Mac (iPad Air 11-inch M4, iOS 26.5) runs the real WebKit, driven through selenium + `/usr/bin/safaridriver`. Everything in the browser is done with `execute_script`; the page is mutated through the API, never the UI. `scripts/simpad.py` holds the plumbing — do not re-derive it.

## Quick reference

```bash
S=.claude/skills/ipad-simulator/scripts/simpad.py
uv run --with selenium python $S up            # boot sim, build web/dist if stale, throwaway server on 8978
uv run --with selenium python $S shot /abs/path.png
uv run --with selenium python $S down --shutdown-sim
```

`up` prints `UDID=…`, `PORT=…`, `LOG=…`. The server is `server/tests/e2e_serve.py`: fresh temp DB, password `e2e-pw`, serves `web/dist`.

Import the same file from a check script (run it with `uv run --with selenium python check.py`):

| Need | Call |
|---|---|
| logged-in driver | `with simpad.session() as d:` |
| seed a page | `api = simpad.Api(); api.login(); simpad.seed_page(api, "Sim Test", texts)` |
| navigate + JS error capture | `simpad.goto(d, 8978, "/page/Sim%20Test")` … `simpad.js_errors(d)` |
| click something | `simpad.dispatch_click(d, ".selector")` |
| focus a block / type into it | `simpad.focus_block(d, 0)`; `simpad.set_textarea(d, text)` |
| geometry / text | `simpad.rect(d, sel)`, `simpad.text_of_all(d, sel)` |
| drag-and-drop handlers | `simpad.dnd_sweep(d, from_idx, to_idx, events, pace_ms)` |
| screenshot | `simpad.screenshot("/abs/path.png")` (simctl, shows the real screen) |

## What the simulator can and cannot prove

- **Can**: real WebKit layout, CSS support (`CSS.supports`), React handlers for click/focus/input/drag (via synthetic events), popover geometry, JS errors during an action.
- **Cannot**: UIKit's own touch pipeline. W3C touch actions fire `dragstart` but UIKit swallows every later move, so `dragover`/`drop` never arrive from a real gesture. Report that limit on the bean; a physical iPad is the only closure.

## Hard rules (each one has bitten)

| Rule | Why |
|---|---|
| `element.click()` / `send_keys` never | click starts text selection or crashes the session (`InvalidSessionIdException`); send_keys types nothing. Use `dispatch_click` / `set_textarea`. |
| Seed via `Api.post_ops`, not the `pkm` CLI | the CLI is logged in to **prod**; the throwaway server has a different DB and password. |
| Op uids 6–32 chars | server `UID_RE`; `seed_page` enforces it. |
| `driver.get_log` does not exist | capture with `install_error_capture` **before** the action. |
| Screenshot paths absolute, under the scratchpad | relative paths resolve against the daemon's cwd; never into the repo. |
| Judge overlays from `simpad.screenshot` (simctl), never `page_screenshot` | the WebDriver image omits `position: fixed` elements portalled to `<body>` — the block menu was open in the DOM and missing from the picture. |
| Synthetic clicks land at (0,0) | `dispatch_click` sends no coordinates, so anything positioned from `clientX/Y` opens top-left. Assert on `rect(...) is not None`, not on placement. |
| Teardown = `simpad.py down` only | it kills `lsof -ti tcp:8978`. `pgrep -f pkm.server.run` also matches the launchd **prod** server on 8974. Never `launchctl bootout/kickstart`; never touch 8974/8975/8977. |
| `bootstatus -b` before the first session | a cold boot takes minutes; safaridriver times out otherwise (`up` does this). |

## Example

```python
# pattern: Imperative Shell — does tapping a bullet open the block menu on iPadOS, error-free?
import sys; sys.path.insert(0, ".claude/skills/ipad-simulator/scripts")
import simpad
OUT = "/private/tmp/claude-501/.../scratchpad"   # this session's scratchpad

api = simpad.Api(); api.login()
simpad.seed_page(api, "Sim Menu", ["first block", "second block"])
with simpad.session() as d:
    simpad.goto(d, 8978, "/page/Sim%20Menu")
    simpad.dispatch_click(d, ".bullet", 1)          # second block's bullet
    menu = simpad.rect(d, ".block-menu")             # None => menu did not open
    simpad.screenshot(f"{OUT}/menu.png")             # simctl: shows the menu; the WebDriver shot would not
    print({"menu": menu, "errors": simpad.js_errors(d)})
```

Selector names come from the component under test — read it first; `field-sizing: content` is supported on iOS 26.5, so the JS auto-grow fallback is *not* exercised there.
