# pattern: Functional Core
"""The brand registry: plain literals and no imports, so the brand lint
(`server/tooling/brandlint`) can load this file under a bare `python3`
without the server's dependencies.

NAMES says which brands a parameter or field name must carry. MINT_SITES
and CAST_SITES say where a brand may be constructed or `typing.cast` used;
TEST_MINT_SITES, TEST_HELPERS and MALFORMED say how tests mint instead.
COLUMN_KEYS, SHAPES and CLIENT_KEYS are the row vocabulary `pkm.rows`
checks every DB row against. Each table's why is beside it below."""
from __future__ import annotations


# A name that means one of these brands wherever it appears, in any
# function parameter, dataclass field, TypedDict key or model field.
# camelCase spellings are derived by the lint, never listed. A name with
# more than one brand is one whose meaning depends on the table it is read
# from; any listed brand satisfies it.
NAMES: dict[str, tuple[str, ...]] = {
    # BlockUid
    "uid": ("BlockUid",),
    "uids": ("BlockUid",),
    "parent_uid": ("BlockUid",),
    "block_uid": ("BlockUid",),
    "block_uids": ("BlockUid",),
    "src_block_uid": ("BlockUid",),
    "target_block_uid": ("BlockUid",),
    "target_uid": ("BlockUid",),
    "header_uid": ("BlockUid",),
    # PageId
    "page_id": ("PageId",),
    "page_ids": ("PageId",),
    "target_page_id": ("PageId",),
    "src_page_id": ("PageId",),
    # Row ids and order keys
    "sidebar_entry_id": ("SidebarEntryId",),
    "sidebar_id": ("SidebarEntryId",),
    "order_idx": ("OrderIdx", "SidebarOrderIdx"),
    "sidebar_order_idx": ("SidebarOrderIdx",),
    # Sync
    "seq": ("SyncSeq",),
    "seen_seq": ("SyncSeq",),
    "client_id": ("ClientId",),
    "batch_id": ("BatchId",),
    # Other server brands
    "goodlinks_id": ("GoodlinksId",),
    "conversation_id": ("ConversationId",),
    "confirm_id": ("ConfirmId",),
    "sha": ("Sha256Hex",),
    "sha256": ("Sha256Hex",),
    "expected_sha256": ("Sha256Hex",),
    "actual_sha256": ("Sha256Hex",),
    "digest": ("Sha256Hex",),
    "expected_digest": ("Sha256Hex",),
    "actual_digest": ("Sha256Hex",),
    "audit_digest": ("Sha256Hex",),
    "base_hash": ("Sha256Hex",),
    "after_hash": ("Sha256Hex",),
    "base_text_hash": ("Sha256Hex",),
    "base_subtree_hash": ("Sha256Hex",),
    # Web-only brands
    "pending_row_id": ("PendingRowId",),
    "ticket_id": ("TicketId",),
    "request_id": ("RequestId",),
    "revision": ("Revision",),
}

# Brands that exist only in the web (a `__brand` type in web/src), named
# here so a NAMES entry for one of them is not mistaken for a typo.
WEB_BRANDS: tuple[str, ...] = (
    "PendingRowId", "TicketId", "RequestId", "Revision", "ParkedTitle",
)

