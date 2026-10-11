---
# pkm-7o7r
title: 'ipad-simulator skill broken under Xcode 27: Simulator.app gone, safaridriver sessions fail'
status: todo
type: bug
priority: normal
created_at: 2026-10-11T15:07:38Z
updated_at: 2026-10-11T15:07:38Z
---

The `ipad-simulator` skill (and `scripts/simpad.py`) no longer works with the Xcode installed on biber (Xcode 27.0).

## Symptom

- `Simulator.app` is gone. `Xcode.app/Contents/Applications` now holds `DeviceHub.app` (alongside Accessibility Inspector, Create ML, FileMerge, Icon Composer and Instruments).
- `safaridriver` sessions against the simulator fail with `The file "open" couldn't be opened`. One session succeeded on 2026-10-10 before it broke, so it may be a stale state or a dependency on Simulator.app being launchable.
- Seen while chasing the local-PDF hang (handover 2026-10-10). A small local PDF did open in the iPad simulator (iOS 26.5) that session, before sessions started failing.

## Todo

- [ ] Reproduce: `scripts/simpad.py up` and one safaridriver session from a clean state; capture the exact failing step and error
- [ ] Find what replaces Simulator.app in Xcode 27 (DeviceHub.app? `xcrun simctl` alone?) and whether safaridriver's simulator support still needs a visible Simulator UI
- [ ] Fix `scripts/simpad.py` (boot, open, safaridriver session setup) for Xcode 27
- [ ] Update `.claude/skills/ipad-simulator/SKILL.md` (invoke `superpowers:writing-skills` first): any Simulator.app references, the device/OS line, and the failure table
- [ ] Verify end-to-end: a session loads the app on the simulated iPad and runs one `execute_script` check
