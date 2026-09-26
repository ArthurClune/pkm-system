# pattern: Functional Core
"""A deterministic, prod-shaped graph for the perf checks, as op batches.

Shaped after prod on 2026-09-26 (~56k blocks, 4.4k pages, largest page
1,222 blocks). Pure: same (seed, scale) gives an identical Fixture, so the
counts measured against it are comparable across commits. The hash of this
file's source is the baseline's `fixture_hash` -- editing it invalidates
every baseline, so change it deliberately and rebaseline."""
from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from pkm.contracts.daily import title_for_date

FROZEN_NOW = datetime(2026, 6, 15, 12, 0, tzinfo=ZoneInfo("Europe/London"))
FROZEN_NOW_MS = int(FROZEN_NOW.timestamp() * 1000)
FROZEN_TODAY = FROZEN_NOW.date()

BIG_PAGE = "Perf Big Page"
HUBS = ("Hub Alpha", "Hub Beta", "Hub Gamma", "Hub Delta", "Hub Epsilon")
COMMON_TERM = "project"
RARE_TERM = "zyxquark"
PREFIX_TERM = "synchro"
PHRASE = "quantum lattice"

BATCH_OPS = 400
DAY_MS = 86_400_000

_SYLLABLES = ("ka", "lo", "mi", "ren", "sa", "tor", "vel", "qui", "dan", "ber",
              "nel", "pho", "stra", "gen", "ul", "ix", "mor", "tal", "shi", "e")
# Head of the Zipf distribution: real words so search has meaningful common
# hits; the synchro* family exists for the prefix scenario.
_HEAD = (COMMON_TERM, "meeting", "notes", "idea", "review", "draft", "reading",
         "question", "follow", "design", "synchronise", "synchrony", "synchrotron")


@dataclass(frozen=True)
class Batch:
    now_ms: int
    ops: tuple[dict, ...]


@dataclass(frozen=True)
class AssetRow:
    sha256: str
    filename: str
    mime: str
    size: int
    created_at: int
    description: str | None


@dataclass(frozen=True)
class Landmarks:
    big_page: str
    hub: str
    journal_day: str
    popular_uid: str
    ref_uids: tuple[str, ...]
    move_uid: str
    edit_uid: str


@dataclass(frozen=True)
class Fixture:
    batches: tuple[Batch, ...]
    assets: tuple[AssetRow, ...]
    sidebar: tuple[str, ...]
    landmarks: Landmarks


class _Gen:
    def __init__(self, seed: int, scale: float) -> None:
        self.rng = random.Random(seed)
        self.scale = scale
        self.n = 0
        rng = random.Random(seed + 7919)
        tail = sorted({"".join(rng.choice(_SYLLABLES) for _ in range(rng.randint(2, 3)))
                       for _ in range(600)})
        self.vocab = list(_HEAD) + tail
        self.weights = [1.0 / (i + 1) ** 1.1 for i in range(len(self.vocab))]
        self.topics = [f"Topic {i:04d}" for i in range(max(20, round(4000 * scale)))]
        self.all_uids: list[str] = []
        self.popular: list[str] = []
        self.creates: list[tuple[int, dict]] = []  # (now_ms, op)
        self.edits: list[tuple[int, dict]] = []

    def uid(self) -> str:
        self.n += 1
        return f"f{self.n:011d}"

    def words(self, k: int) -> str:
        return " ".join(self.rng.choices(self.vocab, self.weights, k=k))

    def text(self) -> str:
        r = self.rng.random
        parts = [self.words(self.rng.randint(4, 18))]
        if r() < 0.08:
            parts.append(f"[[{self.rng.choice(self.topics)}]]")
        if r() < 0.032:
            parts.append(f"[[{self.rng.choice(HUBS)}]]")
        if r() < 0.01:
            parts.append(f"see {self.rng.choice(HUBS)} for context")  # unlinked mention
        if r() < 0.04:
            parts.append(f"#tag{self.rng.randint(0, 19)}")
        if r() < 0.02 and self.popular:
            parts.append(f"(({self.rng.choice(self.popular)}))")
        body = " ".join(parts)
        roll = r()
        if roll < 0.03:
            return "{{[[TODO]]}} " + body
        if roll < 0.05:
            return "{{[[DONE]]}} " + body
        return body

    def page(self, title: str, count: int, now_ms: int, special: list[str] | None = None) -> list[str]:
        """Create `count` blocks on `title`, nesting some under the previous
        block (depth <= 4). Returns the uids in creation order."""
        stack: list[tuple[str, int]] = []   # (uid, depth) path to the last block
        next_idx: dict[str | None, int] = {}
        uids: list[str] = []
        texts = list(special or [])
        for i in range(count):
            if stack and self.rng.random() < 0.35 and stack[-1][1] < 4:
                parent, depth = stack[-1][0], stack[-1][1] + 1
            else:
                while stack and self.rng.random() < 0.5:
                    stack.pop()
                parent = stack[-1][0] if stack else None
                depth = stack[-1][1] + 1 if stack else 0
            idx = next_idx.get(parent, 0)
            next_idx[parent] = idx + 1
            uid = self.uid()
            text = texts[i] if i < len(texts) else self.text()
            self.creates.append((now_ms, {"op": "create", "uid": uid, "page_title": title,
                                          "parent_uid": parent, "order_idx": idx, "text": text}))
            while stack and stack[-1][1] >= depth:
                stack.pop()
            stack.append((uid, depth))
            uids.append(uid)
            self.all_uids.append(uid)
        return uids