# Brand -> repo-relative files, or directory prefixes ending `/`, allowed
# to construct (`Brand(x)`) or cast to it. On the server a brand's own
# declaring file is always allowed in addition; the web lint has no such
# allowance, so a web brand is minted only where it lists (TicketId is
# declared in sync/opQueue.ts and minted in ids.ts). contracts/ validates and
# mints every server brand at the wire.
_CONTRACTS = "server/src/pkm/contracts/"
# The web's own mint points, shared by several brands.
# The one place a replica DB row's untyped values become the branded
# `Columns` types. `row_problems` checks each row's shape only under tests;
# production trusts the `select` typing.
_WEB_ROWS = "web/src/replica/db.ts"
# The sync wire: HTTP bodies, WebSocket frames and tombstone entity ids are
# read as the generated contract's types, which carry the brands the server
# minted.
_WEB_WIRE = "web/src/sync/wire.ts"
# A stored op list is shape-checked, then read as `BlockOp[]`.
_WEB_PENDING_OPS = "web/src/replica/pendingOps.ts"
# A stored poison intent is shape-checked, then read as a `PoisonEvent`.
_WEB_POISON = "web/src/sync/poisonIntents.ts"
MINT_SITES: dict[str, tuple[str, ...]] = {
    "BlockUid": (
        _CONTRACTS,
        # `_alias_uid` turns a command's uid-or-`{{alias}}` text into the
        # uid it names.
        "server/src/pkm/batch.py",
        # `parse_uid_spec` reads the uid out of a `((uid))` parent spec.
        "server/src/pkm/planning.py",
        # `extract` and `parse_block_uid` are the text-to-uid parsers.
        "server/src/pkm/refs.py",
        # The journal stores every entity id as text; `window_block_uids`
        # parses them back.
        "server/src/pkm/server/sync_core.py",
        # `parseBlockUid` parses a uid out of text.
        "web/src/ids.ts",
        # `newUid` mints a random uid.
        "web/src/uid.ts",
        # The tokenizer's block-ref match is uid-shaped by construction.
        "web/src/grammar/scan.ts",
        _WEB_ROWS, _WEB_WIRE, _WEB_PENDING_OPS, _WEB_POISON,
    ),
    "PageId": (
        _CONTRACTS,
        # `window_page_ids` parses the journal's text entity ids.
        "server/src/pkm/server/sync_core.py",
        # The stand-in page for a failed read carries a sentinel id.
        "web/src/outline/missingPage.ts",
        _WEB_ROWS, _WEB_WIRE,
    ),
    "SidebarEntryId": (
        _CONTRACTS,
        _WEB_ROWS, _WEB_WIRE,
    ),
    # `CLIENT_ID` is the CLI's fixed identity on the sync wire; the web mints
    # one per tab (`newClientId`).
    "ClientId": (_CONTRACTS, "server/src/pkm/client/api.py",
                 "web/src/uid.ts", _WEB_WIRE),
    # `_batch_id` mints one id per client batch; so does `newBatchId`.
    "BatchId": (_CONTRACTS, "server/src/pkm/client/workflows.py",
                "web/src/uid.ts", _WEB_ROWS, _WEB_WIRE, _WEB_POISON),
    # Order keys are assigned where a position becomes a key: the planner
    # (`next_order_idx`, `_land`), the importer (export order) and the
    # conflict/copy effects (a fresh child list starts at 0). The web's
    # twin of the planner is outline/orderIdx.ts.
    "OrderIdx": (_CONTRACTS, "server/src/pkm/planning.py",
                 "server/src/pkm/importer/rows.py",
                 "server/src/pkm/server/ops_core.py",
                 "web/src/outline/orderIdx.ts",
                 _WEB_ROWS, _WEB_WIRE, _WEB_PENDING_OPS, _WEB_POISON),
    # The importer appends sidebar entries one past the current max.
    "SidebarOrderIdx": (_CONTRACTS, "server/src/pkm/importer/sidebar_rows.py",
                        _WEB_ROWS, _WEB_WIRE),
    # assets_core parses and digests; title_migration digests its plan; the
    # web's `sha256Hex` digests text and `parseSha256Hex` reads a hash.
    "Sha256Hex": (_CONTRACTS, "server/src/pkm/assets_core.py",
                  "server/src/pkm/title_migration.py",
                  "web/src/replica/sha256.ts",
                  _WEB_ROWS, _WEB_WIRE, _WEB_PENDING_OPS, _WEB_POISON),
    # `parseSyncSeq` reads a cursor out of an untrusted value.
    "SyncSeq": (_CONTRACTS, "web/src/ids.ts", _WEB_ROWS, _WEB_WIRE),
    # A fresh random id per assistant conversation.
    "ConversationId": (_CONTRACTS, "server/src/pkm/assistant/service.py"),
    # A process-local counter keys each pending confirm; the web narrows the
    # confirm SSE event where it parses one.
    "ConfirmId": (_CONTRACTS, "server/src/pkm/assistant/claude_engine.py",
                  "web/src/assistant/sse.ts"),
    "GoodlinksId": (_CONTRACTS,
                    # `goodlinksIdFromHref` checks an href's id against
                    # GoodLinks' own id shape.
                    "web/src/components/goodlinks.ts"),
    # `normalizeRefTitle` and `canonicalizeTitle` are the normalisers; the
    # tokenizer's hashtag match holds no whitespace.
    "NormalizedTitle": (_CONTRACTS, "web/src/grammar/scan.ts",
                        "web/src/replica/titles.ts"),
    # `title_reader` is the one general mint: it alone knows the database's
    # live plain-space flag. The web's twin is `titleReader`, and a daily
    # title is canonical by its format.
    "CanonicalTitle": (_CONTRACTS, "server/src/pkm/server/sync_meta.py",
                       "web/src/replica/meta.ts", "web/src/replica/daily.ts",
                       _WEB_ROWS, _WEB_WIRE),
    # An internal NewType, not a wire brand: `parse_canonical_query` and
    # `page_queries` are its mints, both in query_exec.
    "CanonicalQueryNode": ("server/src/pkm/server/query_exec.py",),
    # Web-only brands. A pending row's id is the row's own autoincrement key.
    "PendingRowId": (_WEB_ROWS, _WEB_POISON),
    # `mintTicketId` numbers the write tickets of one tab.
    "TicketId": ("web/src/ids.ts",),
    # The outline state machine counts its own reads and revisions.
    "RequestId": ("web/src/outline/outlineState.ts",),
    "Revision": ("web/src/outline/outlineState.ts",),
    # `parkedTitle` names the placeholder title a parked row holds.
    "ParkedTitle": ("web/src/replica/apply.ts",),
}

