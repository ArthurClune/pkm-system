import { describe, expect, test } from "vitest";
import {
  classifyModule,
  edgeDiagnostic,
  formatDiagnostic,
  headerDiagnostics,
  parseHeaderLines,
  resolveRelativeSpecifier,
  sortDiagnostics,
  validateExemptions,
} from "./fcis-core.mjs";

const core = { status: "ok", kind: "core" };
const shell = { status: "ok", kind: "shell" };
const mixedNeeds = { status: "ok", kind: "mixed", variant: "needs-refactoring" };
const mixedUnavoidable = { status: "ok", kind: "mixed", variant: "unavoidable", reason: "why" };
const exempt = { status: "exempt", reason: "generated data" };

function edge(overrides) {
  return { source: "a.ts", target: "b.ts", kind: "import", typeOnly: false, line: 3, ...overrides };
}

describe("parseHeaderLines", () => {
  test("missing header", () => {
    expect(parseHeaderLines(["const x = 1;", ""])).toEqual({ status: "missing" });
  });

  test("late header (past the first five lines)", () => {
    const lines = ["a", "b", "c", "d", "e", "// pattern: Functional Core"];
    expect(parseHeaderLines(lines)).toEqual({ status: "late", line: 6, raw: "Functional Core" });
  });

  test("duplicate header", () => {
    const lines = ["// pattern: Functional Core", "x", "// pattern: Imperative Shell"];
    expect(parseHeaderLines(lines)).toEqual({ status: "duplicate", lines: [1, 3] });
  });

  test("unknown header text", () => {
    expect(parseHeaderLines(["// pattern: Something Weird"]))
      .toEqual({ status: "unknown", raw: "Something Weird", line: 1 });
  });

  test.each([
    ["Functional Core", "core", undefined],
    ["Imperative Shell", "shell", undefined],
    ["Mixed (needs refactoring)", "mixed", "needs-refactoring"],
  ])("valid header %s", (raw, kind, variant) => {
    const result = parseHeaderLines([`// pattern: ${raw}`]);
    expect(result.status).toBe("ok");
    expect(result.kind).toBe(kind);
    if (variant) expect(result.variant).toBe(variant);
  });

  test("Mixed (unavoidable) without a reason", () => {
    expect(parseHeaderLines(["// pattern: Mixed (unavoidable)"]))
      .toEqual({ status: "missing-reason", line: 1 });
  });

  test("Mixed (unavoidable) with only whitespace after --", () => {
    expect(parseHeaderLines(["// pattern: Mixed (unavoidable) --    "]))
      .toEqual({ status: "missing-reason", line: 1 });
  });

  test("Mixed (unavoidable) with a real reason", () => {
    expect(parseHeaderLines(["// pattern: Mixed (unavoidable) -- crosses a vendored boundary"]))
      .toEqual({
        status: "ok", kind: "mixed", variant: "unavoidable",
        reason: "crosses a vendored boundary", line: 1,
      });
  });
});

describe("classifyModule", () => {
  test("exact exemption match short-circuits the header scan", () => {
    const exemptions = { "src/router.ts": "static config constants" };
    expect(classifyModule("src/router.ts", "garbage, no header at all", exemptions))
      .toEqual({ file: "src/router.ts", status: "exempt", reason: "static config constants" });
  });

  test("exemptions are exact paths, not prefixes/globs", () => {
    const exemptions = { "src/router.ts": "static config constants" };
    const result = classifyModule("src/router2.ts", "// pattern: Functional Core", exemptions);
    expect(result.status).toBe("ok");
  });

  test("non-exempt file is classified by its own header", () => {
    const result = classifyModule("src/uid.ts", "// pattern: Imperative Shell\n", {});
    expect(result).toEqual({ file: "src/uid.ts", status: "ok", kind: "shell", line: 1 });
  });
});

describe("headerDiagnostics", () => {
  test("ok and exempt classifications produce nothing", () => {
    expect(headerDiagnostics({ file: "a.ts", status: "ok", kind: "core", line: 1 })).toEqual([]);
    expect(headerDiagnostics({ file: "a.ts", status: "exempt", reason: "r" })).toEqual([]);
  });

  test.each(["missing", "late", "duplicate", "unknown", "missing-reason"])(
    "%s status produces exactly one diagnostic naming the file",
    (status) => {
      const classification = { file: "src/a.ts", status, line: 6, raw: "Nope", lines: [1, 3] };
      const diagnostics = headerDiagnostics(classification);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].file).toBe("src/a.ts");
      expect(diagnostics[0].message).toContain("src/a.ts");
    },
  );
});

