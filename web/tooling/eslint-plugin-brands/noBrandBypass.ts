// pattern: Imperative Shell
// brands/no-brand-bypass: `Reflect.apply`, and a brand-named field
// written through `Object.assign` or `Object.defineProperty`, which skip
// the checks the two rules above rely on tsc to raise.
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";
import { isMintSite, isTestCode, registry, repoPath } from "./registry.ts";
import { declaresBrand, servicesOf } from "./types.ts";
import { brandText, remedy } from "./remedy.ts";

// `Object.assign`, `Object.defineProperty` and `Reflect.set` write a field
// past the type the object was declared with, and `Reflect.apply` and
// `Reflect.construct` call past the parameter types, so each puts an
// off-type value into a branded slot that neither tsc nor the rules above
// see. The two calls are reported outright. A write is reported when its
// key means a brand and its value is not already that brand: an
// `Object.assign` source (a literal's properties, or the properties of any
// other source's type), the descriptor of `defineProperty` (a getter has no
// value to check), and `Reflect.set`'s value. A key that is only a `string`
// at the call is unknown here and not reported. A reference to one of these
// functions that is not the callee of a call (`const { assign } = Object`,
// `const R = Reflect`, `.call`) is reported, so no alias hides a call.
type Base = "Object" | "Reflect";
const WATCHED: Record<Base, Set<string>> = {
  Object: new Set(["assign", "defineProperty", "defineProperties"]),
  Reflect: new Set(["apply", "construct", "set", "defineProperty"]),
};
const isBase = (name: string): name is Base =>
  name === "Object" || name === "Reflect";
const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike
  | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike
  | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike;
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);
// `typeof Object`, `x instanceof Object`, `x === Object` and `Object(x)`
// read the constructor without reaching the functions on it.
const SAFE_BASE_PARENTS = new Set([
  "BinaryExpression", "UnaryExpression", "TSTypeQuery",
]);
const TYPE_PARENT = /^TS(TypeReference|QualifiedName|ExpressionWithTypeArguments|InterfaceHeritage|ClassImplements)$/;

type MessageIds = "call" | "write" | "alias";

