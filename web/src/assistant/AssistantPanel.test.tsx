import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { canonicalTitleOf, stubFetch, confirmIdOf } from "../test-helpers";
import type { ChatItem, PendingConfirm, PhaseInfo } from "./useAssistant";
import { parseWritePreview, type PreviewOp, type WritePreview } from "./writePreview";

const state = vi.hoisted(() => {
  const noConfirm = (): PendingConfirm | null => null;
  return {
    current: {
      items: [] as ChatItem[],
      status: "idle" as "idle" | "busy" | "confirm",
      phase: null as PhaseInfo | null,
      error: null as string | null,
      model: "sonnet",
      setModel: vi.fn(),
      models: ["sonnet", "opus", "haiku", "fable"],
      ensureModels: vi.fn(),
      modelLocked: false,
      pendingConfirm: noConfirm(),
      pendingConfirmCount: 0,
      answering: false,
      send: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      respondConfirm: vi.fn().mockResolvedValue(undefined),
      newChat: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock("./useAssistant", () => ({ useAssistant: () => state.current }));

import { AssistantPanel } from "./AssistantPanel";

afterEach(() => {
  vi.useRealTimers(); // a failed fake-timer test must not poison later ones
  vi.clearAllMocks();
  state.current.items = [];
  state.current.status = "idle";
  state.current.phase = null;
  state.current.error = null;
  state.current.modelLocked = false;
  state.current.pendingConfirm = null;
  state.current.pendingConfirmCount = 0;
  state.current.answering = false;
  state.current.models = ["sonnet", "opus", "haiku", "fable"];
});

function op(overrides: Partial<PreviewOp> = {}): PreviewOp {
  return { action: "update block", targets: [["uid", "VICTIMUID01"]],
    content: [["text", "Tidied wording.", 15]], warnings: [],
    current: { state: "found", page_title: canonicalTitleOf("Inbox"),
      excerpt: "Old wording.", text_length: 12, descendants: null },
    ...overrides };
}

// stamped: another write of the turn could land after the read
function previewOf(...ops: PreviewOp[]): WritePreview {
  return { ops, summary: "s", writes_in_flight: true };
}

function showConfirm(preview: WritePreview | null, count = 1,
  sentDecision: boolean | null = null, allowedAhead = 0) {
  state.current.status = "confirm";
  state.current.pendingConfirm = {
    confirmId: confirmIdOf("t1"), opsPreview: "s", preview, sentDecision,
    allowedAhead };
  state.current.pendingConfirmCount = count;
}

// the card's Allow arms after a pause, so a test that clicks it waits it out
function renderArmed() {
  vi.useFakeTimers();
  const view = render(<AssistantPanel open onClose={() => {}} />);
  act(() => { vi.advanceTimersByTime(600); });
  return view;
}

const card = () =>
  document.querySelector(".assistant-confirm-card") as HTMLElement;

describe("AssistantPanel", () => {
  test("model picker renders exactly what the server offers", () => {
    state.current.models = ["sonnet", "opus", "haiku", "fable", "glm"];
    render(<AssistantPanel open onClose={() => {}} />);
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["sonnet", "opus", "haiku", "fable", "glm"]);
  });

  test("model picker hides glm when the server does not offer it", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("option", { name: "glm" })).toBeNull();
  });

  test("opening the panel requests the model list; staying closed does not", () => {
    const { rerender } = render(<AssistantPanel open={false} onClose={() => {}} />);
    expect(state.current.ensureModels).not.toHaveBeenCalled();
    rerender(<AssistantPanel open onClose={() => {}} />);
    expect(state.current.ensureModels).toHaveBeenCalled();
  });

  test("renders nothing when closed", () => {
    const { container } = render(<AssistantPanel open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders messages and tool lines", () => {
    state.current.items = [
      { kind: "user", text: "find x" },
      { kind: "tool", toolUseId: "t1", name: "search", summary: 'searching "x"',
        done: true, error: null, declined: false },
      { kind: "assistant", text: "Found **it**" },
    ];
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("find x")).toBeInTheDocument();
    expect(screen.getByText(/searching "x"/)).toBeInTheDocument();
    expect(screen.getByText("it")).toBeInTheDocument(); // bold rendered via InlineSegments
  });

  test("a failed write's line shows ✗ and its reason as text", () => {
    state.current.items = [
      { kind: "tool", toolUseId: "t1", name: "update_block",
        summary: "update_block", done: true, declined: false,
        error: 'block ((AbCdEfGh)) changed <img src=x onerror="alert(1)">' },
      { kind: "tool", toolUseId: "t2", name: "update_block",
        summary: "update_block", done: true, error: null, declined: false },
    ];
    const { container } = render(<AssistantPanel open onClose={() => {}} />);
    const failed = container.querySelectorAll(".assistant-tool-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].textContent).toBe(
      'Failed: block ((AbCdEfGh)) changed <img src=x onerror="alert(1)">');
    expect(failed[0].querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
    expect(container.querySelector(".assistant-messages img")).toBeNull();
    expect(container.querySelector(".assistant-messages a")).toBeNull();
    const lines = container.querySelectorAll(".assistant-tool-line");
    expect(lines[0].textContent).toMatch(/^✗ update_block/);
    expect(lines[1].textContent).toMatch(/^✓ update_block/);
  });

  test("a declined write's line shows a neutral Declined, no ✗", () => {
    state.current.items = [
      { kind: "tool", toolUseId: "t1", name: "update_block",
        summary: "update_block", done: true, error: null, declined: true },
    ];
    const { container } = render(<AssistantPanel open onClose={() => {}} />);
    expect(container.querySelector(".assistant-tool-failed")).toBeNull();
    const line = container.querySelector(".assistant-tool-line");
    expect(line?.textContent).toMatch(/^✓ update_block/);
    expect(line?.textContent).toContain("Declined");
    expect(line?.textContent).not.toContain("✗");
  });

  test("Enter sends, Shift+Enter does not", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/ask about your notes/i);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(state.current.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state.current.send).toHaveBeenCalledWith("hello");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  test("model select locked after first message; New chat unlocks via hook", () => {
    state.current.modelLocked = true;
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(state.current.newChat).toHaveBeenCalled();
  });

  test("Escape inside panel closes it", () => {
    const onClose = vi.fn();
    render(<AssistantPanel open onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/ask about your notes/i), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("shows error line", () => {
    state.current.error = "cap reached";
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText(/cap reached/)).toBeInTheDocument();
  });

  // The busy line answers "is it stuck?" -- phase label plus an
  // elapsed clock that visibly ticks.
  test("busy line shows the phase label and a ticking elapsed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    state.current.status = "busy";
    state.current.phase = { label: "reasoning", since: 995_000 };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("reasoning… 5s")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByText("reasoning… 8s")).toBeInTheDocument();
    vi.useRealTimers();
  });

  test("busy line falls back to thinking… before the first phase event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    state.current.status = "busy";
    state.current.phase = { label: null, since: 935_000 };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("thinking… 1m 5s")).toBeInTheDocument();
    vi.useRealTimers();
  });

  test("busy line renders plain thinking… with no phase info at all", () => {
    state.current.status = "busy";
    state.current.phase = null;
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("thinking…")).toBeInTheDocument();
  });

  test("Stop button appears while busy and calls stop()", () => {
    state.current.status = "idle";
    const { rerender } = render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    state.current.status = "busy";
    rerender(<AssistantPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.current.stop).toHaveBeenCalled();
  });

  test("Stop button is not shown during a confirm pause", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  // a failed post leaves only Retry on the card; Stop ends the turn, which
  // declines the confirm on the server, without discarding the chat
  test.each([true, false])(
    "Stop shows after a failed %s post and calls stop()", (decision) => {
      showConfirm(previewOf(op()), 1, decision);
      render(<AssistantPanel open onClose={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(state.current.stop).toHaveBeenCalled();
    });

  test("a ((uid)) block ref in an assistant reply resolves and becomes clickable", async () => {
    stubFetch([["/api/block-refs", {
      block_ref_texts: { chart1: { text: "the compute chart block", page_title: "Charts" } },
    }]]);
    state.current.items = [
      { kind: "assistant", text: "see ((chart1)) for details" },
    ];
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <AssistantPanel open onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText("((chart1))")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("the compute chart block")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "the compute chart block" })).toBeInTheDocument();
  });

  function LocationProbe() {
    return <span data-testid="location">{useLocation().pathname}</span>;
  }

  test("a reply's media waits for a click, including inside a resolved ((ref))", async () => {
    const fetchMock = stubFetch([["/api/block-refs", {
      block_ref_texts: {
        chart1: {
          text: "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy",
          page_title: "Charts",
        },
      },
    }]]);
    state.current.items = [
      { kind: "assistant", text: "see ((chart1)) and ![x](https://attacker.invalid/a.png)" },
    ];
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <AssistantPanel open onClose={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "image from attacker.invalid: x" }))
      .toBeInTheDocument();
    const post = await screen.findByRole("button", { name: "Bluesky post from alice.bsky.social" });
    expect(document.querySelector("img, iframe")).toBeNull();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("public.api.bsky.app"))).toBe(false);

    // the load click must not reach the ((ref)) link around it
    const before = screen.getByTestId("location").textContent;
    fireEvent.click(post);
    expect(screen.getByTestId("location").textContent).toBe(before);
    await waitFor(() => {
      const after = fetchMock.mock.calls.map(([input]) => String(input));
      expect(after.some((url) => url.includes("public.api.bsky.app"))).toBe(true);
    });
  });

  test("a ((^uid)) citation with a copied caret marker still resolves", async () => {
    stubFetch([["/api/block-refs", {
      block_ref_texts: { chart1: { text: "the compute chart block", page_title: "Charts" } },
    }]]);
    state.current.items = [
      { kind: "assistant", text: "see ((^chart1)) for details" },
    ];
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <AssistantPanel open onClose={() => {}} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("the compute chart block")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "the compute chart block" })).toBeInTheDocument();
  });

  test("the model select is styled as a field", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toHaveClass("input-control");
  });
});

