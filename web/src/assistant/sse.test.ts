import { describe, expect, test } from "vitest";
import { createSseParser } from "./sse";

describe("createSseParser", () => {
  test("parses a complete frame", () => {
    const p = createSseParser();
    expect(p.push('event: text_delta\ndata: {"text": "hi"}\n\n')).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
  });

  test("buffers partial frames across chunks", () => {
    const p = createSseParser();
    expect(p.push("event: text_delta\nda")).toEqual([]);
    expect(p.push('ta: {"text": "hi"}\n\n')).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  test("parses multiple frames in one chunk", () => {
    const p = createSseParser();
    const events = p.push(
      'event: tool_started\ndata: {"tool_use_id": "t1", "name": "search", "summary": "searching \\"x\\""}\n\n' +
        'event: turn_done\ndata: {"usage": null}\n\n',
    );
    expect(events).toEqual([
      { type: "tool_started", tool_use_id: "t1", name: "search", summary: 'searching "x"' },
      { type: "turn_done", usage: null },
    ]);
  });

  test("tool_finished carries its id, error and declined flag", () => {
    const p = createSseParser();
    expect(p.push(
      'event: tool_finished\ndata: {"tool_use_id": "t1", "name": "update_block", '
        + '"error": "nope", "declined": false}\n\n'
        + 'event: tool_finished\ndata: {"tool_use_id": "t2", "name": "update_block", '
        + '"error": null, "declined": true}\n\n',
    )).toEqual([
      { type: "tool_finished", tool_use_id: "t1", name: "update_block",
        error: "nope", declined: false },
      { type: "tool_finished", tool_use_id: "t2", name: "update_block",
        error: null, declined: true },
    ]);
  });

  test("tool_finished keeps a warning", () => {
    const p = createSseParser();
    expect(p.push(
      'event: tool_finished\ndata: {"tool_use_id": "t1", "name": "batch", '
        + '"error": null, "declined": false, '
        + '"warning": "warning: skipped 1 of 3 ops"}\n\n',
    )).toEqual([
      { type: "tool_finished", tool_use_id: "t1", name: "batch",
        error: null, declined: false,
        warning: "warning: skipped 1 of 3 ops" },
    ]);
  });

  test("ignores malformed frames", () => {
    const p = createSseParser();
    expect(p.push("event: text_delta\ndata: {not json}\n\n")).toEqual([]);
    expect(p.push(": comment\n\n")).toEqual([]);
  });

  // The server interleaves a keepalive comment frame into a silent turn
  // (events.py SSE_COMMENT). It must stay invisible here, and must not
  // disturb a real frame arriving in the same chunk.
  test("ignores the server's keepalive comment frame", () => {
    const p = createSseParser();
    expect(p.push(": keepalive\n\n")).toEqual([]);
    expect(p.push(': keepalive\n\nevent: text_delta\ndata: {"text": "hi"}\n\n')).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
  });

  // A name missing from EVENT_TYPES is silently dropped, so the phase
  // event needs its own proof of life here.
  test("parses phase", () => {
    const p = createSseParser();
    expect(p.push('event: phase\ndata: {"label": "preparing save_note"}\n\n')).toEqual([
      { type: "phase", label: "preparing save_note" },
    ]);
  });

  test("parses confirm_request with its structured preview", () => {
    const p = createSseParser();
    const preview = {
      ops: [{ action: "update block", targets: [["uid", "VICTIMUID01"]],
        content: [["text", "hi", 2]], warnings: [],
        current: { state: "found", page_title: "Inbox", excerpt: "old",
          text_length: 3, descendants: null } }],
      summary: "update_block(uid='VICTIMUID01')",
      writes_in_flight: true,
    };
    const data = JSON.stringify({
      confirm_id: "c1", ops_preview: preview.summary, preview });
    expect(p.push(`event: confirm_request\ndata: ${data}\n\n`)).toEqual([
      { type: "confirm_request", confirm_id: "c1",
        ops_preview: preview.summary, preview },
    ]);
  });

  // A malformed preview still yields the event, so the card can show the
  // error and offer Deny; the server's turn must not hang unanswered.
  test("a confirm_request with a malformed preview carries preview null", () => {
    const p = createSseParser();
    expect(
      p.push('event: confirm_request\ndata: {"confirm_id": "c1", "ops_preview": "x", "preview": 42}\n\n'),
    ).toEqual([{ type: "confirm_request", confirm_id: "c1", ops_preview: "x", preview: null }]);
    expect(
      p.push('event: confirm_request\ndata: {"confirm_id": "c2", "ops_preview": "x"}\n\n'),
    ).toEqual([{ type: "confirm_request", confirm_id: "c2", ops_preview: "x", preview: null }]);
  });

  test("event name from the event line wins over a type key in data", () => {
    const p = createSseParser();
    expect(p.push('event: text_delta\ndata: {"text": "hi", "type": "error"}\n\n')).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
  });
});
