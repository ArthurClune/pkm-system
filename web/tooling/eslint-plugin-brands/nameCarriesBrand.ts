// pattern: Imperative Shell
// brands/name-carries-brand: a parameter, property signature or class
// property whose name means a brand (uid, pageId, sha ...) must be
// declared with exactly that brand (or null, or an array of it).
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import type ts from "typescript";
import { brandsNamed, isTestCode, optOutFiles, repoPath } from "./registry.ts";
import { declaresBrand, servicesOf } from "./types.ts";
import { OPT_OUT_UNUSED, joinLedger } from "./optOut.ts";
import { brandText, remedy } from "./remedy.ts";

type MessageIds = "missing" | "optOut" | "noReason" | "optOutUnused";

type FunctionLike =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression
  | TSESTree.TSFunctionType
  | TSESTree.TSConstructorType
  | TSESTree.TSMethodSignature
  | TSESTree.TSCallSignatureDeclaration
  | TSESTree.TSConstructSignatureDeclaration
  | TSESTree.TSDeclareFunction
  | TSESTree.TSEmptyBodyFunctionExpression;

export const nameCarriesBrand: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing:
        "`{{name}}` must be `{{brand}}`: read it from a replica `select` row, "
        + "take it from a generated API type, or {{remedy}}",
      optOut:
        "`{{name}}` must be `{{brand}}`: `brand: untrusted` is allowed only "
        + "in the registry's opt-out files, not here",
      noReason:
        "`{{name}}` is `brand: untrusted` with no reason: add a reason after "
        + "`--` saying what untrusted input is parsed here",
      optOutUnused: OPT_OUT_UNUSED,
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const mayOptOut = optOutFiles.some((m) => m(path));
    const ledger = joinLedger(context);

    const check = (name: string, anchor: TSESTree.Node, tsNode: ts.Node) => {
      const wanted = brandsNamed(name);
      if (!wanted) return;
      const type = checker.getTypeAtLocation(tsNode);
      if (declaresBrand(checker, type, wanted)) return;
      const data: Record<string, string> = {
        name,
        brand: brandText(name, wanted),
        remedy: remedy(wanted, inTest),
      };
      ledger.site(anchor, (optOut) => {
        if (optOut === "reason" && mayOptOut) return;
        let messageId: MessageIds = "missing";
        if (optOut === "reason") messageId = "optOut";
        else if (optOut === "bare" && mayOptOut) messageId = "noReason";
        context.report({ node: anchor, messageId, data });
      });
    };
    const keyName = (
      member: TSESTree.TSPropertySignature | TSESTree.PropertyDefinition,
    ) => {
      const key = member.key;
      if (member.computed) return null;
      if (key.type === "Identifier") return key.name;
      if (key.type === "Literal" && typeof key.value === "string") {
        return key.value;
      }
      return null;
    };
    const checkParam = (param: TSESTree.Parameter) => {
      let id: TSESTree.Node = param;
      if (id.type === "TSParameterProperty") id = id.parameter;
      if (id.type === "AssignmentPattern") id = id.left;
      if (id.type === "RestElement") id = id.argument;
      if (id.type !== "Identifier") return;
      check(id.name, id, esTreeNodeToTSNodeMap.get(id));
    };
    const checkFunction = (node: FunctionLike) => node.params.forEach(checkParam);
    const checkMember = (
      node: TSESTree.TSPropertySignature | TSESTree.PropertyDefinition,
    ) => {
      const name = keyName(node);
      if (name !== null) check(name, node, esTreeNodeToTSNodeMap.get(node));
    };
    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      TSFunctionType: checkFunction,
      TSConstructorType: checkFunction,
      TSMethodSignature: checkFunction,
      TSCallSignatureDeclaration: checkFunction,
      TSConstructSignatureDeclaration: checkFunction,
      TSDeclareFunction: checkFunction,
      TSEmptyBodyFunctionExpression: checkFunction,
      TSPropertySignature: checkMember,
      PropertyDefinition: checkMember,
      "Program:exit": ledger.exit,
    };
  },
};