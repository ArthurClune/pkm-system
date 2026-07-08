---
name: roam
description: Roam Research integration via CLI. Use when creating or editing content in Roam, especially for meetings, notes, and page references.
user-invocable: no
---

# Roam

CLI-based Roam Research integration. Use the `roam` command for all Roam operations.

## Quick Reference

| Task | Command |
|------|---------|
| Fetch page | `roam get "Page Title"` |
| Today's page | `roam get today` |
| Tomorrow's page | `roam get tomorrow` |
| Fetch block | `roam get <uid>` |
| All TODOs | `roam get --todo` |
| Page TODOs | `roam get --todo -p "Page"` |
| Add TODO | `roam save --todo "Task text"` |
| Quick note | `roam save "Note text"` |
| Note to page | `roam save -p "Page" "text"` |
| Under heading | `roam save --parent "## Heading" "text"` |
| Mark done | `roam update <uid> -D` |
| Mark TODO | `roam update <uid> -T` |
| Update block | `roam update <uid> "new content"` |
| Search text | `roam search "term"` |
| Find refs | `roam refs "Page Title"` |

## Output Formats

- **Default**: Markdown (human-readable)
- **`--json`**: Structured data with block UIDs (needed for updates/moves)

Always use `--json` when you need to:
- Get block UIDs for subsequent updates
- Move blocks between pages
- Parse structured data programmatically

## Nesting Blocks

To create a block under an existing block, use `--parent` with the UID wrapped in double parens:

```bash
# Create under a specific block by UID
roam save -p "Page" --parent "((blockUid9))" "Child content"

# Create under a heading (creates heading if missing)
roam save -p "Page" --parent "## Notes" "Child content"
```

**CLI Gotcha**: Text starting with `-` is parsed as an option flag. Use stdin piping:

```bash
# This FAILS - "-" is parsed as an option
roam save -p "Page" --parent "((uid))" "- [[Henderson]]"

# This WORKS - pipe via stdin
echo "- [[Henderson]]" | roam save -p "Page" --parent "((uid))"
```

## Batch Operations

For multiple operations or complex structures, use `roam batch`:

```bash
# Move blocks
roam batch << 'EOF'
[
  {"command":"move","params":{"uid":"abc123","parent":"targetUid"}},
  {"command":"move","params":{"uid":"def456","parent":"targetUid"}}
]
EOF

# Create structured content
roam batch << 'EOF'
[
  {"command":"create","params":{"parent":"daily","text":"[[Meeting]] with [[Company]]","as":"mtg"}},
  {"command":"outline","params":{"parent":"{{mtg}}","items":["Attendees","Notes","Action items"]}}
]
EOF
```

Batch commands: `todo`, `create`, `update`, `delete`, `move`, `page`, `outline`, `table`, `remember`, `codeblock`

## Date Formatting

Roam daily pages use ordinal dates: `January 14th, 2026`

The CLI accepts shortcuts:
- `today`, `yesterday`, `tomorrow` for relative dates
- Full titles like `"January 14th, 2026"` for specific dates

## Meetings

- Tag meeting blocks with `[[Meeting]]`
- Include time at start (e.g., "12:00 Container Strategy Meeting")
- Link related documents as child blocks
- Format attendees as plain text: `Attendees: John Smith, Jane Doe`

### Calendar Verification

Before creating a meeting entry:
1. Check the calendar event using gog or calendar skill
2. Compare attendee list from calendar with any provided
3. Flag discrepancies to the user

## NOT for Calendar Review

**Do not use Roam to review calendars.** Roam daily pages may have meeting notes, but:
- For calendar review: use the **calendar skill** (`/calendar`)
- For checking events: use `gog calendar` commands
- Roam is for notes and knowledge, not calendar data

## Page References (CRITICAL)

**NEVER create page links for:**
- First names only: "Saul" stays as `Saul`, NOT `[[Saul]]`
- Role titles: "CEO" stays as `CEO`, NOT `[[CEO]]`
- Common nouns: "meeting" stays as `meeting`

**Examples:**
- WRONG: `Talk to [[Saul]] about strategy`
- RIGHT: `Talk to Saul about strategy`
- WRONG: `{{[[TODO]]}} Meet with [[John]]`
- RIGHT: `{{[[TODO]]}} Meet with John`

**Only create page links when:**
1. Full name AND the page already exists: `[[John Smith]]`
2. It's a known project/concept page: `[[Henderson]]`, `[[Calendar Skill]]`

Before linking any name, ask: "Is this a full name with an existing page?" If no, leave as plain text.