export const noBrandBypass: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      call:
        "`{{api}}` calls past the parameter types, so a value that is not a "
        + "brand can reach a branded parameter: call the function directly, "
        + "or `.call` / `.apply` it",
      write:
        "`{{api}}` writes `{{name}}`, a name that means {{brand}}, without "
        + "the type check: put `{{name}}` in the object's own literal so the "
        + "type is checked, with a value that already is {{brand}}; "
        + "{{remedy}}",
      alias:
        "`{{base}}` is used other than to call one of its functions "
        + "directly: an alias (a variable, destructuring, an argument, "
        + "`.call`) hides `{{base}}.assign`, `defineProperty`, `apply` and "
        + "the rest from the bypass rule, so call them as `{{base}}.<name>(...)`",
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const tsNodeOf = (node: TSESTree.Node) => esTreeNodeToTSNodeMap.get(node);
    const typeOf = (node: TSESTree.Node) => checker.getTypeAtLocation(tsNodeOf(node));
    const staticText = (node: TSESTree.Node) => {
      if (node.type === "Literal" && typeof node.value === "string") {
        return node.value;
      }
      if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
        return node.quasis[0].value.cooked ?? null;
      }
      return null;
    };
    // The name `Object.assign` or `Object["assign"]` selects.
    const memberName = (member: TSESTree.MemberExpression) => {
      if (!member.computed && member.property.type === "Identifier") {
        return member.property.name;
      }
      return member.computed ? staticText(member.property) : null;
    };
    // Whether `id` is the global `Object`, not a local that shadows it.
    const isGlobal = (id: TSESTree.Identifier) => {
      for (let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(id); scope;
        scope = scope.upper) {
        const variable = scope.set.get(id.name);
        if (variable) return variable.defs.length === 0;
      }
      return true;
    };
    // "Object" or "Reflect" for `Object`, `globalThis.Object`, ...
    const baseOf = (node: TSESTree.Node): Base | null => {
      if (node.type === "Identifier") {
        return isBase(node.name) && isGlobal(node) ? node.name : null;
      }
      if (node.type !== "MemberExpression") return null;
      if (node.object.type !== "Identifier") return null;
      if (!GLOBAL_OBJECTS.has(node.object.name) || !isGlobal(node.object)) {
        return null;
      }
      const name = memberName(node);
      return name !== null && isBase(name) ? name : null;
    };
    const apiOf = (callee: TSESTree.Expression) => {
      if (callee.type !== "MemberExpression") return null;
      const base = baseOf(callee.object);
      const name = memberName(callee);
      return base !== null && name !== null && WATCHED[base].has(name)
        ? `${base}.${name}` : null;
    };
    const reportKey = (node: TSESTree.Node, api: string, name: string) => {
      const wanted = registry.names[name];
      if (wanted.every((b) => isMintSite(b, path))) return;
      context.report({
        node,
        messageId: "write",
        data: {
          api,
          name,
          brand: brandText(name, wanted),
          remedy: remedy(wanted, inTest),
        },
      });
    };
    const meansBrand = (name: string) => Object.hasOwn(registry.names, name);
    const holdsBrand = (valueNode: TSESTree.Node, name: string) =>
      declaresBrand(checker, typeOf(valueNode), registry.names[name]);
    // Report a brand-named `name` whose value node is not that brand.
    const checkValue = (
      node: TSESTree.Node, api: string, name: string,
      valueNode: TSESTree.Node | null | undefined,
    ) => {
      if (!meansBrand(name)) return;
      if (valueNode && holdsBrand(valueNode, name)) return;
      reportKey(node, api, name);
    };
    // A descriptor literal `{ value: x }` writes x; a getter, a non-literal
    // descriptor or no value writes something unchecked.
    const checkDescriptor = (
      node: TSESTree.Node, api: string, name: string,
      descriptor: TSESTree.Node | undefined,
    ) => {
      if (!meansBrand(name)) return;
      let valueNode: TSESTree.Node | null = null;
      if (descriptor?.type === "ObjectExpression") {
        const only = descriptor.properties.every((p) => p.type === "Property"
          && !p.computed && p.key.type === "Identifier"
          && ["value", "configurable", "enumerable", "writable"]
            .includes(p.key.name));
        const value = descriptor.properties.find((p) => p.type === "Property"
          && p.key.type === "Identifier" && p.key.name === "value");
        if (only && value?.type === "Property") valueNode = value.value;
      }
      checkValue(node, api, name, valueNode);
    };
    // The names an object literal sets, by identifier, string or computed
    // string key.
    const literalKeys = (
      obj: TSESTree.ObjectExpression,
    ): [TSESTree.Property, string][] => obj.properties.flatMap((p) => {
      if (p.type !== "Property") return [];
      let name: string | null = null;
      if (p.computed || p.key.type !== "Identifier") name = staticText(p.key);
      else name = p.key.name;
      if (name === null) return [];
      const pair: [TSESTree.Property, string] = [p, name];
      return [pair];
    });
    // The names a key argument can be: its text, or the string literals its
    // type is made of.
    const keyNames = (arg: TSESTree.Expression) => {
      const text = staticText(arg);
      if (text !== null) return [text];
      const type = typeOf(arg);
      const parts = type.isUnion() ? type.types : [type];
      const names: string[] = [];
      for (const t of parts) {
        if (!t.isStringLiteral()) return [];
        names.push(t.value);
      }
      return names;
    };
    // The properties of a source's type that mean a brand and do not hold it.
    const checkSource = (arg: TSESTree.Expression, api: string) => {
      const type = typeOf(arg);
      for (const symbol of checker.getPropertiesOfType(type)) {
        if (!meansBrand(symbol.name)) continue;
        const own = checker.getTypeOfSymbolAtLocation(symbol, tsNodeOf(arg));
        if (!declaresBrand(checker, own, registry.names[symbol.name])) {
          reportKey(arg, api, symbol.name);
        }
      }
    };
    const checkAssign = (node: TSESTree.CallExpression, api: string) => {
      for (const arg of node.arguments.slice(1)) {
        if (arg.type === "SpreadElement") continue;
        if (arg.type !== "ObjectExpression") {
          checkSource(arg, api);
          continue;
        }
        for (const p of arg.properties) {
          if (p.type === "SpreadElement") checkSource(p.argument, api);
        }
        for (const [prop, name] of literalKeys(arg)) {
          checkValue(prop, api, name, prop.method ? null : prop.value);
        }
      }
    };
    const checkKeyWrite = (
      node: TSESTree.CallExpression, api: string, descriptorAt: number,
    ) => {
      const [, key] = node.arguments;
      if (!key || key.type === "SpreadElement") return;
      for (const name of keyNames(key)) {
        if (api === "Reflect.set") {
          const value = node.arguments[2];
          checkValue(key, api, name, value?.type === "SpreadElement"
            ? null : value);
        }
        else checkDescriptor(key, api, name, node.arguments[descriptorAt]);
      }
    };
    // A use of the global `Object` or `Reflect` (`outer` is the name or the
    // `globalThis.` form of it) that is not a direct call of a watched
    // function.
    const checkBaseUse = (
      outer: TSESTree.Identifier | TSESTree.MemberExpression, base: Base,
    ) => {
      const parent = outer.parent;
      if (parent.type === "MemberExpression" && parent.object === outer) {
        const name = memberName(parent);
        if (name !== null && !WATCHED[base].has(name)) return;
        const grand = parent.parent;
        if (name !== null && grand.type === "CallExpression"
          && grand.callee === parent) return;
      }
      else if ((parent.type === "CallExpression"
        || parent.type === "NewExpression") && parent.callee === outer) return;
      else if (SAFE_BASE_PARENTS.has(parent.type)
        || TYPE_PARENT.test(parent.type)) return;
      context.report({ node: outer, messageId: "alias", data: { base } });
    };
    const isReference = (id: TSESTree.Identifier) => {
      const p = id.parent;
      if (p.type === "MemberExpression" && p.property === id && !p.computed) {
        return false;
      }
      if ((p.type === "Property" || p.type === "PropertyDefinition"
        || p.type === "MethodDefinition") && p.key === id && !p.computed
        && p.value !== id) return false;
      return true;
    };
    return {
      CallExpression(node) {
        const api = apiOf(node.callee);
        if (api === "Reflect.apply" || api === "Reflect.construct") {
          context.report({ node, messageId: "call", data: { api } });
        }
        else if (api === "Object.assign") checkAssign(node, api);
        else if (api === "Object.defineProperties") {
          const [, props] = node.arguments;
          if (props?.type !== "ObjectExpression") return;
          for (const [prop, name] of literalKeys(props)) {
            checkDescriptor(prop, api, name, prop.value);
          }
        }
        else if (api === "Object.defineProperty"
          || api === "Reflect.defineProperty" || api === "Reflect.set") {
          checkKeyWrite(node, api, 2);
        }
      },
      Identifier(node) {
        if (!isReference(node)) return;
        const base = baseOf(node);
        if (base !== null) checkBaseUse(node, base);
        else if (GLOBAL_OBJECTS.has(node.name) && isGlobal(node)) {
          // `globalThis` itself aliased: `const g = globalThis`.
          const p = node.parent;
          const member = p.type === "MemberExpression" && p.object === node;
          if (!member && p.type === "VariableDeclarator" && p.init === node) {
            context.report({ node, messageId: "alias",
              data: { base: "Object` or `Reflect" } });
          }
        }
      },
      MemberExpression(node) {
        const base = baseOf(node);
        if (base !== null && node.object.type === "Identifier") {
          checkBaseUse(node, base);
          return;
        }
        // `g.Object` on an alias of the global object: the name alone says
        // what it reaches, unless its type is a primitive the global is not
        // (`ts.TypeFlags.Object`, an enum member).
        const name = memberName(node);
        if (name !== null && isBase(name)
          && (typeOf(node).flags & PRIMITIVE) === 0) {
          context.report({ node, messageId: "alias", data: { base: name } });
        }
      },
    };
  },
};