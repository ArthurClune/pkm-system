# Strict pydantic models: pyrefly checks every model constructor

Bean: pkm-aa5q.

## Why

pyrefly models pydantic's lax mode. A model field accepts anything pydantic
would coerce at runtime, so `CreateOp(page_title=some_str)` type-checks
although the field is `RawTitle`, and an `int` field accepts
`Decimal | bool | bytes | float | int | str`. A brand on a model field
protects the field's readers but not its producers. `backend.md` documents
the gap ("None of this guards a pydantic model's constructor").

Under `ConfigDict(strict=True)`, inherited or not, pyrefly checks a
constructor against the declared field types. `Field(strict=False)` turns
the check back off for that field.

## Decision (Arthur, 2026-10-20)

Model-wide strict mode, not per-field strict. Every pydantic model
validates strictly, so pyrefly checks every constructor against every field,
branded or not. The shape is a shared strict base plus a brandlint rule
that requires it.

## What a trial found

A throwaway spike on `49e4ef31` moved all 89 `BaseModel` subclasses in
`server/src` onto a strict base (101 models counting indirect subclasses).
pydantic merges a subclass's `model_config` with its parent's, so
`batch._Strict` and the `ConfigDict(extra="forbid", frozen=True)` models
keep their settings and gain `strict`.

| Measure | Lax | Strict |
|---|---|---|
| pyrefly errors in `server/src` | 0 | 3 |
| pyrefly errors in `server/tests` | 0 | 229, all literals into brand fields |
| pytest failures | 0 | 30, one cause (below) |
| request-body fields that reject what today's clients send | - | 0 |
| request-body fields that now reject non-canonical JSON | - | 8, plus the 2 `batch` `index` fields |

The three `server/src` errors:

| Site | Error |
|---|---|
| `planning.py:_create` | `parent: str \| None` into `CreateOp.parent_uid: BlockUid \| None`, a real unbranded producer |
| `routes_sync.py:sync_changes` | `ChangesPayload(next_since=0)` into a `SyncSeq`; `NO_SEQ` is the named value |
| `client/api.py:PkmClient.post_ops` | `OpBatch(ops=list(ops))` where `ops` may hold raw mappings; valid at runtime, because strict still accepts a dict for a nested model |

Runtime facts the design rests on (all probed):

- FastAPI 0.139 decodes a request body with `json.loads` and validates in
  pydantic's Python mode. It has no switch to JSON mode.
- Strict Python mode rejects a list for a `tuple`, `"1"`, `1.0` or `true`
  for an `int`, and `0`/`1` for a `bool`. JSON mode (`model_validate_json`)
  still allows a list for a tuple.
- No request-body field is a tuple, set, float, enum, datetime, UUID or
  Decimal. Response models are built from `pkm.rows.Row` values, which are
  already typed; the one bool from SQLite (`BlockNode.collapsed`) is
  converted in `tree.build_tree`.
- The stored `OpsAck` replays (`routes_ops.post_ops` in JSON mode,
  `routes_sync._applied_batches` in Python mode) validate under strict,
  old ack shape included.
- The 30 test failures are `test_data.core.GraphSource` and `PageSource`:
  three `tuple[...]` fields validated from `json.loads` output.
- `Field(gt=0)` on a brand field is a pyrefly error in lax mode too: write
  the bound as the brand (`ge=SyncSeq(0)`, as `OpBatch.seen_seq` already
  does). The only constrained brand field in the tree is that one.

## Design

### The base

One base class, `StrictModel`, whose `model_config` is
`ConfigDict(strict=True)`. Every pydantic model inherits it, directly or
through another model. That covers `server/src`, `server/tooling` (the four
bodies in `proptest/sync_server.py`) and the models in `server/tests`, the
same scope as the brand rules. Code that agents copy from gets no
exemption.

### The lint rule

A new brandlint rule, reported like the others and covered by the same
hook, sweep and pytest run. It fails when:

| Site | Example |
|---|---|
| a class lists `BaseModel` (any import spelling) among its bases, other than `StrictModel` itself | `class X(BaseModel)` |
| `strict=False` is passed to anything | `Field(strict=False)`, `ConfigDict(strict=False)`, `X.model_validate(d, strict=False)` |
| a model is made without a class statement | `create_model(...)` |
| a model is validated from a dict built in place | `X.model_validate({...})`, `X.model_validate({k: v for ...})`, `X.model_validate(dict(...))` |
| a model is copied with field updates | `x.model_copy(update={...})` |
| a pydantic dataclass or validated function is declared | `@pydantic.dataclasses.dataclass`, `@validate_call` |

