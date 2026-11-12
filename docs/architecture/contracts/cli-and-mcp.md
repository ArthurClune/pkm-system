# Contract: the CLI and MCP server

Where `pkm batch` puts each block, case by case. `positions_after` in
`server/tests/props/model.py` is written from this file and never from the
code, and `test_planner_props.py` checks the planner and the server against
it, so a change in behaviour edits the row here and the model together.
Each section's principle, and why it holds, is in
[cli-and-mcp.md](../cli-and-mcp.md) under the same section name; a reason
that belongs to one row sits in that row.

## Pure planners

A command's `index` is a 0-based position among a parent's children,
counted as the earlier commands of the batch left them, when none is skipped.

| Command | Where its block ends up | Reason |
|---|---|---|
| `create` / `todo`, `index` within the children | at that position | the user counts the page as the batch has made it so far |
| `create` / `todo`, `index` null or past the end | appended | |
| `create` / `todo` with `as` | its uid answers a later `{{alias}}`, as a parent or a command's `uid` | |
| `move`, `index` within the destination's children without the block | the block leaves its group, then lands at that position (`Planner.move`) | a same-parent move's old place does not count |
| `move`, `index` null or past the end | appended to the destination | |
| `move`, any | its subtree comes with it | |
| `delete` | the block and its subtree leave | |
| `update` | no change of place | |
| a command whose block or parent the server no longer has, or a move into the block's own subtree | the server skips it ([contracts/write-path.md § Missing targets](write-path.md#missing-targets), [§ Concurrent structure edits](write-path.md#concurrent-structure-edits)), so nothing moves; a skipped `create` still used the uid the planner minted | |
| a later command in a group a skipped command touched (its parent's or its old parent's children) | lands among them, but its position can be off by the skip: the planner counts the skipped command as applied (`Planner`) | the planner cannot know what the server will skip |