# Server files where `typing.cast` is allowed.
CAST_SITES: tuple[str, ...] = (
    # The one place a DB row's untyped values enter the typed world.
    "server/src/pkm/database.py",
    # A regex group's length or text narrowed to a Literal the pattern
    # guarantees (HeadingLevel, TaskMark).
    "server/src/pkm/planning.py",
    "server/src/pkm/todo.py",
)

# Files and directories (a trailing slash) that may touch raw sqlite3:
# connections, cursors and `.raw`. Every other file goes through `Db`.
SQLITE_SITES: dict[str, str] = {
    "server/src/pkm/database.py": "the one place sqlite3 is wrapped as Db",
    "server/tooling/perfcheck/":
        "measures SQLite itself: trace and progress hooks, EXPLAIN plans,"
        " an immutable fixture snapshot; Db hides all three",
    "server/tests/rawread.py":
        "the tests' reader for catalog tables, journal columns and counts,"
        " outside the Row vocabulary; it refuses a branded column",
    # Tests whose subject is SQLite itself.
    "server/tests/test_database.py":
        "tests the Db wrapper against the sqlite3 connection it wraps",
    "server/tests/test_backup_cli.py":
        "backup: opens the dated snapshot read-only by URI, as a restore"
        " would, to prove SQLite's online backup wrote a whole database",
}

# The one module on each side that may mint every brand: the checked
# helpers tests build their values with. Product code may not import them.
TEST_MINT_SITES: tuple[str, ...] = (
    "server/src/pkm/test_data/ids.py",
    "web/src/test-helpers.ts",
)

# Brand -> the stem of its test helper: `<stem>_of` in Python, the camel
# `<stem>Of` on the web. The stem is the brand's rule-1 name, or the brand
# itself where it has none; the `Of` keeps it clear of a test's locals.
TEST_HELPERS: dict[str, str] = {
    "BlockUid": "uid",
    "PageId": "page_id",
    "SidebarEntryId": "sidebar_entry_id",
    "OrderIdx": "order_idx",
    "SidebarOrderIdx": "sidebar_order_idx",
    "SyncSeq": "seq",
    "ClientId": "client_id",
    "BatchId": "batch_id",
    "Sha256Hex": "sha",
    "ConversationId": "conversation_id",
    "ConfirmId": "confirm_id",
    "GoodlinksId": "goodlinks_id",
    "NormalizedTitle": "normalized_title",
    "CanonicalTitle": "canonical_title",
    "CanonicalQueryNode": "canonical_query_node",
    "PendingRowId": "pending_row_id",
    "TicketId": "ticket_id",
    "RequestId": "request_id",
    "Revision": "revision",
    "ParkedTitle": "parked_title",
}

# Brands whose deliberately bad values a negative test forges through
# `malformed_<stem>` / `malformed<Stem>`: unchecked, and spelled so the test
# says on its face that the value is forged. A forger exists for each brand
# a negative test needs, accepting null where the test needs a missing value;
# an integer brand's shape is "an integer".
MALFORMED: dict[str, str] = {
    "BlockUid": "uid",
    "Sha256Hex": "sha",
    "SyncSeq": "seq",
    "CanonicalTitle": "canonical_title",
}

# Files that are tests by location (web `*.test.*` files are tests by
# name). They may import the test mint modules and their lint messages name
# the helpers; they are exempt from nothing.
TEST_CODE: tuple[str, ...] = (
    "server/tests/",
    "server/src/pkm/test_data/",
    "web/src/test-setup.ts",
    "web/src/test-helpers.ts",
    "web/src/props/",
    "web/src/replica/replayArbs.ts",
    "web/src/replica/testDb.ts",
    "web/src/sync/memReplica.ts",
)

