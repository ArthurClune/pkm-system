# pattern: Functional Core
"""Judge one perf result against its committed baseline.

Every metric carries a class declared by the check that produced it:
`exact` counts must not rise, `band` counts must stay under the max seen at
bootstrap, `timing` values must not clearly worsen. Improvements are folded
into `Comparison.new_baseline` so they cannot silently erode later; a
worsened value is only a *candidate* until `confirm` has seen a re-run and a
merge-base run; a reproduced timing is then judged against that merge-base
run rather than the baseline."""
from __future__ import annotations

import copy
import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

TIMING_FACTOR = 2.0

Kind = Literal["candidate", "improvement", "new", "lost", "reclassified"]
Outcome = Literal["regression", "unstable", "stale-baseline"]
Judgement = Literal["pass", "candidate", "improvement"]


@dataclass(frozen=True)
class Finding:
    scenario: str
    metric: str
    kind: Kind
    baseline: str
    now: str


@dataclass(frozen=True)
class Comparison:
    findings: tuple[Finding, ...]
    new_baseline: dict

    @property
    def candidates(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.kind == "candidate")

    @property
    def blocking(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.kind in ("lost", "reclassified"))


@dataclass(frozen=True)
class Unstable:
    scenario: str
    metric: str
    values: tuple[float, ...]


def _show(m: dict) -> str:
    if m["class"] == "band" and "min" in m:
        return f"{m['min']}..{m['max']}"
    return str(m["value"])


def _as_baseline(m: dict) -> dict:
    """A result metric recorded fresh into a baseline."""
    if m["class"] == "band":
        return {"class": "band", "min": m["value"], "max": m["value"]}
    return {"class": m["class"], "value": m["value"]}


def judge(base: dict, now: dict) -> tuple[Judgement, dict]:
    """Verdict for one metric plus the baseline metric to keep."""
    v = now["value"]
    if base["class"] == "exact":
        if v > base["value"]:
            return "candidate", base
        if v < base["value"]:
            return "improvement", {"class": "exact", "value": v}
        return "pass", base
    if base["class"] == "band":
        if v > base["max"]:
            return "candidate", base
        if v < base["min"]:
            # min only: lowering max too would let one lucky low run narrow
            # the band until an ordinary run is a candidate; --bootstrap
            # lowers max
            return "improvement", {"class": "band", "min": v, "max": base["max"]}
        return "pass", base
    if v > base["value"] * TIMING_FACTOR:
        return "candidate", base
    if v * TIMING_FACTOR < base["value"]:
        return "improvement", {"class": "timing", "value": v}
    return "pass", base


def incomparable_reason(baseline: dict, result: dict) -> str | None:
    if baseline["fixture_hash"] != result["fixture_hash"]:
        return (f"fixture_hash differs (baseline {baseline['fixture_hash']}, "
                f"now {result['fixture_hash']})")
    diffs = [f"{k}: {baseline['env'].get(k)} -> {result['env'].get(k)}"
             for k in sorted(set(baseline["env"]) | set(result["env"]))
             if baseline["env"].get(k) != result["env"].get(k)]
    return "env differs (" + "; ".join(diffs) + ")" if diffs else None


def compare(baseline: dict, result: dict) -> Comparison:
    new = copy.deepcopy(baseline)
    findings: list[Finding] = []
    changed = False
    base_sc, now_sc = baseline["scenarios"], result["scenarios"]
    for name in sorted(base_sc):
        if name not in now_sc:
            findings.append(Finding(name, "*", "lost", "present", "missing"))
    for name in sorted(now_sc):
        metrics = now_sc[name]
        if name not in base_sc:
            new["scenarios"][name] = {k: _as_baseline(m) for k, m in metrics.items()}
            findings.extend(Finding(name, k, "new", "-", _show(m)) for k, m in sorted(metrics.items()))
            changed = True
            continue
        for key in sorted(base_sc[name]):
            if key not in metrics:
                findings.append(Finding(name, key, "lost", _show(base_sc[name][key]), "missing"))
        for key, m in sorted(metrics.items()):
            base_m = base_sc[name].get(key)
            if base_m is None:
                new["scenarios"][name][key] = _as_baseline(m)
                findings.append(Finding(name, key, "new", "-", _show(m)))
                changed = True
                continue
            if base_m["class"] != m["class"]:
                findings.append(Finding(name, key, "reclassified", base_m["class"], m["class"]))
                continue
            verdict, keep = judge(base_m, m)
            if verdict == "pass":
                continue
            findings.append(Finding(name, key, verdict, _show(base_m), _show(m)))
            if verdict == "improvement":
                new["scenarios"][name][key] = keep
                changed = True
    if changed:
        new["commit"] = result["commit"]
    return Comparison(tuple(findings), new)


