import pytest

from commentlint.core import (RULES, Violation, check_text, comment_spans, format_report,
                              is_scanned)


# -- which files the lint reads ------------------------------------------------

@pytest.mark.parametrize("path", [
    "web/src/outline/edits.ts",
    "web/src/views/Journal.tsx",
    "web/src/styles.css",
    "web/src/App.test.tsx",
    "web/tooling/fcis.mjs",
    "web/e2e/outline.spec.ts",
    "server/src/pkm/batch.py",
    "server/tests/test_ws.py",
    "server/tooling/perfcheck/run.py",
    "perf/check.sh",
    "proptest/check.sh",
    "docs/architecture/backend.md",
])
def test_source_and_architecture_docs_are_scanned(path):
    assert is_scanned(path)


@pytest.mark.parametrize("path", [
    "AGENTS.md",
    "docs/troubleshooting.md",
    "docs/superpowers/specs/2026-07-12-offline-editing-design.md",
    "web/src/api/types.d.ts",
    "web/src/api/openapi.json",
    "web/src/replica/baseSchema.gen.ts",
    "web/tooling/perf/baselines/2026-09-02-ikk0/report.md",
    "web/tooling/perf/budgets.json",
    ".beans/pkm-rfkp--comment-rot-lint.md",
    "web/src/assets/logo.svg",
])
def test_history_generated_and_unrelated_files_are_not(path):
    assert not is_scanned(path)


# -- what counts as a comment
# ---------------------------------------------------

def spans(text, ext):
    return [(line, comment) for line, comment in comment_spans(text, ext)]


def test_python_hash_comment_is_the_rest_of_the_line():
    assert spans("x = 1  # the reason\n", ".py") == [(1, " the reason")]


def test_python_hash_inside_a_string_is_not_a_comment():
    assert spans('check("# not a comment")\n', ".py") == []


# A literal triple quote in this file would be read as a docstring by the
# lint when it scans this test, so the fixtures spell it out.
Q = '"' * 3


def test_python_docstring_lines_are_comments():
    text = f'def f():\n    {Q}One line.\n\n    Second para.\n    {Q}\n    return 1\n'
    assert spans(text, ".py") == [(2, "One line."), (4, "    Second para.")]


def test_python_single_line_docstring_is_a_comment():
    assert spans(f'{Q}Module doc.{Q}\nx = 1\n', ".py") == [(1, 'Module doc.')]


def test_python_assigned_triple_quoted_string_is_data_not_a_comment():
    assert spans(f'DDL = {Q}\nCREATE TABLE t (x);\n{Q}\n# real\n', ".py") == [(4, " real")]


def test_shell_hash_comments_are_comments():
    assert spans("#!/bin/sh\necho hi # trailing\n", ".sh") == [(1, "!/bin/sh"), (2, " trailing")]


def test_ts_line_comment_is_the_rest_of_the_line():
    assert spans("const a = 1; // why\n", ".ts") == [(1, " why")]


def test_ts_url_in_a_string_is_not_a_comment():
    assert spans('fetch("https://example.org/x");\n', ".ts") == []


def test_ts_block_opener_inside_a_string_opens_nothing():
    text = '<Route path="/page/*" />\nconst a = 1; // why\nconst b = \'/*\'; /* real */\n'
    assert spans(text, ".ts") == [(2, " why"), (3, " real ")]


def test_ts_template_literal_spans_lines_and_hides_comment_markers():
    text = "const sql = `\n  -- not // a comment /* either\n`;\n// after\n"
    assert spans(text, ".ts") == [(4, " after")]


def test_ts_escaped_quote_does_not_end_the_string():
    assert spans('const s = "a \\" // b"; // c\n', ".ts") == [(1, " c")]


def test_ts_block_comment_spans_lines():
    text = "/** First\n * second\n */\nconst a = 1; /* inline */ const b = 2;\n"
    assert spans(text, ".ts") == [(1, "* First"), (2, " * second"), (4, " inline ")]


