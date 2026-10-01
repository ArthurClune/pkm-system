# x-brand gen-types Implementation Plan (pkm-85x3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a server `NewType` tagged with `brand()` reaches `web/src/api/types.d.ts` as a reference to a hand-written TS brand, proven end to end on `Sha256Hex`.

**Architecture:**
1. `brand(nt)` attaches pydantic hooks that add `"x-brand": <name>` to the JSON schema and leave validation unchanged.
2. `pnpm gen-types` becomes a Node script around openapi-typescript's API. Its `transform` turns a marked schema into `Brands.<name>`, and its `inject` imports `./brands`.
3. `web/src/api/brands.ts` is the one place each brand is defined.

**Tech Stack:** Python 3 + pydantic v2 + FastAPI; pyrefly; Node ESM, openapi-typescript 7.13 (Node API), TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-x-brand-gen-types-design.md`

## Global Constraints

- Start after pkm-38w9 has merged to main. Branch from local main: `git worktree add .claude/worktrees/pkm-85x3 -b feat/pkm-85x3-x-brand main`.
- Pydantic validation, field constraints and serialisation stay unchanged.
- `openapi.json` remains the contract. Regenerate with `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`, then `cd web && pnpm gen-types`.
- The work ends with pyrefly, ruff and tsc reporting 0 errors and no new ignore or suppression comments. Negative type checks live only in web `@ts-expect-error` probes.
- Brand shape: `string & { readonly __brand: "<Name>" }`. A subtype brand adds a second key, for example `& { readonly __canonical: true }`.
- FCIS: `contracts/brands.py` is a Functional Core module. In `web/tooling/`, the pure transform and the I/O shell go in separate files, following `fcis-core.mjs`/`fcis.mjs`.
- Code and test comments carry no bean ids.
- Deviation from the spec: the generator lives in `web/tooling/` (where `fcis.mjs` and `runPlaywright.mjs` already are), not in a new `web/scripts/`.

## Review Focus

1. **An `x-brand` reached through `$ref`.** openapi-typescript must not emit a brand for a component reference. It should emit a brand only where the marker sits on the schema object. Task 2 tests this with a component schema referenced through `$ref`.
2. **A nullable branded field.** `X | None` produces `anyOf: [{type: string, x-brand}, {type: null}]`. The output must be `Brands.X | null`, not `string | null`. Task 2 tests this.
3. **A branded list.** `list[X]` puts the marker on `items`. The output must be `Brands.X[]`. Task 2 tests this.
4. **A marker that `brands.ts` doesn't export.** tsc must fail on it, not fall back to `any`. Task 3 checks this by hand once, as a verify step.
5. **Request vs response schemas.** FastAPI can split a model into `-Input` and `-Output` schemas. Both must carry the brand. Task 4's server test checks the dumped `UpdateTextOp` wherever it appears.

---

### Task 1: Server `brand()` helper

**Files:**
- Create: `server/src/pkm/contracts/brands.py`
- Test: `server/tests/test_brands.py`

**Interfaces:**
- Produces: `brand(nt: object) -> None`, which reads `nt.__name__` and `nt.__supertype__` and sets `__get_pydantic_core_schema__` and `__get_pydantic_json_schema__` on `nt`. Use it in its own statement after the `NewType(...)` line; never wrap the `NewType` call in it.

- [ ] **Step 1: Write the failing tests** in `test_brands.py`. Define `Tagged = NewType("Tagged", str)`, `brand(Tagged)` and `TaggedInt = NewType("TaggedInt", int)`, `brand(TaggedInt)` at module scope, and a model:
  ```python
  class M(BaseModel):
      h: Tagged | None = Field(default=None, min_length=4, max_length=4)
      xs: list[Tagged] = []
      n: TaggedInt
  ```
  The tests:
  - `test_schema_carries_brand_beside_constraints`: `M.model_json_schema()["properties"]["h"]["anyOf"][0] == {"type": "string", "minLength": 4, "maxLength": 4, "x-brand": "Tagged"}`; `["xs"]["items"]["x-brand"] == "Tagged"`; `["n"] == {"title": "N", "type": "integer", "x-brand": "TaggedInt"}`.
  - `test_validation_unchanged`: `M(h="abc", n=1)` raises a `ValidationError` whose type is `string_too_short`; `M(n="x")` raises `int_parsing`; `M(h="abcd", xs=["q"], n="2").model_dump() == {"h": "abcd", "xs": ["q"], "n": 2}`.
  - `test_brand_name_is_newtype_name`: an unbranded `NewType` model field has no `x-brand` key.
- [ ] **Step 2:** `cd server && uv run pytest tests/test_brands.py -q`. Expect a FAIL with `ModuleNotFoundError: pkm.contracts.brands`.
- [ ] **Step 3: Implement `brand`.** The core hook is `lambda source, handler: handler(nt.__supertype__)`. The JSON hook calls `handler(core_schema)`, sets `"x-brand"` and returns the result. Add the `# pattern: Functional Core` header and a docstring stating the rule: a separate statement, because pyrefly loses the `NewType` when its call is wrapped.
- [ ] **Step 4:** Run `uv run pytest tests/test_brands.py -q && uv run pyrefly check && uv run ruff check`. Expect a PASS and 0 errors.
- [ ] **Step 5:** Commit: `feat(pkm-85x3): brand() tags a NewType with an x-brand schema marker`.