def _metric(run: dict | None, f: Finding) -> dict | None:
    if run is None:
        return None
    return run["scenarios"].get(f.scenario, {}).get(f.metric)


def _still_worse(baseline: dict, f: Finding, run: dict | None) -> bool | None:
    """None when the run lacks the metric (treated as not reproduced)."""
    m = _metric(run, f)
    if m is None:
        return None
    return judge(baseline["scenarios"][f.scenario][f.metric], m)[0] == "candidate"


def _confirm_timing(baseline: dict, f: Finding, rerun: dict, merge_base: dict | None) -> Outcome:
    """A timing moves with machine load, which the re-run straight after the
    first run shares; so the branch is judged against the merge base measured
    in the same confirmation, not against the stored baseline."""
    now, mb = _metric(rerun, f), _metric(merge_base, f)
    if mb is None or now is None or now["value"] > mb["value"] * TIMING_FACTOR:
        return "regression"
    if _still_worse(baseline, f, merge_base):
        return "stale-baseline"
    return "unstable"


def confirm(baseline: dict, candidates: Iterable[Finding], rerun: dict,
            merge_base: dict | None) -> dict[tuple[str, str], Outcome]:
    out: dict[tuple[str, str], Outcome] = {}
    for f in candidates:
        key = (f.scenario, f.metric)
        if not _still_worse(baseline, f, rerun):
            out[key] = "unstable"
        elif baseline["scenarios"][f.scenario][f.metric]["class"] == "timing":
            out[key] = _confirm_timing(baseline, f, rerun, merge_base)
        elif _still_worse(baseline, f, merge_base):
            out[key] = "stale-baseline"
        else:
            out[key] = "regression"
    return out


def bootstrap(runs: Sequence[dict]) -> tuple[dict | None, tuple[Unstable, ...]]:
    first = runs[0]
    unstable: list[Unstable] = []
    scenarios: dict[str, dict] = {}
    for name, metrics in sorted(first["scenarios"].items()):
        scenarios[name] = {}
        for key, m in sorted(metrics.items()):
            values = tuple(r["scenarios"].get(name, {}).get(key, {}).get("value") for r in runs)
            if any(v is None for v in values):
                unstable.append(Unstable(name, key, values))
                continue
            if m["class"] == "exact":
                if len(set(values)) != 1:
                    unstable.append(Unstable(name, key, values))
                    continue
                scenarios[name][key] = {"class": "exact", "value": values[0]}
            elif m["class"] == "band":
                scenarios[name][key] = {"class": "band", "min": min(values), "max": max(values)}
            else:
                scenarios[name][key] = {"class": "timing", "value": statistics.median(values)}
    if unstable:
        return None, tuple(unstable)
    return ({"commit": first["commit"], "fixture_hash": first["fixture_hash"],
             "env": dict(first["env"]), "scenarios": scenarios}, ())


def render_table(findings: Iterable[Finding],
                 outcomes: Mapping[tuple[str, str], Outcome]) -> str:
    rows = ["| scenario | metric | baseline | now | verdict |",
            "|---|---|---|---|---|"]
    for f in findings:
        verdict = outcomes.get((f.scenario, f.metric), f.kind)
        rows.append(f"| {f.scenario} | {f.metric} | {f.baseline} | {f.now} | {verdict} |")
    return "\n".join(rows)
