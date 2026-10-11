---
# pkm-7o7r
title: 'ipad-simulator skill broken under Xcode 27: Simulator.app gone, safaridriver sessions fail'
status: completed
type: bug
priority: normal
created_at: 2026-10-11T15:07:38Z
updated_at: 2026-10-11T15:23:07Z
---

The `ipad-simulator` skill (and `scripts/simpad.py`) no longer works with the Xcode installed on biber (Xcode 27.0).

## Symptom

- `Simulator.app` is gone. `Xcode.app/Contents/Applications` now holds `DeviceHub.app` (alongside Accessibility Inspector, Create ML, FileMerge, Icon Composer and Instruments).
- `safaridriver` sessions against the simulator fail with `The file "open" couldn't be opened`. One session succeeded on 2026-10-10 before it broke, so it may be a stale state or a dependency on Simulator.app being launchable.
- Seen while chasing the local-PDF hang (handover 2026-10-10). A small local PDF did open in the iPad simulator (iOS 26.5) that session, before sessions started failing.

## Todo

- [x] Reproduce: `scripts/simpad.py up` and one safaridriver session from a clean state; capture the exact failing step and error
- [x] Find what replaces Simulator.app in Xcode 27 (DeviceHub.app? `xcrun simctl` alone?) and whether safaridriver's simulator support still needs a visible Simulator UI
- [x] Fix `scripts/simpad.py` (boot, open, safaridriver session setup) for Xcode 27
- [x] Update `.claude/skills/ipad-simulator/SKILL.md` (invoke `superpowers:writing-skills` first): any Simulator.app references, the device/OS line, and the failure table
- [x] Verify end-to-end: a session loads the app on the simulated iPad and runs one `execute_script` check
- [x] Fix the ruff 0.16 default-rule findings in simpad.py (UP035, PLW1510)
- [x] `down` kills only the listener `up` started, never a pid that merely holds a connection
- [x] Move simpad off proptest's 8978 to 8979 (`FORBIDDEN_PORTS`, `up` refuses an occupied port, AGENTS.md port table, SKILL.md); re-verify end to end on 8979

## Summary of Changes

- Root cause: Xcode 27 ships no Simulator.app. safaridriver opens the simulator through DeviceHub's `devices://device/open` URL. Until Xcode's first-launch packages are installed, DeviceHub can't answer that URL, so the open timed out (-1712). safaridriver reported this as `The file "open" couldn't be opened`. The packages were approved at the console at 12:54 on 2026-10-11.
- `simpad.py`:
  - checks `xcodebuild -checkFirstLaunchStatus` before `up` and `session()`, and stops with the `sudo xcodebuild -runFirstLaunch` fix;
  - moves from 8978 (proptest's) to 8979, adds 8978 to the forbidden ports and refuses an occupied port;
  - `down` kills only the recorded listener, never a pid that is only connected to the port;
  - fixes two ruff findings (from ruff 0.16).
- `SKILL.md`: covers Xcode 27 (no Simulator.app; DeviceHub is launched by safaridriver) and adds hard-rule rows for the first-launch trap and port 8979. AGENTS.md's port table gains 8979.
- Verified end to end on 8979: up, a session check with no JS errors, a screenshot, then down. Afterwards the simulator was shut down and the port free.
