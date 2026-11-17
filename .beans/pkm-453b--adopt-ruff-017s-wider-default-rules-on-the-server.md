---
# pkm-453b
title: Adopt ruff 0.17's wider default rules on the server
status: todo
type: task
priority: low
created_at: 2026-11-17T19:59:03Z
updated_at: 2026-11-17T19:59:03Z
---

ruff 0.17 widened its default rule set by about forty rules. pkm-hujh took 0.17 but pinned `select` in server/pyproject.toml to the pre-0.17 default (E4, E7, E9, F) plus E501 and ANN, so lint behaviour did not change.

Under the new defaults, ruff 0.17.5 reported 515 findings on 2026-11-17, the largest being I001 unsorted-imports (234), B008 function-call-in-default-argument (76, mostly FastAPI `Depends(...)`), ISC004 (43), RUF059 unused-unpacked-variable (20), SIM117 (18), PLW1510 subprocess-run-without-check (12) and BLE001 blind-except (10). `uv run ruff check --select ALL --statistics` or dropping the explicit `select` reproduces the list.

Pick rules on merit rather than taking the whole default: B023, BLE001, PLW1510 and RUF059 find real mistakes; I001 rewrites most files and conflicts with every open branch; B008 is FastAPI's idiom. Each adopted rule is a gate that fixes everything it covers in its own branch, with no baseline.

- [ ] Decide which of the new default rules earn a place
- [ ] Add them to `select` and fix every finding in the same branch
- [ ] Note the chosen set's reasoning beside `select`
