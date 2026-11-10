// pattern: Imperative Shell
// the keys argument of `ReplicaDb.select` is
// an array literal of string literals, or an array or tuple whose
// element type is a type parameter inside a method or property named
// `select` (a wrapper passing its generic keys through). Any other
// array could widen K to every column. Not a brand rule; it lives here
// as the repo's type-aware rule home.
import ts from "typescript";
import { servicesOf } from "./types.mjs";

const SELECT_KEYS_MESSAGES = {
  spreadArgs:
    "`select` is called with spread arguments, so its keys are not seen: "
    + "write `db.select(sql, [\"a\", \"b\"], params)`",
  computed:
    "`select` is reached through a computed property, so its keys are not "
    + "checked: call `db.select(...)` directly",
  notLiteral:
    "ReplicaDb.select takes its keys as an array literal of string "
    + "literals (or a generic K passed through unchanged by a `select` "
    + "implementation): any other array types every column as present",
  element:
    "an element of the keys array is not a string literal (a spread, hole "
    + "or expression could name a column the query does not return)",
};

export const selectKeysLiteral = {
  meta: {
    type: "problem",
    schema: [],
    messages: SELECT_KEYS_MESSAGES,
  },
  create(context) {
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const typeOf = (node) =>
      checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(node));
    // Whether `member.<name>` is the `select` method of the ReplicaDb
    // interface, found by declaration so any type that extends it counts.
    const isReplicaDbSelect = (object) => {
      const decl = typeOf(object).getProperty("select")?.declarations?.[0];
      return decl !== undefined && ts.isMethodSignature(decl)
        && ts.isInterfaceDeclaration(decl.parent)
        && decl.parent.name.text === "ReplicaDb";
    };
    const hasTypeParameterElements = (type) => {
      const flagged = (t) => (t.flags & ts.TypeFlags.TypeParameter) !== 0;
      if (checker.isArrayType(type)) {
        return flagged(checker.getTypeArguments(type)[0]);
      }
      if (checker.isTupleType(type)) {
        const elements = checker.getTypeArguments(type);
        return elements.length > 0 && elements.every(flagged);
      }
      return false;
    };
    // Whether the nearest enclosing function is a `select` implementation:
    // a method, or the value of a property, named `select`. Only there can
    // a generic K forwarded unchanged have come from a checked caller.
    const inSelectImplementation = (node) => {
      const ancestors = context.sourceCode.getAncestors(node);
      const fn = ancestors.findLast((a) => /Function/.test(a.type));
      const holder = fn === undefined ? undefined : ancestors[ancestors.indexOf(fn) - 1];
      if (holder === undefined || fn.parent !== holder) return false;
      if (holder.type !== "Property" && holder.type !== "MethodDefinition") {
        return false;
      }
      if (holder.value !== fn) return false;
      const key = holder.key;
      return holder.computed
        ? key.type === "Literal" && key.value === "select"
        : key.type === "Identifier" && key.name === "select";
    };
    return {
      CallExpression(node) {
        const callee = node.callee.type === "ChainExpression"
          ? node.callee.expression : node.callee;
        if (callee.type !== "MemberExpression") return;
        if (!isReplicaDbSelect(callee.object)) return;
        if (callee.computed) {
          const p = callee.property;
          const named = p.type === "Literal" && typeof p.value === "string"
            ? p.value
            : p.type === "TemplateLiteral" && p.expressions.length === 0
              ? p.quasis[0].value.cooked : null;
          if (named !== null && named !== "select") return;
          context.report({ node, messageId: "computed" });
          return;
        }
        if (callee.property.type !== "Identifier"
          || callee.property.name !== "select") return;
        if (node.arguments.some((a) => a.type === "SpreadElement")) {
          context.report({ node, messageId: "spreadArgs" });
          return;
        }
        if (node.arguments.length < 2) return;
        const keys = node.arguments[1];
        if (keys.type === "ArrayExpression") {
          for (const el of keys.elements) {
            if (el === null || el.type !== "Literal"
              || typeof el.value !== "string") {
              context.report({ node: el ?? keys, messageId: "element" });
            }
          }
          return;
        }
        if (!(hasTypeParameterElements(typeOf(keys))
          && inSelectImplementation(node))) {
          context.report({ node: keys, messageId: "notLiteral" });
        }
      },
    };
  },
};