def generate(seed: int = 1, scale: float = 1.0) -> Fixture:
    g = _Gen(seed, scale)
    year_start = FROZEN_NOW_MS - 365 * DAY_MS

    # Blocks that attract ((refs)): created first so later text can cite them.
    seed_uids = g.page("Reference Library", max(10, round(50 * scale)), year_start)
    g.popular = seed_uids
    popular_uid = seed_uids[0]
    # Weight the first seed block heavily so one block has many backlinks.
    g.popular = [popular_uid] * len(seed_uids) + seed_uids

    for hub in HUBS:
        g.page(hub, max(5, round(40 * scale)), year_start)

    big_special = [
        "```mermaid\ngraph TD\n  A-->B\n  B-->C\n```",
        "$$\\int_0^1 x^2\\,dx = \\tfrac13$$",
        "```python\nprint('perf')\n```",
        "```js\nconsole.log('perf')\n```",
    ]
    big_count = 1200 if scale >= 1.0 else max(50, round(1200 * scale))
    big_uids = g.page(BIG_PAGE, big_count, year_start + DAY_MS, big_special)

    n_days = max(8, round(365 * scale))
    journal_titles = []
    for d in range(n_days):
        day = FROZEN_TODAY - timedelta(days=n_days - 1 - d)
        noon = FROZEN_NOW_MS - (n_days - 1 - d) * DAY_MS
        title = title_for_date(day)
        journal_titles.append(title)
        g.page(title, g.rng.randint(4, 16), noon)

    target = round(50_000 * scale)
    remaining = max(0, target - len(g.all_uids))
    sizes = [min(400, max(1, int(g.rng.paretovariate(1.6) * 4))) for _ in g.topics]
    total = sum(sizes)
    sizes = [max(1, round(s * remaining / total)) for s in sizes]
    for i, (topic, size) in enumerate(zip(g.topics, sizes)):
        when = year_start + (i * 365 * DAY_MS) // len(g.topics)
        g.page(topic, size, when)

    # Plant exact-count search terms into existing creates (deterministic spots).
    rare_spots = g.rng.sample(range(len(g.creates)), 3)
    phrase_spots = g.rng.sample([i for i in range(len(g.creates)) if i not in rare_spots], 12)
    for i in rare_spots:
        g.creates[i][1]["text"] += f" {RARE_TERM}"
    for i in phrase_spots:
        g.creates[i][1]["text"] += f" {PHRASE}"

    # Later edits so /api/changed sees "edited" as well as "new" blocks.
    # An edit must land strictly after its block's create batch.
    created_at = {op["uid"]: when for when, op in g.creates}
    for uid in g.rng.sample(g.all_uids, max(5, len(g.all_uids) // 20)):
        when = FROZEN_NOW_MS - g.rng.randint(1, 30) * DAY_MS
        if when <= created_at[uid]:
            lo, hi = created_at[uid] + DAY_MS, FROZEN_NOW_MS - DAY_MS
            if lo > hi:
                continue
            when = g.rng.randint(lo, hi)
        g.edits.append((when, {"op": "update_text", "uid": uid, "text": g.text() + " (edited)"}))

    timed = sorted(g.creates + g.edits, key=lambda t: t[0])  # stable: page order kept
    batches: list[Batch] = []
    current: list[dict] = []
    current_ms = timed[0][0]
    for when, op in timed:
        if current and (when != current_ms or len(current) == BATCH_OPS):
            batches.append(Batch(current_ms, tuple(current)))
            current = []
        current_ms = when
        current.append(op)
    batches.append(Batch(current_ms, tuple(current)))

    assets = tuple(
        AssetRow(sha256=hashlib.sha256(f"perf-asset-{i}".encode()).hexdigest(),
                 filename=f"{'diagram' if i % 3 == 0 else 'scan'}-{i:03d}.{'png' if i % 2 else 'pdf'}",
                 mime="image/png" if i % 2 else "application/pdf",
                 size=10_000 + i * 97,
                 created_at=year_start + i * DAY_MS,
                 description=f"a diagram of {g.words(5)}" if i % 4 else None)
        for i in range(max(10, round(200 * scale))))

    move_uid = next(op["parent_uid"] for _, op in g.creates
                    if op["page_title"] == BIG_PAGE and op["parent_uid"] is not None)
    landmarks = Landmarks(
        big_page=BIG_PAGE, hub=HUBS[0], journal_day=journal_titles[-4],
        popular_uid=popular_uid, ref_uids=tuple(g.rng.sample(g.all_uids, 30)),
        move_uid=move_uid, edit_uid=big_uids[10])
    sidebar = (BIG_PAGE, *HUBS, *g.topics[:4])
    return Fixture(tuple(batches), assets, sidebar, landmarks)