Subclasses of a model inherit its config, so the rule only needs the
direct `BaseModel` bases. `model_copy(update=...)` skips validation and
pyrefly does not check the update dict, the same hole as `model_construct`,
which brandlint already bans. Pydantic dataclasses and `validate_call` do
not exist in the tree today; the rows stop one arriving unchecked.
(The last three rows are my call, from the builder check.) The rule has no opt-out: the trial found no site
that needs one. `strict=False` is banned outright because a lax field is
unchecked at construction, which is the hole this work closes.

Teeth: a test per row that the rule reports it, and that a strict model
passes.

The rule covers tests and tooling like `server/src`. About 20 test and
tooling sites validate a dict literal today. Most build fixtures and
become keyword constructors. The few that test decoding itself (in
`test_brands.py`) decode JSON text with `model_validate_json`, which is
what a wire decode is. A request-body rejection is pinned through the
route, since FastAPI validates in Python mode. (My call.)

The four `model_copy(update=...)` sites in `server/src` (`render.clip_depth`,
`ops_core`, two in `cli/main.py`) become keyword constructors.

### Producers

Fix every error pyrefly reports once the base is in. In `server/src` that
is the three sites above, plus whatever the dict-built conversions
(below) surface. In tests it is 229 literals, most of them
`BlockUid` and `OrderIdx` values passed to op constructors; they go through
the `pkm.test_data.ids` helpers like any other test literal.

### Runtime changes, each pinned by a test

| Surface | Change | Pin |
|---|---|---|
| `test_data` graph source | must validate under strict | the existing tests, green with no `strict=False` |
| the 8 request fields (`seen_seq`, both `order_idx`, `order` items; `collapsed`, `allow_merge`, `save`, `allow`) | `"1"`, `1.0`, `true` for an int and `0`/`1` for a bool now get a 422 | one route test for an int field and one for a bool field |
| `pkm batch` / MCP `batch` `index` | `1.0`, `"2"` and `true` are now refused with the usual batch error | one batch test |
| stored `OpsAck` replay | still validates, old shape included | a test if none pins the old shape |

Accepted: a client sending non-canonical numbers or bools gets a 422. The
web client and `PkmClient` send canonical JSON (checked by reading the
code), and the full e2e run confirms it.

### Generated artifacts

Strict mode should not change the OpenAPI schema. Regenerate
`web/src/api/openapi.json` per the generated artifacts table in
`backend.md` and confirm the diff is empty. If it is not, follow the table.

### Dict-built response models (Arthur, 2026-10-20: in scope)

Strict mode does nothing for `Model.model_validate({...})`: pyrefly does
not check a dict literal field by field. Eleven response sites build their
payload this way, in `routes_search`, `routes_pages` and
`routes_migrations`. They are the main reason the trial found only three
errors in `server/src`. Each passes a dict literal directly.

Each becomes a keyword constructor, and the lint rule gains a fourth row:
`model_validate` with a dict literal or dict comprehension argument. A
converted site's nested values must be models, not the TypedDicts
(`tree.TreeNode`, `grouping.PageGroup`, ...) they are today, because
pyrefly flags a dict for a nested model field. So the sweep reaches into
those builders: they produce models, or the route maps their output into
models at the boundary. `tree.build_tree` and the `grouping` builders are
on hot read paths, so the branch runs `perf/check.sh backend`, and a
regression is investigated like any other.

## Non-goals

- Switching FastAPI request validation to JSON mode.
- FastAPI's generated form-body models (`Body_upload_asset_...`); FastAPI
  builds them, and they have no brand fields.
- The argument models the MCP library builds from tool signatures. They
  stay lax, so `search(limit="20")` still validates while the `batch`
  tool's `index` refuses `"2"`. (My call.)
- A `TypeAdapter` of a non-model type. The one adapter today wraps a
  union of models, which bring their own strict config.
- `Literal[1, 2, 3]` accepting `true` and `2.0` (a `HeadingLevel` given
  `true` becomes `1`). Strict mode does not change this, and it predates
  this work.
- The web side, which has no pydantic.

## Anti-goals

- A per-field or per-call `strict=False` escape. It reopens the gap for
  that field, silently, which is worse than the lax default because it
  looks covered.
- Weakening a type to make a producer pass (`str` where the brand was).
  The producer gets fixed.

## Left to the builder

- The module and name of the base (`StrictModel` is a placeholder).
- How `GraphSource` validates its tuples: list fields, or decoding the
  source text with `model_validate_json`. Not `strict=False`.
- How `PkmClient.post_ops` types raw mappings.
- The rule's id and wording, and its row in `enforced-checks.md`.

## Docs

- `backend.md`: replace the "None of this guards a pydantic model's
  constructor" paragraph with the strict-base invariant.
- `enforced-checks.md`: the rule's row in the brand rules table.
