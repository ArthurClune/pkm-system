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
      'event: tool_started\ndata: {"name": "search", "summary": "searching \\"x\\""}\n\n' +
        'event: turn_done\ndata: {"usage": null}\n\n',
    );
    expect(events).toEqual([
      { type: "tool_started", name: "search", summary: 'searching "x"' },
      { type: "turn_done", usage: null },
    ]);
  });

  test("ignores malformed frames", () => {
    const p = createSseParser();
    expect(p.push("event: text_delta\ndata: {not json}\n\n")).toEqual([]);
    expect(p.push(": comment\n\n")).toEqual([]);
  });

  test("parses confirm_request", () => {
    const p = createSseParser();
    expect(
      p.push('event: confirm_request\ndata: {"tool_use_id": "c1", "ops_preview": "save_note(...)"}\n\n'),
    ).toEqual([{ type: "confirm_request", tool_use_id: "c1", ops_preview: "save_note(...)" }]);
  });
});