describe("ConfirmCard", () => {
  test("Allow answers true", () => {
    showConfirm(previewOf(op()));
    renderArmed();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(true);
  });

  test("Deny answers false", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(false);
  });

  test("the heading counts the writes", () => {
    showConfirm(previewOf(op(), op({ action: "rename page", current: null })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 2 writes:$/);
    expect(card().querySelectorAll("li.assistant-confirm-op")).toHaveLength(2);
  });

  test("one write is singular", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 1 write:$/);
  });

  test("targets render before content and are never clipped", () => {
    const longText = "Tidied wording. ".repeat(320).slice(0, 5000);
    showConfirm(previewOf(op({ content: [["text", longText, 5000]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const target = [...card().querySelectorAll(".assistant-confirm-target")]
      .find((el) => el.textContent?.includes("VICTIMUID01"));
    const content = card().querySelector(".assistant-confirm-content");
    expect(target).toBeDefined();
    expect(content).not.toBeNull();
    expect(target!.compareDocumentPosition(content!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(target!.textContent).toBe('uid: "VICTIMUID01"');
    // the long text is the part that is clipped
    expect(content!.textContent).not.toContain(longText);
  });

  test("a quoted value cannot read as another argument", () => {
    const text = 'x"\n2 delete block uid "Y"';
    showConfirm(previewOf(op({ content: [["text", text, text.length]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const contents = card().querySelectorAll(".assistant-confirm-content");
    expect(contents).toHaveLength(1);
    const value = contents[0].querySelector(".assistant-confirm-value")!;
    expect(value.textContent).toBe('"x\\"\n2 delete block uid \\"Y\\""');
    expect(value.textContent!.startsWith('"')).toBe(true);
    expect(value.textContent!.endsWith('"')).toBe(true);
  });

  test("a long value shows its length and is clipped outside the quote", () => {
    showConfirm(previewOf(op({ content: [["text", "a".repeat(500), 500]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const content = card().querySelector(".assistant-confirm-content")!;
    expect(content.querySelector(".assistant-confirm-value")!.textContent)
      .toBe('"' + "a".repeat(280) + '"…');
    expect(content).toHaveTextContent("(500 chars)");
  });

  test("show reveals the full content", () => {
    const longText = "b".repeat(279) + "TAIL" + "c".repeat(300);
    showConfirm(previewOf(
      op({ content: [["text", longText, longText.length]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()).not.toHaveTextContent("TAIL");
    fireEvent.click(screen.getByRole("button", { name: "[show]" }));
    expect(card()
      .querySelector(".assistant-confirm-content .assistant-confirm-value")!
      .textContent).toBe(`"${longText}"`);
    fireEvent.click(screen.getByRole("button", { name: "[hide]" }));
    expect(card()).not.toHaveTextContent("TAIL");
  });

  // total_len counts code points; .length would count each emoji twice
  test("the clip and the length compare code points", () => {
    const emoji = "😀".repeat(280);
    showConfirm(previewOf(op({ content: [["text", emoji, 280]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const content = card().querySelector(".assistant-confirm-content")!;
    expect(content.querySelector(".assistant-confirm-value")!.textContent)
      .toBe(`"${emoji}"`);
    expect(content).not.toHaveTextContent("chars)");
    expect(screen.queryByRole("button", { name: "[show]" })).toBeNull();
  });

  test("a clip never splits an astral character", () => {
    const emoji = "😀".repeat(300);
    showConfirm(previewOf(op({ content: [["text", emoji, 300]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()
      .querySelector(".assistant-confirm-content .assistant-confirm-value")!
      .textContent).toBe('"' + "😀".repeat(280) + '"…');
  });

  test("targets show in order with their values formatted", () => {
    showConfirm(previewOf(op({ action: "save note",
      targets: [["page", null], ["parent", "P1"], ["todo", false]],
      content: [], current: null })));
    render(<AssistantPanel open onClose={() => {}} />);
    const rows = [...card().querySelectorAll(".assistant-confirm-target")]
      .map((el) => el.textContent);
    expect(rows).toEqual(
      ["page: today's daily note", 'parent: "P1"', "todo: false"]);
    expect(card().querySelector(".assistant-confirm-action"))
      .toHaveTextContent(/^save note$/);
  });

  test("keys render in the key style, followed by a colon", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    const key = card()
      .querySelector(".assistant-confirm-target .assistant-confirm-key")!;
    expect(key.textContent).toBe("uid");
    expect(key.nextSibling?.textContent).toBe(": ");
    const contentKey = card()
      .querySelector(".assistant-confirm-content .assistant-confirm-key")!;
    expect(contentKey.textContent).toBe("text");
    expect(contentKey.nextSibling?.textContent).toBe(": ");
  });

  test("every value is bidi-isolated", () => {
    showConfirm(previewOf(
      op({ targets: [["uid", "אב"], ["page", "P"]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const values = card().querySelectorAll(".assistant-confirm-value");
    // two targets, the current page and text, and the content
    expect(values).toHaveLength(5);
    for (const value of values) expect(value.tagName).toBe("BDI");
  });

  // an RTL value in an LTR card would otherwise draw right to left, and an
  // override at its start must not reach the card's own text
  test("every value and warning is left-to-right", () => {
    showConfirm(previewOf(
      op({ targets: [["uid", "ד 2"]],
        current: { state: "found", page_title: canonicalTitleOf("שלום"),
          excerpt: "\u202Eevil", text_length: 5, descendants: null },
        warnings: ['if no block has uid "ד 2", nothing is updated'] }),
      op({ targets: [["uid", "{{אב}}"]],
        current: { state: "created", write: 1, alias: "אב" } })));
    render(<AssistantPanel open onClose={() => {}} />);
    const values = [...card().querySelectorAll(".assistant-confirm-value")];
    expect(values).toHaveLength(7);
    for (const value of values) {
      expect(value.tagName).toBe("BDI");
      expect(value.getAttribute("dir")).toBe("ltr");
    }
    expect(values.map((v) => v.textContent)).toEqual(
      ['"ד 2"', '"שלום"', '"\\u202Eevil"', '"Tidied wording."',
        '"{{אב}}"', '"אב"', '"Tidied wording."']);
    // a warning quotes values too, so it reads left to right as a whole
    const warnings = [...card().querySelectorAll(".assistant-confirm-warning")];
    expect(warnings).toHaveLength(1);
    expect(warnings[0].getAttribute("dir")).toBe("ltr");
  });

  const currentRows = () => [...card().querySelectorAll(
    ".assistant-confirm-current")].map((el) => el.textContent);

  test("current page and text follow the targets and precede warnings and "
    + "content", () => {
    showConfirm(previewOf(op({ warnings: ["mind this"] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const target = card().querySelector(".assistant-confirm-target")!;
    const rows = [...card().querySelectorAll(".assistant-confirm-current")];
    const warning = card().querySelector(".assistant-confirm-warning")!;
    const content = card().querySelector(".assistant-confirm-content")!;
    expect(rows).toHaveLength(2);
    const order = [target, ...rows, warning, content];
    for (const [i, el] of order.slice(1).entries()) {
      expect(order[i].compareDocumentPosition(el)
        & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(currentRows()).toEqual(
      ['current page: "Inbox"', 'current text: "Old wording."']);
    expect(rows[0].querySelector(".assistant-confirm-key")!.textContent)
      .toBe("current page");
    expect(rows[1].querySelector(".assistant-confirm-key")!.textContent)
      .toBe("current text");
  });

  test("a clipped current text says so", () => {
    showConfirm(previewOf(op({ current: { state: "found",
      page_title: canonicalTitleOf("Inbox"), excerpt: "a".repeat(200),
      text_length: 1234, descendants: null } })));
    render(<AssistantPanel open onClose={() => {}} />);
    const row = card().querySelectorAll(".assistant-confirm-current")[1];
    expect(row.querySelector(".assistant-confirm-length")!.textContent)
      .toBe("(first 200 of 1,234 characters)");
    expect(row.querySelector(".assistant-confirm-value.assistant-confirm-text")!
      .textContent).toBe('"' + "a".repeat(200) + '"…');
  });

  test("an unclipped current text shows no length and no ellipsis", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    const row = card().querySelectorAll(".assistant-confirm-current")[1];
    expect(row.querySelector(".assistant-confirm-length")).toBeNull();
    expect(row.querySelector(".assistant-confirm-text")!.textContent)
      .toBe('"Old wording."');
  });

  // the 200 is the excerpt's own count of code points, not a constant
  test("the clipped length counts the excerpt's code points", () => {
    showConfirm(previewOf(op({ current: { state: "found",
      page_title: canonicalTitleOf("Inbox"), excerpt: "😀".repeat(150),
      text_length: 151, descendants: null } })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-current .assistant-confirm-length")!
      .textContent).toBe("(first 150 of 151 characters)");
  });

  test("a missing block and a block made earlier in the batch", () => {
    showConfirm(previewOf(
      op({ action: "create block", targets: [["as", "a"]],
        content: [["text", "x", 1]], current: null }),
      op({ current: { state: "missing" } }),
      op({ current: { state: "created", write: 1, alias: 'a"\n' } })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(currentRows()).toEqual([
      "current text: no block has this uid",
      'current text: none yet (write 1 above creates it as "a\\"\\u000A")',
    ]);
  });

  // a delete removes the block's whole subtree, so the card says how much
  test.each([
    [0, null],
    [1, "and 1 block under it"],
    [1234, "and 1,234 blocks under it"],
  ] as const)("a delete with %i blocks under it", (descendants, copy) => {
    showConfirm(previewOf(op({ action: "delete block", content: [],
      current: { state: "found", page_title: canonicalTitleOf("Inbox"),
        excerpt: "Old wording.", text_length: 12, descendants } })));
    render(<AssistantPanel open onClose={() => {}} />);
    const subtree = card().querySelector(".assistant-confirm-subtree");
    if (copy === null) expect(subtree).toBeNull();
    else expect(subtree!.textContent).toBe(copy);
  });

  // the page the block is on now and the page it moves to are both pages:
  // each says which it is
  test("a move labels the page it is on apart from the page it goes to", () => {
    showConfirm(previewOf(op({ action: "move block",
      targets: [["uid", "U1"], ["page", "Dest"], ["index", 0]], content: [],
      current: { state: "found", page_title: canonicalTitleOf("Src"),
        excerpt: "Old wording.", text_length: 12, descendants: null } })));
    render(<AssistantPanel open onClose={() => {}} />);
    const targets = [...card().querySelectorAll(".assistant-confirm-target")]
      .map((el) => el.textContent);
    expect(targets).toEqual(['uid: "U1"', 'to page: "Dest"', "index: 0"]);
    expect(currentRows()).toEqual(
      ['currently on page: "Src"', 'current text: "Old wording."']);
  });

  // the server read the card while an earlier allowed write could still
  // land, this turn's or a stopped one's, and the user allowed one
  test.each([
    [1, "You allowed 1 earlier card, and its write may have "
      + "landed after this card was read; the current text it shows may "
      + "have changed."],
    [2, "You allowed 2 earlier cards, and their writes may have "
      + "landed after this card was read; the current text it shows may "
      + "have changed."],
  ])("a stamped card after %i allowed cards says so", (allowed, copy) => {
    showConfirm(previewOf(op()), 1, null, allowed);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-stale")!.textContent)
      .toBe(copy);
  });

  // every write of the turn had landed when the server read it
  test("a card the server did not stamp has no staleness note", () => {
    showConfirm({ ...previewOf(op()), writes_in_flight: false }, 1, null, 2);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-stale")).toBeNull();
  });

  test("a card no earlier allow precedes has no staleness note", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-stale")).toBeNull();
  });

  // a block the batch itself creates, or none at all, was never read from
  // the store
  test.each([
    ["no current block", null],
    ["a block made earlier in the batch",
      { state: "created", write: 1, alias: "a" }],
  ] as const)("a card showing %s has no staleness note", (_name, current) => {
    showConfirm(previewOf(
      op({ action: "create block", targets: [["as", "a"]], current: null }),
      op({ current })), 1, null, 1);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-stale")).toBeNull();
  });

  test("a card that found no block still says it was read before", () => {
    showConfirm(previewOf(op({ current: { state: "missing" } })), 1, null, 1);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-stale")).not.toBeNull();
  });

  // what the server sends, through the parser the SSE stream uses
  const parsedPreview = (op: unknown) =>
    parseWritePreview({ ops: [op], summary: "s", writes_in_flight: false });

  // the server JSON-quotes a title inside a warning; the card must show its
  // escape as sent, not double it into a quote that seems to close early
  test("a warning shows a quoted title exactly as the server escaped it", () => {
    const warning = `allow_merge is on: if ${JSON.stringify('a"b, c')} exists`;
    showConfirm(parsedPreview({ action: "rename page",
      targets: [["allow_merge", true]], content: [], warnings: [warning],
      current: null }));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-warning")!.textContent)
      .toBe('⚠ allow_merge is on: if "a\\"b, c" exists');
  });

  // a key the action does not declare could only be a decoy row, such as
  // one spelling out an escape the card would seem to have made
  test("a key the action does not declare offers only Deny", () => {
    showConfirm(parsedPreview({ action: "save note",
      targets: [["x\\u202E", 1]], content: [], warnings: [],
      current: null }));
    renderArmed();
    expect(card()).toHaveTextContent("The write preview could not be read.");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  test("warnings show after the targets, marked", () => {
    showConfirm(previewOf(op({ action: "rename page",
      targets: [["title", "Inbox"], ["allow_merge", true]], content: [],
      warnings: ['allow_merge is on: "Inbox" is merged into it'],
      current: null })));
    render(<AssistantPanel open onClose={() => {}} />);
    const warning = card().querySelector(".assistant-confirm-warning")!;
    expect(warning)
      .toHaveTextContent('⚠ allow_merge is on: "Inbox" is merged into it');
    const lastTarget =
      [...card().querySelectorAll(".assistant-confirm-target")].at(-1)!;
    expect(lastTarget.compareDocumentPosition(warning)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("the buttons sit outside the scrolling ops list", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    const ops = card().querySelector("ol.assistant-confirm-ops")!;
    expect(ops.contains(screen.getByRole("button", { name: "Deny" })))
      .toBe(false);
  });

  test("malformed preview offers only Deny", () => {
    showConfirm(null);
    renderArmed();
    expect(card()).toHaveTextContent("The write preview could not be read.");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(false);
  });

  test("shows the queue position", () => {
    showConfirm(previewOf(op()), 2);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 1 write \(1 of 2\):$/);
  });

  test("the queue position pluralises by the head's writes", () => {
    showConfirm(previewOf(op(), op()), 3);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 2 writes \(1 of 3\):$/);
  });

  test("an unreadable preview still shows its queue position", () => {
    showConfirm(null, 2);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to write \(1 of 2\):$/);
  });

  test("a lone confirm shows no queue position", () => {
    showConfirm(previewOf(op()), 1);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()).not.toHaveTextContent(/1 of/);
  });

  // a double-click aimed at the previous control must not land on Allow
  test("Allow arms after a pause; Deny is live at once", () => {
    vi.useFakeTimers();
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.current.respondConfirm).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  test("the next card in the queue arms afresh", () => {
    showConfirm(previewOf(op()), 2);
    const { rerender } = renderArmed();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    state.current.pendingConfirm = {
      confirmId: confirmIdOf("t2"), opsPreview: "s", preview: previewOf(op()),
      sentDecision: null, allowedAhead: 0 };
    state.current.pendingConfirmCount = 1;
    rerender(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
  });

  test("while answering both buttons are disabled and Stop shows", () => {
    showConfirm(previewOf(op()));
    state.current.answering = true;
    renderArmed();
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.current.stop).toHaveBeenCalled();
  });

  // the server may hold the first answer already and ignores a changed one,
  // so a failed answer can only be sent again as it was
  test.each([
    ["Allow", true],
    ["Deny", false],
  ] as const)("a failed %s offers only a retry of it", (name, allow) => {
    showConfirm(previewOf(op()), 1, allow);
    state.current.error = "request failed";
    renderArmed();
    const buttons = within(card()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([`Retry ${name}`]);
    fireEvent.click(buttons[0]);
    expect(state.current.respondConfirm).toHaveBeenCalledWith(allow);
  });

  // the decision lives in the hook, so a card mounted afresh still knows it
  test("a failed Allow stays retry-only after the panel closes and reopens", () => {
    showConfirm(previewOf(op()), 1, true);
    state.current.error = "request failed";
    const { rerender } = renderArmed();
    rerender(<AssistantPanel open={false} onClose={() => {}} />);
    expect(card()).toBeNull();
    rerender(<AssistantPanel open onClose={() => {}} />);
    act(() => { vi.advanceTimersByTime(600); });
    const buttons = within(card()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Retry Allow"]);
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  // only the hook decides an answer was sent: a click it did not post leaves
  // both choices open
  test("a click alone does not turn the card into a retry", () => {
    showConfirm(previewOf(op()));
    renderArmed();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  // jsdom has no layout: stand in for a transcript scrolled to the top of
  // the panel, with a card 200px below the top of its scroll area
  function layOut() {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const top = this.classList.contains("assistant-confirm-card") ? 300
          : this.classList.contains("assistant-messages") ? 100 : 0;
        return { top } as DOMRect;
      });
    const setTop = vi.spyOn(Element.prototype, "scrollTop", "set");
    onTestFinished(() => { vi.restoreAllMocks(); });
    return setTop;
  }

  // the transcript scrolls itself rather than calling scrollIntoView, which
  // in WebKit can also scroll the document under the fixed panel
  test("a new card scrolls the transcript to the card's top", () => {
    const setTop = layOut();
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    const messages = document.querySelector(".assistant-messages");
    expect(setTop.mock.calls).toEqual([[200]]);
    expect(setTop.mock.contexts[0]).toBe(messages);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  // pinning the transcript to its bottom would push a tall card's heading
  // and first targets above the fold
  test("a confirm does not pin the transcript to its bottom", () => {
    const setTop = layOut();
    state.current.items = [{ kind: "user", text: "please write" }];
    const { rerender } = render(<AssistantPanel open onClose={() => {}} />);
    expect(setTop.mock.calls).toEqual([[1000]]);
    showConfirm(previewOf(op()));
    rerender(<AssistantPanel open onClose={() => {}} />);
    // from the bottom it was pinned to, on by the card's 200px offset
    expect(setTop.mock.calls).toEqual([[1000], [1200]]);
  });

  test("a card mounted again on reopen scrolls to its top again", () => {
    const setTop = layOut();
    showConfirm(previewOf(op()));
    const { rerender } = render(<AssistantPanel open onClose={() => {}} />);
    rerender(<AssistantPanel open={false} onClose={() => {}} />);
    rerender(<AssistantPanel open onClose={() => {}} />);
    expect(setTop.mock.calls).toEqual([[200], [200]]);
  });

  test("the ops list is a focusable region a keyboard can scroll", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    const region = screen.getByRole("region", { name: "Writes to review" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.querySelector("ol.assistant-confirm-ops")).not.toBeNull();
    expect(region.contains(screen.getByRole("button", { name: "Deny" })))
      .toBe(false);
  });
});

type Observed = {
  callback: IntersectionObserverCallback;
  root: Element | Document | null | undefined;
  targets: Element[];
};

// jsdom has no IntersectionObserver. By default every marker reports in view
// as soon as it is observed; manual mode leaves the reports to the test.
function mockIntersectionObserver(auto = false): Observed[] {
  const made: Observed[] = [];
  class FakeObserver {
    private record: Observed;
    constructor(callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit) {
      this.record = { callback, root: options?.root, targets: [] };
      made.push(this.record);
    }
    observe(target: Element) {
      this.record.targets.push(target);
      if (auto) {
        this.record.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver);
      }
    }
    unobserve(target: Element) {
      this.record.targets = this.record.targets.filter((t) => t !== target);
    }
    disconnect() { this.record.targets = []; }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  return made;
}

const marker = (which: "start" | "end") =>
  card().querySelector(`.assistant-confirm-${which}`)!;

function report(observed: Observed, which: "start" | "end",
  isIntersecting: boolean) {
  act(() => {
    observed.callback(
      [{ isIntersecting, target: marker(which) } as IntersectionObserverEntry],
      {} as IntersectionObserver);
  });
}

const scrollIntoView = vi.fn();
const realScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  mockIntersectionObserver(true);
  // jsdom does not implement scrollIntoView
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = realScrollIntoView;
});

describe("ConfirmCard: Allow waits until the whole card has been in view", () => {
  const allow = () => screen.getByRole("button", { name: "Allow" });

  test("the observer watches the viewport for markers around every op", () => {
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op(), op({ action: "rename page", current: null })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(made).toHaveLength(1);
    // no root: the viewport, clipped by every scrolling ancestor
    expect(made[0].root ?? null).toBeNull();
    expect(made[0].targets).toEqual([marker("start"), marker("end")]);
    const title = card().querySelector(".assistant-confirm-title")!;
    expect(marker("start").compareDocumentPosition(title)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const lastOp = [...card().querySelectorAll("li.assistant-confirm-op")].at(-1)!;
    expect(lastOp.compareDocumentPosition(marker("end"))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("seeing only the end does not arm Allow", () => {
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op()));
    renderArmed();
    report(made[0], "end", true);
    expect(allow()).toBeDisabled();
    expect(card()).toHaveTextContent("Scroll back to the start to review every write");
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  test("seeing only the start does not arm Allow", () => {
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op()));
    renderArmed();
    report(made[0], "start", true);
    expect(allow()).toBeDisabled();
    expect(card()).toHaveTextContent("Scroll to the end to review every write");
  });

  test("seeing both arms Allow, and each stays seen", () => {
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op()));
    renderArmed();
    report(made[0], "start", true);
    report(made[0], "start", false); // scrolled past: still counts
    report(made[0], "end", false);
    expect(allow()).toBeDisabled();
    report(made[0], "end", true);
    expect(allow()).toBeEnabled();
    expect(card()).not.toHaveTextContent("Scroll");
    expect(made[0].targets).toEqual([]); // no longer watched
  });

  test("a card seen whole before the pause still waits it out", () => {
    showConfirm(previewOf(op()));
    vi.useFakeTimers();
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()).not.toHaveTextContent("Scroll");
    expect(allow()).toBeDisabled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(allow()).toBeEnabled();
  });

  // a window too short for the list and its heading: the user can scroll
  // the transcript past the end marker without it ever showing
  test("the hint says to scroll up when the end is above the transcript", () => {
    mockIntersectionObserver();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const [top, bottom] = this.classList.contains("assistant-messages")
          ? [100, 300]
          : this.classList.contains("assistant-confirm-end") ? [50, 51]
          : [400, 401];
        return { top, bottom } as DOMRect;
      });
    onTestFinished(() => { vi.restoreAllMocks(); });
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()).toHaveTextContent("Scroll to the end to review every write");
    const region = screen.getByRole("region", { name: "Writes to review" });
    fireEvent.scroll(region);
    expect(card()).toHaveTextContent(
      "Scroll up to bring the end of the list into view");
    expect(allow()).toBeDisabled();
  });

  test("a marker once seen stays seen whatever a later scroll measures", () => {
    const made = mockIntersectionObserver();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const [top, bottom] = this.classList.contains("assistant-messages")
          ? [100, 300] : [50, 51];
        return { top, bottom } as DOMRect;
      });
    onTestFinished(() => { vi.restoreAllMocks(); });
    showConfirm(previewOf(op()));
    renderArmed();
    report(made[0], "start", true);
    report(made[0], "end", true);
    fireEvent.scroll(document.querySelector(".assistant-messages")!);
    expect(allow()).toBeEnabled();
    expect(card()).not.toHaveTextContent("Scroll");
  });

  test("without an observer Allow never arms", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    showConfirm(previewOf(op()));
    renderArmed();
    expect(allow()).toBeDisabled();
    expect(card()).toHaveTextContent("Scroll to the end to review every write");
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });
});
