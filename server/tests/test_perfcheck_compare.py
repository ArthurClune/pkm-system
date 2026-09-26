from perfcheck.compare import (Finding, bootstrap, compare, confirm,
                               incomparable_reason, render_table)


def doc(scenarios, *, fixture_hash="fx1", env=None, commit="c1"):
    return {"commit": commit, "fixture_hash": fixture_hash,
            "env": env or {"python": "3.12.10", "sqlite": "3.47.1"},
            "scenarios": scenarios}


def ex(v):
    return {"class": "exact", "value": v}


def tm(v):
    return {"class": "timing", "value": v}


def band(lo, hi):
    return {"class": "band", "min": lo, "max": hi}


def bv(v):
    return {"class": "band", "value": v}


def kinds(c):
    return {(f.scenario, f.metric): f.kind for f in c.findings}


def test_exact_increase_is_candidate_and_baseline_kept():
    c = compare(doc({"s": {"statements": ex(4)}}), doc({"s": {"statements": ex(5)}}))
    assert kinds(c) == {("s", "statements"): "candidate"}
    assert c.new_baseline["scenarios"]["s"]["statements"] == ex(4)


def test_exact_decrease_ratchets():
    c = compare(doc({"s": {"statements": ex(4)}}), doc({"s": {"statements": ex(3)}}, commit="c2"))
    assert kinds(c) == {("s", "statements"): "improvement"}
    assert c.new_baseline["scenarios"]["s"]["statements"] == ex(3)
    assert c.new_baseline["commit"] == "c2"


def test_exact_equal_passes_silently():
    c = compare(doc({"s": {"statements": ex(4)}}), doc({"s": {"statements": ex(4)}}))
    assert c.findings == ()


def test_band_inside_passes_above_is_candidate_below_shifts_down():
    base = doc({"s": {"long_tasks": band(1, 3)}})
    assert compare(base, doc({"s": {"long_tasks": bv(3)}})).findings == ()
    assert kinds(compare(base, doc({"s": {"long_tasks": bv(4)}}))) == {("s", "long_tasks"): "candidate"}
    c = compare(base, doc({"s": {"long_tasks": bv(0)}}))
    assert kinds(c) == {("s", "long_tasks"): "improvement"}
    assert c.new_baseline["scenarios"]["s"]["long_tasks"] == band(0, 2)


def test_timing_only_flags_past_factor_and_only_ratchets_past_factor():
    base = doc({"s": {"median_ms": tm(10.0)}})
    assert compare(base, doc({"s": {"median_ms": tm(19.9)}})).findings == ()
    assert kinds(compare(base, doc({"s": {"median_ms": tm(20.1)}}))) == {("s", "median_ms"): "candidate"}
    assert compare(base, doc({"s": {"median_ms": tm(6.0)}})).findings == ()
    c = compare(base, doc({"s": {"median_ms": tm(4.9)}}))
    assert kinds(c) == {("s", "median_ms"): "improvement"}
    assert c.new_baseline["scenarios"]["s"]["median_ms"] == tm(4.9)


def test_new_scenario_and_metric_recorded():
    base = doc({"s": {"statements": ex(4)}})
    c = compare(base, doc({"s": {"statements": ex(4), "bytes": ex(10)},
                           "t": {"long_tasks": bv(2)}}))
    assert kinds(c) == {("s", "bytes"): "new", ("t", "long_tasks"): "new"}
    assert c.new_baseline["scenarios"]["s"]["bytes"] == ex(10)
    assert c.new_baseline["scenarios"]["t"]["long_tasks"] == band(2, 2)


def test_lost_scenario_and_metric_block():
    base = doc({"s": {"statements": ex(4), "bytes": ex(1)}, "t": {"statements": ex(1)}})
    c = compare(base, doc({"s": {"statements": ex(4)}}))
    assert kinds(c) == {("s", "bytes"): "lost", ("t", "*"): "lost"}
    assert {(f.scenario, f.metric) for f in c.blocking} == {("s", "bytes"), ("t", "*")}


def test_class_change_is_reclassified_and_blocks():
    c = compare(doc({"s": {"x": ex(4)}}), doc({"s": {"x": bv(4)}}))
    assert kinds(c) == {("s", "x"): "reclassified"}
    assert len(c.blocking) == 1


def test_incomparable_on_fixture_or_env_change():
    base = doc({})
    assert incomparable_reason(base, doc({})) is None
    assert "fixture_hash" in incomparable_reason(base, doc({}, fixture_hash="fx2"))  # pyrefly: ignore[not-iterable] (asserting non-None)
    assert "sqlite" in incomparable_reason(base, doc({}, env={"python": "3.12.10", "sqlite": "3.48.0"}))  # pyrefly: ignore[not-iterable] (asserting non-None)


def test_confirm_outcomes():
    base = doc({"a": {"n": ex(1)}, "b": {"n": ex(1)}, "c": {"n": ex(1)}})
    cands = [Finding("a", "n", "candidate", "1", "2"),
             Finding("b", "n", "candidate", "1", "2"),
             Finding("c", "n", "candidate", "1", "2")]
    rerun = doc({"a": {"n": ex(1)}, "b": {"n": ex(2)}, "c": {"n": ex(2)}})
    mb = doc({"b": {"n": ex(2)}, "c": {"n": ex(1)}})
    assert confirm(base, cands, rerun, mb) == {
        ("a", "n"): "unstable", ("b", "n"): "stale-baseline", ("c", "n"): "regression"}


def test_confirm_without_merge_base_means_regression():
    base = doc({"a": {"n": ex(1)}})
    assert confirm(base, [Finding("a", "n", "candidate", "1", "2")],
                   doc({"a": {"n": ex(2)}}), None) == {("a", "n"): "regression"}


def test_bootstrap_builds_bands_and_timing_median():
    runs = [doc({"s": {"n": ex(4), "lt": bv(v), "ms": tm(t)}})
            for v, t in [(1, 10.0), (3, 30.0), (2, 20.0)]]
    base, unstable = bootstrap(runs)
    assert unstable == ()
    assert base["scenarios"]["s"] == {"n": ex(4), "lt": band(1, 3), "ms": tm(20.0)}  # pyrefly: ignore[unsupported-operation] (asserting non-None)


def test_bootstrap_flags_unequal_exact():
    runs = [doc({"s": {"n": ex(4)}}), doc({"s": {"n": ex(5)}})]
    base, unstable = bootstrap(runs)
    assert base is None
    assert [(u.scenario, u.metric, u.values) for u in unstable] == [("s", "n", (4, 5))]


def test_render_table_names_outcome():
    out = render_table([Finding("backlinks/hub", "statements", "candidate", "4", "204")],
                       {("backlinks/hub", "statements"): "regression"})
    assert "| backlinks/hub | statements | 4 | 204 | regression |" in out
