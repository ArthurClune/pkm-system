# pkm-ulae Low-Priority Hardening Design

## Scope

Complete only the three lower-priority findings still open in `pkm-ulae`:

1. Make sidebar append concurrency-safe.
2. Close the owned OpenAI HTTP client during application shutdown.
3. Remove duplicate HTTP status prefixes from CLI and MCP errors.

Unrelated follow-up beans are out of scope. The work will be split into one child bean, branch, worktree, and implementation subagent per finding, then merged with `--no-ff` into `ulae-low-sweep`.

## Approach

Use three parallel, isolated implementations because the findings affect independent subsystems and have no expected production-file overlap. Each subagent will use test-driven development and commit its child bean with its code and tests. Architecture documentation and the parent epic will be updated centrally on the sweep branch to avoid merge conflicts.

Alternatives rejected:

- A single sweep branch would reduce merge overhead but prevent safe parallel implementation and make review less focused.
- Cherry-picking parallel commits would integrate cleanly but would not preserve the requested branch structure in history.

## Finding 27: Sidebar Append Concurrency

`add_sidebar_entry()` currently reads existing rows before entering a write transaction. Concurrent requests can therefore choose the same `order_idx`, while same-title requests can leak an uncaught SQLite uniqueness error as a 500.

The route will acquire SQLite's writer reservation with `BEGIN IMMEDIATE` before checking titles and calculating the next index. The title check, index allocation, and insert will occur in that transaction. Existing `commit_and_nudge_threadpool()` behavior remains the successful commit boundary. A duplicate detected either by the pre-check or by defensive `sqlite3.IntegrityError` handling will roll back and return `409 entry already exists`.

This is an Imperative Shell concern; the existing pure `next_order_idx()` helper remains unchanged. No schema migration or unique `order_idx` constraint is required.

## Finding 28: Describer Ownership and Shutdown

`DescribeService` receives and retains an image describer, but its abstraction exposes no lifecycle and shutdown only cancels the worker. The production `OpenAIDescriber` consequently leaves its persistent async HTTP client open.

`ImageDescriber` will include an asynchronous `close()` operation. Passing a describer to `DescribeService` transfers ownership to the service. Service shutdown will be idempotent: it will stop and await the worker first, then close the describer exactly once. A disabled service has no resource to close. Test fakes will implement and record the lifecycle contract.

The application lifespan will use failure-safe teardown so assistant conversations are still closed if describe-service closure raises. Shutdown failures will not be silently swallowed after all owned services have received their cleanup attempt.

This remains Imperative Shell behavior. No provider-specific cleanup will be added to the application composition root.

## Finding 29: Client Error Formatting

HTTP error details currently pass through `friendly_error()`, which prefixes the numeric status, and then through `ApiError`, which prefixes it again.

`friendly_error()` will become status-neutral: it will shape human-readable details, including operation indexes and the special 401 login guidance, without adding the status. `ApiError` will remain the sole owner of numeric status formatting. CLI and MCP adapters can continue rendering `str(ApiError)` without special cases.

This preserves the existing status and message fields while changing malformed strings such as `404: 404: page not found` to `404: page not found`.

## Error Handling

- Sidebar duplicate races return the same stable 409 response as sequential duplicates and explicitly roll back before returning.
- SQLite lock waiting continues to use the configured busy timeout; no retry loop is introduced.
- Describer shutdown attempts all application-owned cleanup even if one close operation fails.
- Existing transport, response-schema, local validation, 401, and operation-detail client errors retain their meanings; only duplicate status rendering is removed.

## Testing

All behavior changes will be developed test-first.

### Sidebar

- Concurrent same-title requests produce exactly one success and one 409, with one persisted row.
- Concurrent different-title requests both succeed and receive distinct, contiguous indexes after existing entries.
- Existing sequential add, duplicate, delete, reorder, authentication, and journal-nudge tests remain green.

### Describer Lifecycle

- Closing an enabled service closes its describer once.
- Worker cancellation/awaiting happens before transport closure.
- Repeated closure is harmless and does not close twice.
- Closing a disabled service is a no-op.
- `OpenAIDescriber.close()` delegates to the async HTTP client.
- Application teardown still closes assistant resources when describe shutdown raises.

### Error Formatting

- Core formatting tests assert status-neutral friendly details and single-prefix `ApiError` strings.
- Client tests assert exact `.message` and rendered strings.
- CLI stderr and MCP tool errors are asserted exactly for a representative 404.
- 401, operation-detail, transport-status-zero, and response-schema strings are pinned against regressions.

## Documentation and Verification

Update `docs/architecture/backend.md` with the sidebar allocation transaction invariant and describer ownership/shutdown lifecycle. No route, response contract, generated OpenAPI, frontend, or sync architecture changes are expected.

After merging all three child branches with `--no-ff`, run from the repository root:

```bash
cd server && uv run pytest -q
cd server && uv run pyrefly check
cd server && uv run ruff check
```

Review all merged code and tests against the parent findings, update the three child beans with summaries, and complete `pkm-ulae` only when all remaining checkboxes and verification requirements are satisfied.