### Task 2: Generator transform (pure)

**Files:**
- Create: `web/tooling/genTypes-core.mjs`
- Test: `web/tooling/genTypes-core.test.ts`

**Interfaces:**
- Produces:
  - `brandTransform(schemaObject) -> ts.TypeNode | undefined`, the openapi-typescript `transform` option;
  - `BRANDS_IMPORT`, the `inject` string `import type * as Brands from "./brands";`;
  - `generateTypes(spec: object) -> Promise<string>`, which calls `openapiTS(spec, { transform: brandTransform, inject: BRANDS_IMPORT })` and returns `astToString(...)`.
- `brandTransform` throws `Error("x-brand <value>: …")` in two cases: the value doesn't match `/^[A-Z][A-Za-z0-9]*$/`, or `schemaObject.type` isn't `"string"` or `"integer"`.

- [ ] **Step 1: Write the failing tests.** Each feeds `generateTypes` a minimal OpenAPI 3.1 document with one component schema `T`:
  - `brands a marked string`: property `{type: "string", "x-brand": "Sha256Hex"}`. Output contains `p: Brands.Sha256Hex` and starts with `BRANDS_IMPORT`.
  - `brands the non-null branch of a nullable`: the property is `anyOf: [{type: "string", "x-brand": "Sha256Hex"}, {type: "null"}]`. Output contains `Brands.Sha256Hex | null`.
  - `brands list items`: `{type: "array", items: {type: "integer", "x-brand": "PageId"}}`. Output contains `Brands.PageId[]`.
  - `leaves unmarked schemas alone`: output for `{type: "string"}` contains `p: string` and nothing that matches `Brands\.`.
  - `a $ref to a marked component stays a ref`: component `H = {type: "string", "x-brand": "Sha256Hex"}` and a property `{$ref: "#/components/schemas/H"}`. The property type is `components["schemas"]["H"]`, and `H` itself is `Brands.Sha256Hex`.
  - `rejects a malformed marker`: `"x-brand": "not ok"` rejects with `/x-brand/`; `{type: "boolean", "x-brand": "Flag"}` rejects with `/x-brand/`.
- [ ] **Step 2:** `cd web && pnpm vitest run tooling/genTypes-core.test.ts`. Expect a FAIL because the module isn't found.
- [ ] **Step 3: Implement `genTypes-core.mjs`.** Add the `// pattern: Functional Core` header. Build the reference with `ts.factory.createTypeReferenceNode(ts.factory.createQualifiedName(ts.factory.createIdentifier("Brands"), name))`, using the `typescript` package that the repo already depends on.
- [ ] **Step 4:** Re-run the test (expect a PASS) and `pnpm lint`.
- [ ] **Step 5:** Commit: `feat(pkm-85x3): gen-types transform maps x-brand to Brands.<name>`.

### Task 3: Generator shell, `api/brands.ts`, and the `gen-types` script

**Files:**
- Create: `web/tooling/genTypes.mjs` (with the `// pattern: Imperative Shell` header). It reads `src/api/openapi.json`, awaits `generateTypes`, and writes `src/api/types.d.ts`. On a thrown error it prints the message and exits with code 1.
- Create: `web/src/api/brands.ts`
- Modify: `web/src/replica/sha256.ts:25-26`
- Modify: `web/package.json:17`

**Interfaces:**
- Consumes: `generateTypes` from Task 2.
- Produces: `export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };` in `api/brands.ts`. The file's header comment states two rules: brands.ts is the one place a brand is defined, and the subtype pattern uses a second key, with the `CanonicalTitle`/`NormalizedTitle` example from the spec. `replica/sha256.ts` keeps `sha256Hex` and replaces its type definition with `export type { Sha256Hex } from "../api/brands";`.