def test_css_block_comments_are_comments():
    assert spans("a { color: red; } /* why */\n/* --- section --- */\n", ".css") == [
        (1, " why "), (2, " --- section --- ")]


def test_markdown_is_prose_throughout():
    assert spans("# Title\n\nBody line.\n", ".md") == [(1, "# Title"), (3, "Body line.")]


# -- the three rules
# ------------------------------------------------------------

def rules_hit(text, path="web/src/x.ts"):
    return [v.rule for v in check_text(path, text)]


def test_rule_names_are_stable():
    assert set(RULES) == {"bean-id", "line-number", "orphan-pointer", "line-length"}


@pytest.mark.parametrize("comment", [
    "// fixed in pkm-ab12",
    "// (pkm-rfkp) the guard",
    "/* see pkm-thee */",
])
def test_bean_id_in_a_comment(comment):
    assert rules_hit(comment) == ["bean-id"]


@pytest.mark.parametrize("comment", [
    "// cache lives in ~/.cache/pkm-perf/worktrees",
    "// fixture pkm-2026-07-09.sqlite3",
    "// docs/superpowers/specs/2026-07-26-pkm-wn2s-assistant-design.md",
    "// the pkm-worklog",
])
def test_bean_id_shaped_paths_and_names_are_not(comment):
    assert rules_hit(comment) == []


def test_bean_id_in_code_is_not_a_comment():
    assert rules_hit('const id = "pkm-ab12";') == []


def test_bean_id_in_architecture_prose():
    assert rules_hit("Fixed by pkm-ab12.", "docs/architecture/backend.md") == ["bean-id"]


@pytest.mark.parametrize("comment", [
    "// the subtree-move (line 177 below)",
    "// line-wise selection (line ~187)",
    "// see lines 40-50",
    "/* same as .block-menu (styles.css ~line 855) */",
    "// probed via the real handler (App.tsx:59)",
    "/** mirrors `workerHandlers.ts:63` */",
])
def test_line_number_reference(comment):
    assert rules_hit(comment) == ["line-number"]


def test_line_number_reference_in_python():
    assert rules_hit("# see ops_core.py:120", "server/src/pkm/x.py") == ["line-number"]


@pytest.mark.parametrize("comment", [
    "// the first visual line of a soft-wrapped textarea",
    "// coverage: branches 91 / functions 89 / lines 95",
    "// a line-wise selection",
    "// timeline 2026",
    "// port 8975",
])
def test_line_prose_without_a_position_is_not(comment):
    assert rules_hit(comment) == []


def test_line_number_in_a_string_is_not_a_comment():
    assert rules_hit('throw new Error("Parse error on line 1");') == []


@pytest.mark.parametrize("comment", [
    "// Feed application (spec section 3)",
    "// resync (spec sections 3/6)",
    "// guard (spec §6)",
    "// the moved block (plan-3 contract note)",
    "/* --- plan 5: sync --- */",
    "/* --- plan 6/7: drag-and-drop --- */",
    "// per the spec this never throws",
    "// see the plan for the ordering",
    "// the design doc says otherwise",
])
def test_orphan_pointer(comment):
    assert rules_hit(comment) == ["orphan-pointer"]


@pytest.mark.parametrize("comment", [
    "// Feed application (docs/superpowers/specs/2026-07-12-offline-editing-design.md §3)",
    "// per the spec (docs/architecture/sync-and-offline.md#feed)",
    "// Feed application (offline-editing-design.md §3)",
])
def test_pointer_with_a_path_or_md_filename_is_not(comment):
    assert "orphan-pointer" not in rules_hit(comment)


@pytest.mark.parametrize("comment", [
    "# the spec is treated as missing when no level matches",
    "# `resolve_parent` would reject the spec",
    "// Playwright spec files share one server",
    "// the planner plans the move",
    "// a 3-step plan",
])
def test_spec_and_plan_as_domain_words_are_not(comment):
    assert rules_hit(comment, "server/src/pkm/batch.py") == []


