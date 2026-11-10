// pattern: Imperative Shell
// repo/ts-expect-error-in-probe: a `@ts-expect-error` comment sits in
// the body of a function expression or arrow passed directly to the
// `typeProbe` imported from the test helpers, which never calls it, so a
// suppression cannot carry an off-type value into code that runs. A
// value a test must feed a runtime guard is `offType<T>(v)` from the
// same module.
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { TEST_HELPERS_SOURCE } from "../eslint-plugin-brands/testHelpers.ts";

const PROBE_MESSAGES = {
  outsideProbe:
    "`@ts-expect-error` is allowed only inside a `typeProbe(() => { ... })` "
    + "block from the test helpers, which never runs its body; to feed a "
    + "runtime guard a value its type forbids, use `offType<T>(value)`",
};

// The directive TypeScript reads: a line comment whose text starts with it,
// or a block comment whose last line does.
function isExpectError(comment: TSESTree.Comment): boolean {
  if (comment.type === "Line") {
    return /^\/*\s*@ts-expect-error\b/.test(comment.value);
  }
  const last = comment.value.split("\n").at(-1) ?? "";
  return /^[\s*]*@ts-expect-error\b/.test(last);
}

export const tsExpectErrorInProbe: TSESLint.RuleModule<"outsideProbe"> = {
  meta: {
    type: "problem",
    schema: [],
    messages: PROBE_MESSAGES,
  },
  create(context) {
    const { sourceCode } = context;
    const bodies: TSESTree.Range[] = [];
    // Whether `name` at `node` is the `typeProbe` import of the test
    // helpers: a local function of the same name is another binding.
    const isTypeProbe = (node: TSESTree.Identifier) => {
      let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(node);
      let variable: TSESLint.Scope.Variable | undefined;
      while (scope !== null && variable === undefined) {
        variable = scope.set.get(node.name);
        scope = scope.upper;
      }
      const def = variable?.defs[0];
      return def !== undefined && def.type === "ImportBinding"
        && def.node.type === "ImportSpecifier"
        && def.node.imported.type === "Identifier"
        && def.node.imported.name === "typeProbe"
        && def.parent.type === "ImportDeclaration"
        && TEST_HELPERS_SOURCE.test(String(def.parent.source.value));
    };
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.arguments.length !== 1) {
          return;
        }
        const probe = node.arguments[0];
        if (probe.type !== "ArrowFunctionExpression"
          && probe.type !== "FunctionExpression") return;
        if (isTypeProbe(node.callee)) bodies.push(probe.body.range);
      },
      "Program:exit"() {
        for (const comment of sourceCode.getAllComments()) {
          if (!isExpectError(comment)) continue;
          const [start, end] = comment.range;
          if (bodies.some(([from, to]) => from <= start && end <= to)) continue;
          context.report({ loc: comment.loc, messageId: "outsideProbe" });
        }
      },
    };
  },
};