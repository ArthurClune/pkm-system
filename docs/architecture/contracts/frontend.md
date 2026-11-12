# Contract: the app shell

What the app shell's paged lists and its chat machine do, case by case.
The property models in `web/src/props/journal`, `web/src/props/files`,
`web/src/props/backlinks` and `web/src/props/assistant` are written from
this file and never from the code, so a change in behaviour edits the row
here and the model together. Why each rule holds is in
[frontend.md](../frontend.md), under the same section names.

## Paged lists

| List | The rule |
|---|---|
| Linked references | Show more and load-all overlap, so the section is loading until every walk settles; no walk starts while a sync refresh is in flight |
| Unlinked references | A delivered Link leaves the loaded list and `total`, because the server's list has shifted left. Show more asks from the count of loaded blocks still listed (`nextOffset` says why) |

## The Journal

The days on screen are a contiguous, newest-first run of the non-empty days
`/api/journal` serves, starting at today. `views/journalPaging.ts` keeps one
load in flight at a time.

| Event | Load it starts | When it lands |
|---|---|---|
| mount, or "Load older days" with nothing on screen | head: `BATCH` days | replaces the days |
| the sentinel or "Load older days" | older: `BATCH` days `before` the oldest shown; ignored while a load is in flight or the past is exhausted | appends |
| resync | head: as many days as are on screen, at least `BATCH`, at most `SERVER_MAX_DAYS`; supersedes the load in flight | replaces the days |

| Situation | Outcome |
|---|---|
| a load fails | the days and their cursor stay as they were, so "Load older days" after a failed resync continues from the oldest day shown |
| the error | shows only while the latest completed load failed |
| a result for a superseded load | changes nothing |
| a batch shorter than asked for | the past is exhausted |
| a resync over more than `SERVER_MAX_DAYS` days | the server clamps `days` to `SERVER_MAX_DAYS`, so the oldest drop; scrolling loads them back |

## The `/files` browser

| Event | Outcome (`views/filesPaging.ts`) |
|---|---|
| a filter change | clears the selection and bumps the generation at the keystroke, not when the debounced reload fires |
| until the reload lands | `items` and `total` belong to the old filter |
| Select all, Load more | each excludes the other, in the buttons and in `filesPaging` |

## The chat machine

The turn's phases and moves are the diagram in
[frontend.md § The chat machine](../frontend.md#the-chat-machine).

| Case | Rule | Reason |
|---|---|---|
| Stop while creating | Stop in `creating` keeps the conversation the create returns but starts no stream from it | A create cannot be called back |
| Stop while streaming | Stop in `streaming` posts a stop (`postStop`), and the panel stays busy until the server's turn is over ([turn phase](../assistant.md#the-turn-phase)) | |
| A send after an aborted stream | `streamWithBusyRetry` retries the 409 the send meets | The server may still be draining |
| A request's result | Every request's result names its turn, and changes nothing on screen unless that turn is busy and not stopping. That includes a failed confirm POST | New chat clears the transcript at once, so a superseded turn's events must not fold into the new one. After Stop no card is left to answer again |
| A stream's 404 | A stream's 404 re-creates the conversation once, with the same model, in the same turn. A second 404 fails the turn | The server answers 404 for a conversation it has reaped, evicted or retired as dead, including one whose harness was lost (`HARNESS_LOST`) |
| The model picker | While a conversation is creating or open, the picker shows its model as the create returned it, and is locked. Otherwise the models list's default applies until the user picks | A conversation keeps the model it was created with |
| Posting the stop | The driver posts the stop only once the stream's response has opened, and retries no 409 after Stop. A stream that settles first posts nothing | `POST …/stop` names no turn. An opened response means the server has reserved this turn, so the stop cannot reach another |
| A stopped turn's end | A stopped turn ends only once its stop POST has settled (`stopSettled`) | The server acts on a stop before it answers, so a settled POST cannot stop a later turn |
| The stop fallback | If the POST fails, or the turn has not ended within `STOP_ACK_TIMEOUT_MS` (`chatDriver.ts`), the driver aborts the stream and the POST | The server's stop is unbounded while the prompt is still being written ([turn phase](../assistant.md#the-turn-phase)), and the panel must still be freed. An aborted POST can still reach the server later and stop the next turn |
| An unasked `turn_stopped` | A `turn_stopped` for a turn that did not stop ends it with `UNASKED_STOP_MESSAGE` | The stop was meant for an earlier turn; the user is told the reply was cut short |
| New chat | New chat aborts the stream, a stopping turn's included, and sends the DELETE only after that stream settles. A conversation created for a superseded turn is deleted | The server sees the dropped connection and ends the turn before it closes the conversation |