describe("validateExemptions", () => {
  test("non-empty reasons pass", () => {
    expect(validateExemptions({ "src/router.ts": "static config constants" })).toEqual([]);
  });

  test("empty or whitespace-only reasons are rejected", () => {
    const diagnostics = validateExemptions({ "src/router.ts": "", "src/x.ts": "   " });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => d.kind === "invalid-exemption")).toBe(true);
  });
});

describe("resolveRelativeSpecifier", () => {
  const files = new Set(["a.ts", "b/index.ts", "c.tsx", "d.d.ts", "e.ts"]);

  test("non-relative specifiers are not resolved", () => {
    expect(resolveRelativeSpecifier("a.ts", "react", files)).toBeNull();
  });

  test("resolves a bare directory to its index.ts", () => {
    expect(resolveRelativeSpecifier("a.ts", "./b", files)).toBe("b/index.ts");
  });

  test("resolves .tsx over a missing .ts", () => {
    expect(resolveRelativeSpecifier("a.ts", "./c", files)).toBe("c.tsx");
  });

  test("resolves .d.ts", () => {
    expect(resolveRelativeSpecifier("a.ts", "./d", files)).toBe("d.d.ts");
  });

  test("resolves ../ against a nested source file", () => {
    expect(resolveRelativeSpecifier("nested/x.ts", "../e", files)).toBe("e.ts");
  });

  test("unresolvable relative specifier returns null", () => {
    expect(resolveRelativeSpecifier("a.ts", "./missing", files)).toBeNull();
  });
});

describe("edgeDiagnostic", () => {
  test("core -> core is permitted", () => {
    expect(edgeDiagnostic(edge(), core, core)).toBeNull();
  });

  test("shell -> core is permitted", () => {
    expect(edgeDiagnostic(edge(), shell, core)).toBeNull();
  });

  test("shell -> shell is permitted (only core sources are restricted)", () => {
    expect(edgeDiagnostic(edge(), shell, shell)).toBeNull();
  });

  test("core -> shell import is forbidden", () => {
    const diagnostic = edgeDiagnostic(edge(), core, shell);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic.kind).toBe("forbidden-edge");
    expect(diagnostic.target).toBe("b.ts");
  });

  test("core -> Mixed (needs refactoring) is forbidden", () => {
    expect(edgeDiagnostic(edge(), core, mixedNeeds)).not.toBeNull();
  });

  test("core -> Mixed (unavoidable) is forbidden", () => {
    expect(edgeDiagnostic(edge(), core, mixedUnavoidable)).not.toBeNull();
  });

  test("core -> exempt target is permitted (out of the taxonomy)", () => {
    expect(edgeDiagnostic(edge(), core, exempt)).toBeNull();
  });

  test("runtime re-export from core to shell is forbidden", () => {
    const diagnostic = edgeDiagnostic(edge({ kind: "export" }), core, shell);
    expect(diagnostic).not.toBeNull();
  });

  test("dynamic import from core to shell is forbidden", () => {
    const diagnostic = edgeDiagnostic(edge({ kind: "dynamic-import" }), core, shell);
    expect(diagnostic).not.toBeNull();
  });

  test("a type-only edge from core to shell is permitted", () => {
    expect(edgeDiagnostic(edge({ typeOnly: true }), core, shell)).toBeNull();
  });
});

describe("sortDiagnostics / formatDiagnostic", () => {
  test("sorts by source file, then line, then target, then kind", () => {
    const diagnostics = [
      { file: "b.ts", line: 1, target: "z.ts", kind: "forbidden-edge", message: "b1" },
      { file: "a.ts", line: 5, target: "y.ts", kind: "forbidden-edge", message: "a5" },
      { file: "a.ts", line: 2, target: "x.ts", kind: "forbidden-edge", message: "a2" },
      { file: "a.ts", line: 2, target: "w.ts", kind: "forbidden-edge", message: "a2w" },
    ];
    const sorted = sortDiagnostics(diagnostics);
    expect(sorted.map((d) => d.message)).toEqual(["a2w", "a2", "a5", "b1"]);
  });

  test("formatDiagnostic returns the diagnostic's message", () => {
    expect(formatDiagnostic({ message: "src/a.ts: boom" })).toBe("src/a.ts: boom");
  });
});
