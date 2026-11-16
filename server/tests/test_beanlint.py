import pytest

from beanlint.core import check_text, is_scanned

BEAN = ".beans/pkm-ab12--a-bean.md"

BAD = [
    "Full evidence: docs/superpowers/handoffs/2026-10-25-research.md.\n",
    "Probe: /Users/me/pkm/docs/superpowers/handoffs/probes/p1.py\n",
    "Reports live in the gitignored handoffs directory.\n",
    "See handoffs/2026-11-05-perf.md for the design.\n",
]
GOOD = [
    "The fix keeps the frozen row and marks it stale.\n",
    "## Handover (2026-08-04, end of session)\n",
    "Legacy queue missed-kick handoff and offline guards.\n",
    "Task 3: full verification, review, and bean handoff\n",
]


@pytest.mark.parametrize("text", BAD)
def test_a_pointer_to_a_handover_note_is_flagged(text: str):
    [v] = check_text(BEAN, "---\ntitle: x\n---\n\n" + text)
    assert (v.path, v.line, v.rule) == (BEAN, 5, "bean-handover")


@pytest.mark.parametrize("text", GOOD)
def test_prose_about_handovers_is_not_a_pointer(text: str):
    assert check_text(BEAN, text) == []


def test_only_bean_files_are_read():
    assert is_scanned(BEAN)
    assert not is_scanned("docs/superpowers/plans/2026-10-24-x.md")
    assert not is_scanned(".beans.yml")
    assert not is_scanned(".beans/archive/notes.txt")
    assert check_text("docs/superpowers/plans/x.md", "docs/superpowers/handoffs/a.md\n") == []