def test_python_docstring_pointer_is_caught():
    text = f'class Push:\n    {Q}Durable push path (spec section 1): an\n    idempotent batch.{Q}\n'
    assert check_text("server/src/pkm/contracts/ops.py", text) == [
        Violation("server/src/pkm/contracts/ops.py", 2, "orphan-pointer",
                  "Durable push path (spec section 1): an")]


def test_violation_carries_the_stripped_comment_text():
    [v] = check_text("web/src/a.ts", "const a = 1;\n\n  // fixed in pkm-ab12\n")
    assert v == Violation("web/src/a.ts", 3, "bean-id", "fixed in pkm-ab12")


def test_one_line_can_break_several_rules():
    assert rules_hit("// pkm-ab12 moved this to line 40") == ["bean-id", "line-number"]


def test_unscanned_path_has_no_violations():
    assert check_text("docs/troubleshooting.md", "row for pkm-ab12 (line 3)") == []


# -- line length
# ------------------------------------------------------------------

def test_a_comment_line_wraps_at_80():
    assert rules_hit("// " + "x" * 77) == []
    assert rules_hit("// " + "x" * 78) == ["line-length"]


def test_a_code_line_wraps_at_120():
    assert rules_hit("const a = '" + "x" * 107 + "';") == []
    assert rules_hit("const a = '" + "x" * 108 + "';") == ["line-length"]


def test_code_with_a_trailing_comment_is_a_code_line():
    assert rules_hit("const a = 1; // " + "why " * 22) == []


def test_block_and_docstring_interiors_are_comment_lines():
    assert rules_hit("/**\n * " + "x" * 78 + "\n */") == ["line-length"]
    assert rules_hit(f"def f():\n    {Q}\n    " + "x" * 77 + f"\n    {Q}\n", "server/src/pkm/x.py") == ["line-length"]


def test_an_assigned_triple_quoted_string_is_code():
    assert rules_hit(f"DDL = {Q}\n" + "x" * 100 + f"\n{Q}\n", "server/src/pkm/x.py") == []


def test_markdown_lines_are_exempt():
    assert rules_hit("| " + "x" * 200 + " |", "docs/architecture/backend.md") == []


@pytest.mark.parametrize("line", [
    "// https://example.org/" + "x" * 80 + "  noqa: E501",
    "const a = '" + "x" * 120 + "'; // noqa: E501",
    "    # " + "x" * 90 + "  # noqa: E501",
])
def test_noqa_e501_exempts_the_line(line):
    assert rules_hit(line, "server/src/pkm/x.py" if line.lstrip().startswith("#") else "web/src/x.ts") == []


def test_line_length_violation_carries_the_whole_line():
    [v] = check_text("web/src/a.ts", "  // " + "y" * 90 + "\n")
    assert v.rule == "line-length" and v.text == "// " + "y" * 90


# -- the report
# -----------------------------------------------------------------

def test_report_names_each_site_and_the_remedy_once_per_rule():
    report = format_report([
        Violation("web/src/a.ts", 3, "bean-id", "fixed in pkm-ab12"),
        Violation("web/src/a.ts", 9, "bean-id", "pkm-cd34 again"),
        Violation("server/src/pkm/b.py", 2, "line-number", "see b.py:40"),
    ])
    assert "web/src/a.ts:3: bean-id: fixed in pkm-ab12" in report
    assert "web/src/a.ts:9: bean-id: pkm-cd34 again" in report
    assert "server/src/pkm/b.py:2: line-number: see b.py:40" in report
    assert report.count(RULES["bean-id"]) == 1
    assert report.count(RULES["line-number"]) == 1
    assert RULES["orphan-pointer"] not in report
    assert "--no-verify" in report


def test_empty_report_is_empty():
    assert format_report([]) == ""