# Glob patterns for files where a line may carry `# brand: untrusted --
# <reason>`: the HTTP boundary reads route input that is not one value,
# such as a comma-separated query param, and parses it in the handler. The
# web has one: a build plugin reading another tool's output.
OPT_OUT_FILES: tuple[str, ...] = (
    "server/src/pkm/**/routes_*.py",
    # Workbox's precache manifest is external build output; its `revision`
    # is a content hash string, not a replica `Revision`.
    "web/tooling/viteBudgetPlugin.ts",
    # The HTTP response boundary: `fetch(...).json()` is untyped, and the
    # generated API types name the brands a response carries; the web twin
    # of the routes_*.py parse points.
    "web/src/api/client.ts",
)

# Columns whose key is not their own name: table -> {column: key}. One
# name keeps one meaning and one nullability across every table, so a
# column that differs from the key of the same name reads under an alias
# registered here, and a bare `id` always becomes a named row id.
COLUMN_KEYS: dict[str, dict[str, str]] = {
    "pages": {"id": "page_id"},
    # One name, one meaning: three tables carry a `kind` of different types.
    "refs": {"kind": "ref_kind"},
    "sidebar_entries": {"id": "sidebar_entry_id",
                        "order_idx": "sidebar_order_idx"},
    # Nullable here, NOT NULL in blocks.
    "changes": {"page_id": "change_page_id", "kind": "change_kind"},
    # NOT NULL here, nullable in pages, blocks and assets.
    "block_rewrites": {"created_at": "rewrite_created_at",
                       "kind": "rewrite_kind"},
    "sync_meta": {"key": "sync_meta_key", "value": "sync_meta_value"},
    # Client-only tables (web/src/replica/clientSchema.ts).
    "pending_ops": {"id": "pending_row_id", "error": "pending_error"},
    "sync_client_meta": {"key": "client_meta_key",
                         "value": "client_meta_value"},
    "replay_log": {"id": "replay_log_id", "kind": "replay_kind",
                   "key": "replay_key"},
    "replay_log_refs": {"kind": "ref_kind"},
}

# Brand -> (base type, full-match regex or None). A brand value that
# fails its shape is a row the database should never have produced.
SHAPES: dict[str, tuple[str, str | None]] = {
    # The body of contracts.ops.BLOCK_REF_TOKEN; a test asserts they are equal.
    "BlockUid": ("text", r"[a-zA-Z0-9_-]{6,32}"),
    "Sha256Hex": ("text", r"[0-9a-f]{64}"),
    "PageId": ("int", None),
    "SidebarEntryId": ("int", None),
    "OrderIdx": ("int", None),
    "SidebarOrderIdx": ("int", None),
    "SyncSeq": ("int", None),
    "ClientId": ("text", None),
    "BatchId": ("text", None),
    "ConversationId": ("text", None),
    "ConfirmId": ("text", None),
    "GoodlinksId": ("text", None),
    "NormalizedTitle": ("text", None),
    "CanonicalTitle": ("text", None),
}

# Web-only row keys, for the client-only tables: key -> (TS type name,
# nullable). The web's row types are generated against this list.
CLIENT_KEYS: dict[str, tuple[str, bool]] = {
    "pending_row_id": ("PendingRowId", False),
    "ops_json": ("string", False),
    "poisoned": ("number", False),
    "pending_error": ("string", True),
    "seen_seq": ("SyncSeq", False),
    "client_meta_key": ("string", False),
    "client_meta_value": ("string", False),
    "replay_log_id": ("number", False),
    "replay_kind": ("string", False),
    "replay_key": ("string", False),
    "pre_json": ("string", True),
    "pre_page_id": ("PageId", True),
    "log_id": ("number", False),
    "enqueued_ms": ("number", False),
    # Computed names of the client's own queries.
    "start_uid": ("BlockUid", False),
    "depth": ("number", False),
    "has_pre": ("number", False),
    "present": ("number", False),
    "text_changed": ("number", False),
    "pre_text": ("string", True),
    "edited_at": ("number", False),
    "joined_seen_seq": ("SyncSeq", True),
}

# The allowed values of a client key that is a closed set, so the row check
# enforces them: key -> members, all of the key's base type.
CLIENT_LITERALS: dict[str, tuple[str | int, ...]] = {
    "replay_kind": ("block", "page"),
    "has_pre": (0, 1),
    "present": (0, 1),
    "text_changed": (0, 1),
}

# SQLite's FTS5 shadow tables carry no data of ours.
FTS_SHADOW_SUFFIXES = ("_data", "_idx", "_config", "_docsize", "_content")
