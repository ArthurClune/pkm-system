# Query Full Results Design

**Bean:** `pkm-x41r`

## Goal

Render every result from an embedded query without requiring user interaction. Remove the broken “Show more” behavior and all query-specific pagination code that becomes obsolete.

## Root Cause

`QueryBlock` deliberately requests 20 matches at a time and renders a “Show more” button while its local offset is below the server-reported total. The `/api/query` route mirrors that design with `limit` and `offset` parameters. Large result sets are therefore truncated until pagination succeeds.

## Design

### Server API

`GET /api/query` will accept only the query expression. It will evaluate the expression, exclude blocks that define queries, order matching blocks as it does today, and return all matches in one `GroupsPayload` response.

The route will remove its `limit` and `offset` parameters and its SQL `LIMIT` and `OFFSET` clause. The response shape remains unchanged: grouped blocks plus the total match count. OpenAPI and generated TypeScript API artifacts will be regenerated or updated through the project’s existing generation workflow so they do not advertise removed parameters.

### Web Component

`QueryBlock` will issue one request per expression and render every group in the response. It will keep:

- stale-response protection when the expression changes;
- the nested-query recursion cap;
- online/offline and server error handling;
- the total-result label.

It will remove:

- the query page-size constant;
- offset and page-request state;
- group-merging pagination logic;
- the loading state used only by the pagination button;
- the `loadMore` handler and “Show more” button;
- comments and imports that exist only for pagination.

### Error and Concurrency Behavior

A failed query request continues to display the existing error. A later request caused by an expression change can clear that error on success. Responses from superseded expressions remain ignored through the existing monotonically increasing request ID.

## Testing

Server coverage will create more than 70 matching blocks and assert that one `/api/query` request returns every block without pagination parameters.

Web coverage will provide a response containing more than 70 results and assert that all are rendered after one request and that no “Show more” button exists. Existing tests for expression changes, stale responses, recursion, and errors will remain where relevant. Pagination-only tests and fixtures will be removed rather than left as orphaned behavior.

## Orphan-Code Check

After implementation, searches will verify that `QueryBlock` no longer contains pagination constants, offsets, page-request guards, `mergeGroups`, or “Show more” references. API schema artifacts and tests will also be checked for query pagination parameters. Pagination used by backlinks and unlinked references is outside this change and remains intact.

## Non-goals

- Changing query parsing or matching semantics.
- Changing the `GroupsPayload` response shape.
- Removing pagination from backlinks or unlinked references.
- Introducing virtualization or result limits for unusually large queries.