- [ ] **Step 1:** Change `"gen-types"` to `node tooling/genTypes.mjs`, then run `pnpm gen-types`. Because nothing on the server is branded yet, check that `git diff --no-ext-diff src/api/types.d.ts` shows only the injected import line plus any formatting differences between the CLI and the API. If the API's formatting differs, keep the API output and note it in the commit message.
- [ ] **Step 2:** Run `pnpm typecheck && pnpm test:unit`. Expect a PASS.
- [ ] **Step 3: Check by hand** (Review Focus 4). Temporarily add a property with `x-brand: "Nope"` to a copy of the spec and generate into a scratch file under `src/api/`. Confirm `tsc` reports `Namespace … has no exported member 'Nope'`, then delete the scratch file. Commit nothing from this step.
- [ ] **Step 4:** Commit: `feat(pkm-85x3): gen-types runs through the x-brand transform; api/brands.ts holds Sha256Hex`.

### Task 4: Prove it on `Sha256Hex`

**Files:**
- Modify: `server/src/pkm/contracts/ops.py`, adding `brand(Sha256Hex)` directly after the `Sha256Hex = NewType(...)` line.
- Modify: `web/src/api/openapi.json` and `web/src/api/types.d.ts` (both regenerated).
- Modify: `web/src/api/ops.ts:4-18`. `UpdateTextOp` and `DeleteOp` become plain `components["schemas"][…]` aliases, and the `Sha256Hex` import and the narrowing comments go.
- Test: `server/tests/test_brands.py` and `web/src/api/ops.test.ts`. If an `ops.test.ts` already exists, add to it; otherwise create it.

- [ ] **Step 1: Write the failing server test** `test_openapi_marks_op_hashes`. Dump the schema with `create_app(config).openapi()`, using the same throwaway-config pattern as `test_openapi_sync.py`. Then, for every component whose name starts with `UpdateTextOp` (`base_text_hash`) or `DeleteOp` (`base_subtree_hash`), the non-null `anyOf` branch has `x-brand == "Sha256Hex"`, `minLength == 64` and `maxLength == 64`.
- [ ] **Step 2: Write the failing web type probe** in `ops.test.ts`:
  ```ts
  const plain: string = "x".repeat(64);
  // @ts-expect-error a plain string is not a Sha256Hex
  const bad: UpdateTextOp = { op: "update_text", uid: "abcdef", text: "", base_text_hash: plain };
  const good: UpdateTextOp = { op: "update_text", uid: "abcdef", text: "", base_text_hash: sha256Hex("") };
  ```
  Also add one runtime `it` asserting that `good.base_text_hash` has length 64, so vitest collects the file. The same pair goes in for `DeleteOp.base_subtree_hash`.
- [ ] **Step 3:** Run the server test and confirm it FAILS on the missing `x-brand`.
- [ ] **Step 4:** Add `brand(Sha256Hex)`, regenerate both contract files (Global Constraints), and simplify `api/ops.ts`.
- [ ] **Step 5:** Run `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`, then `cd web && pnpm typecheck && pnpm test:unit`. Expect everything to pass, `test_openapi_sync.py` included. Then confirm the probe has teeth: change the probe's `bad` line to a valid `sha256Hex("")` value, check that `pnpm typecheck` fails with TS2578 (`Unused '@ts-expect-error' directive`), and revert the change.
- [ ] **Step 6:** Commit: `feat(pkm-85x3): Sha256Hex reaches the web as a generated brand; drop the ops.ts hand aliases`.

### Task 5: Docs, regen instructions, full verification

**Files:**
- Modify: `docs/architecture/backend.md` (contracts section): how a NewType becomes a web brand, as a short note or a table row that names `brand()` and the separate-statement rule.
- Modify: `docs/architecture/frontend.md` (api module): `api/brands.ts` is the one place a brand is defined, and `tooling/genTypes.mjs` generates `types.d.ts`. If the module map lists tooling, add both files there.
- Modify: every other doc that describes `gen-types`. Find them with `grep -rn "openapi-typescript\|gen-types" docs .claude/skills AGENTS.md web/src/api/payloads.ts`.

- [ ] **Step 1:** Make the edits. Invoke the `architecture-docs` skill for the `docs/architecture/` files, then run `node .claude/skills/architecture-docs/check-docs.mjs <files>`. Expect it to report nothing new.
- [ ] **Step 2: Run the full verification.** Server: `uv run pytest -q && uv run pyrefly check && uv run ruff check`. Web: `pnpm build && CI=true pnpm verify`. Both must exit 0, with 0 pyrefly errors and the same suppressed count as on main.
- [ ] **Step 3:** Tick the pkm-85x3 bean checklist, then commit: `docs(pkm-85x3): document the x-brand path from NewType to web brand`.
