// pattern: Imperative Shell
// brands/no-brand-assertion: `as`/`<T>` toward a type that contains a
// brand (directly or through a type parameter's constraint), a type
// predicate (`x is B`), an overload signature returning a brand its
// implementation does not, and a `declare`d value or function returning
// one are reported outside the brand's mint sites. A declaration is
// ambient when `declare` stands on it or on an ancestor (`declare
// global`, `declare namespace`, `declare class`) or the file is a
// declaration file. An interface merged with a class, or with a lib or
// dependency declaration, mints what its added members carry. A function
// or constructor type holds what it returns, so asserting to one mints
// through the return. An ambient function, field or variable, or a value
// that returns `any` (`JSON.parse`) where a function type with a generic
// return is wanted, launders: nothing the checker reads backs it. An
// assertion reports whatever its operand: an upcast is written as an
// annotated declaration
// (`const ys: readonly BlockUid[] = xs`). A predicate mints only what
// its narrowing adds to the parameter's declared type, and an overload
// what its return adds over the implementation's, compared position by
// position. An assertion, predicate or overload return toward `never`,
// toward a type parameter a caller can instantiate with a brand its
// constraint lacks (`T`, `T extends string`, `K extends "a"`), or
// toward `keyof T`, whose keys the caller picks (`keyof Record<BlockUid,
// 1>`), launders any value, also inside `T[]`, `{ v: T }`, `Promise<T>`
// ..., and is allowed only on a `brand: untrusted -- <reason>` line in
// an opt-out file. An opt-out covers one site, the leftmost needing one
// on its line or on the line below a comment standing alone; one that
// covers none is reported.
// The test mint module (`testMintSites`) is a mint site for every brand, and
// its exported `offType` alone may assert to a type parameter, which
// launders anywhere else. An `offType<T>(...)` call whose T is a brand (or a
// union, array, Set, Map key or index key of one) is reported in
// `no-brand-assertion`: a bad brand is forged with a `malformed*` helper. A
// brand nested in an object property does not count, but the argument's
// brand-named properties, nested to a fixed depth, must already be the brand.
// In test code (`*.test.*` and the registry's `testCode` paths) a report names
// the module's checked helper (`uidOf`) instead of the product remedy.
// `satisfies` and non-null `!` are not assertions toward a brand and are left
// alone.
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";
import {
  isMintSite,
  isTestCode,
  optOutFiles,
  registry,
  repoPath,
  testMintSites,
} from "./registry.ts";
import {
  anyReturning,
  cachedBrands,
  cachedLaunders,
  declaresBrand,
  genericReturn,
  inForeignFile,
  isArrayLike,
  isForeign,
  mintedBrands,
  servicesOf,
  shallowBrands,
  unbackedLaunder,
} from "./types.ts";
import { OPT_OUT_UNUSED, joinLedger } from "./optOut.ts";
import { remedy, webTestMints } from "./remedy.ts";
import {
  OFF_TYPE,
  OFF_TYPE_DEPTH,
  TEST_MINT_SOURCE,
} from "./testHelpers.ts";

type MessageIds =
  | "assertion" | "declaration" | "overload" | "launder" | "launderValue"
  | "optOutUnused" | "offTypeBrand" | "offTypeSlot";
type BrandMessage = "assertion" | "declaration" | "overload";

// A declaration TypeScript lets stand as an overload signature, and the
// node lists it and its implementation sit in.
type Overloadable =
  | ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
const isOverloadable = (n: ts.Node): n is Overloadable =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
  || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n)
  || ts.isSetAccessorDeclaration(n);
const siblingsOf = (parent: ts.Node): readonly ts.Node[] | undefined => {
  if (ts.isClassLike(parent)) return parent.members;
  if (ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent)
    || ts.isCaseOrDefaultClause(parent)) return parent.statements;
  return undefined;
};

export const noBrandAssertion: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      assertion:
        "assert to {{brand}} only at its mint site: {{remedy}}, or read it "
        + "from `select`",
      declaration:
        "declaring {{brand}} here mints it without a check: {{remedy}}, or "
        + "read it from `select`",
      overload:
        "this overload returns {{brand}} that its implementation does not: "
        + "return it from the implementation, {{remedy}}",
      launder:
        "asserting to `{{target}}` launders any value; parse it, or mark the "
        + "boundary with `// brand: untrusted -- <reason>` in a boundary "
        + "module",
      launderValue:
        "`{{type}}` returns whatever its caller names, and no body the "
        + "checker sees backs it: write a body that returns `unknown` or a "
        + "parsed value, or mark the boundary with `// brand: untrusted -- "
        + "<reason>` in a boundary module",
      optOutUnused: OPT_OUT_UNUSED,
      offTypeBrand:
        "`offType` would forge {{brand}}: {{remedy}}",
      offTypeSlot:
        "`offType`'s argument puts a value that is not {{brand}} in `{{name}}`, "
        + "a brand slot: {{remedy}}",
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const mayOptOut = optOutFiles.some((m) => m(path));
    const ledger = joinLedger(context);
    const inTestMint = testMintSites.some((m) => m(path));
    const typeOf = (estreeNode: TSESTree.Node) =>
      checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(estreeNode));
    const returnOf = (decl: ts.SignatureDeclaration) => {
      const signature = checker.getSignatureFromDeclaration(decl);
      return signature && checker.getReturnTypeOfSignature(signature);
    };
    // Report `brands` outside their mint sites.
    const report = (
      node: TSESTree.Node, brands: Iterable<string>, messageId: BrandMessage,
    ) => {
      const outside = [...brands].filter((b) => !isMintSite(b, path));
      if (outside.length === 0) return;
      context.report({
        node,
        messageId,
        data: { brand: outside.join(", "), remedy: remedy(outside, inTest) },
      });
    };
    const checkBrands = (node: TSESTree.Node, type: ts.Type, messageId: BrandMessage) =>
      report(node, cachedBrands(checker, type), messageId);
    // Whether `type` launders beyond what `from`, where given, already
    // holds; reported unless an opt-out line allows it.
    const reportLaunder = (node: TSESTree.Node, type: ts.Type, from?: ts.Type) => {
      if (!cachedLaunders(checker, type)) return false;
      if (from !== undefined && !unbackedLaunder(checker, from, type)) return false;
      ledger.site(node, (optOut) => {
        if (optOut === "reason" && mayOptOut) return;
        context.report({
          node,
          messageId: "launder",
          data: { target: checker.typeToString(type) },
        });
      });
      return true;
    };
    // The operand is not consulted: an upcast is an annotated declaration
    // (`const ys: readonly BlockUid[] = xs`), never an assertion.
    // Whether the assertion is in the body of the test mint module's
    // exported `offType`, the one declared junk mint: it asserts to its type
    // parameter, which launders anywhere else.
    const inOffType = (node: TSESTree.Node) => inTestMint
      && context.sourceCode.getAncestors(node).some((a) =>
        a.type === "FunctionDeclaration" && a.id?.name === OFF_TYPE
        && a.parent.type === "ExportNamedDeclaration");
    const check = (node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion) => {
      if (inOffType(node)) return;
      const target = node.typeAnnotation;
      if (target.type === "TSTypeReference"
        && target.typeName.type === "Identifier"
        && target.typeName.name === "const") {
        return;
      }
      const type = typeOf(target);
      if (!reportLaunder(node, type)) checkBrands(node, type, "assertion");
    };
    // A predicate mints what its narrowing adds to the parameter's declared
    // type: narrowing a union of ops to one op adds no brand, narrowing a
    // string (or `BlockUid | string`) to BlockUid adds one. Narrowing to a
    // laundering type (`x is T`) launders like `as T` where the parameter's
    // declared type does not hold the type parameter there (`x: unknown`,
    // `x: T | string`; not `x: T | null`), except on a function type (`type
    // Guard<T> = (v: string) => v is T`): that is a contract only another
    // predicate can fulfil, and the one that does is judged at its own
    // declaration.
    const BODILESS = new Set<string>([
      "TSFunctionType", "TSMethodSignature", "TSCallSignatureDeclaration",
    ]);
    const checkPredicate = (node: TSESTree.TSTypePredicate) => {
      const annotation = node.typeAnnotation?.typeAnnotation;
      if (!annotation) return;
      const narrowed = typeOf(annotation);
      const fn = node.parent?.parent;
      const params: readonly TSESTree.Node[] =
        fn !== undefined && "params" in fn ? fn.params : [];
      const name = node.parameterName.type === "Identifier"
        ? node.parameterName.name : undefined;
      const declared = params.map(
        (p) => (p.type === "AssignmentPattern" ? p.left : p),
      ).find((p) => p.type === "Identifier" && p.name === name);
      const declaredType = declared ? typeOf(declared) : undefined;
      const bodiless = fn !== undefined && BODILESS.has(fn.type);
      if (!bodiless && reportLaunder(node, narrowed, declaredType)) return;
      const minted = declaredType
        ? mintedBrands(checker, declaredType, narrowed)
        : cachedBrands(checker, narrowed);
      report(node, minted, "declaration");
    };
    // An overload signature's return type is what callers see, and nothing
    // checks it against the body: a brand it adds over the implementation's
    // return type is minted. TypeScript keeps an implementation right after
    // its overloads; a predicate overload is judged as a predicate.
    const checkOverload = (node: TSESTree.Node, tsNode: ts.Node) => {
      if (!isOverloadable(tsNode)) return;
      const siblings = siblingsOf(tsNode.parent);
      if (!siblings) return;
      const name = tsNode.name?.getText();
      const sameKind = (n: ts.Node | undefined): n is Overloadable =>
        n !== undefined && isOverloadable(n) && n.kind === tsNode.kind;
      let i = siblings.indexOf(tsNode) + 1;
      for (let sib = siblings.at(i); sameKind(sib) && sib.body === undefined;) {
        sib = siblings.at(++i);
      }
      const impl = siblings.at(i);
      if (!sameKind(impl) || impl.body === undefined
        || impl.name?.getText() !== name) return;
      const signature = checker.getSignatureFromDeclaration(tsNode);
      const implSignature = checker.getSignatureFromDeclaration(impl);
      if (!signature || !implSignature
        || checker.getTypePredicateOfSignature(signature)) return;
      // A type parameter in the return launders like `as T`, whatever the
      // implementation: nothing ties the overload's `T` to a value the
      // caller passed. The remedy is one generic signature with no
      // overload.
      const returned = checker.getReturnTypeOfSignature(signature);
      if (reportLaunder(node, returned)) return;
      report(node, mintedBrands(
        checker,
        checker.getReturnTypeOfSignature(implSignature),
        returned,
      ), "overload");
    };
    // Whether the node sits in an ambient context: `declare` on it or on an
    // ancestor (`declare namespace`, `declare global`, `declare class`), or
    // a declaration file. An ambient declaration asserts a value exists with
    // no body to check, however deep it is nested.
    const ambientFile = /\.d\.[cm]?ts$/.test(context.filename);
    const hasDeclare = (n: TSESTree.Node) => "declare" in n && n.declare === true;
    const isAmbient = (node: TSESTree.Node) => ambientFile || hasDeclare(node)
      || context.sourceCode.getAncestors(node).some((a) => hasDeclare(a)
        || a.type === "TSModuleDeclaration" && a.kind === "global");
    // A function a caller can ask to return anything, backed by no body the
    // checker sees (`declare function mk<T>(s: string): T`): reported like
    // an assertion toward `T`.
    const reportGenericValue = (node: TSESTree.Node, type: ts.Type) => {
      if (!genericReturn(checker, type)) return;
      ledger.site(node, (optOut) => {
        if (optOut === "reason" && mayOptOut) return;
        context.report({
          node,
          messageId: "launderValue",
          data: { type: checker.typeToString(type) },
        });
      });
    };
    // An ambient declaration mints what its type carries: nothing checks the
    // value behind it, and a generic return is whatever the caller names.
    const checkAmbient = (node: TSESTree.Node, type: ts.Type) => {
      checkBrands(node, type, "declaration");
      reportGenericValue(node, type);
    };
    // An ambient signature's own return, which `typeOf` of the whole
    // declaration (a function type) does not carry for a generic.
    const checkAmbientSignature = (
      node: TSESTree.TSDeclareFunction | TSESTree.MethodDefinition,
      returnType: TSESTree.TSTypeAnnotation | undefined,
    ) => {
      const annotation = returnType?.typeAnnotation;
      if (annotation && annotation.type !== "TSTypePredicate") {
        checkBrands(node, typeOf(annotation), "declaration");
      }
      const tsNode = esTreeNodeToTSNodeMap.get(node);
      if (!ts.isFunctionLike(tsNode)) return;
      const signature = checker.getSignatureFromDeclaration(tsNode);
      if (signature && !checker.getTypePredicateOfSignature(signature)) {
        reportGenericValue(node, checker.getTypeAtLocation(tsNode));
      }
    };
    // Without `declare`, a TSDeclareFunction is an overload signature.
    const checkDeclaredFunction = (node: TSESTree.TSDeclareFunction) => {
      if (isAmbient(node)) checkAmbientSignature(node, node.returnType);
      else checkOverload(node, esTreeNodeToTSNodeMap.get(node));
    };
    const checkMethodOverload = (node: TSESTree.MethodDefinition) => {
      if (node.value.type !== "TSEmptyBodyFunctionExpression") return;
      if (isAmbient(node)) checkAmbientSignature(node, node.value.returnType);
      else checkOverload(node, esTreeNodeToTSNodeMap.get(node));
    };
    const checkDeclaredVariable = (node: TSESTree.VariableDeclaration) => {
      if (!isAmbient(node)) return;
      for (const d of node.declarations) {
        if (d.id.typeAnnotation) checkAmbient(d, typeOf(d.id));
      }
    };
    // A value that is not a function expression, so no body the checker
    // reads backs it, where a generic-return function type is wanted and the
    // value returns `any` (`JSON.parse`), which fits any `T`.
    const BODIED = new Set<string>([
      "ArrowFunctionExpression", "FunctionExpression", "TSAsExpression",
      "TSTypeAssertion", "SpreadElement",
    ]);
    const checkValue = (value: TSESTree.Node, contextual: ts.Type | undefined) => {
      if (!contextual || !genericReturn(checker, contextual)) return;
      if (anyReturning(checker, typeOf(value))) {
        reportGenericValue(value, contextual);
      }
    };
    const checkContextual = (value: TSESTree.Node | null | undefined) => {
      if (!value || BODIED.has(value.type)) return;
      const tsValue = esTreeNodeToTSNodeMap.get(value);
      if (!ts.isExpression(tsValue)) return;
      checkValue(value, checker.getContextualType(tsValue));
    };
    // A `declare` field, or a field of an ambient class, has no initialiser
    // to check. A field with no annotation takes its type from its
    // initialiser, so the generic-return type is declared by a base class or
    // an interface the class implements.
    const checkField = (node: TSESTree.PropertyDefinition) => {
      const annotation = node.typeAnnotation?.typeAnnotation;
      if (annotation && isAmbient(node)) {
        checkAmbient(node, typeOf(annotation));
        return;
      }
      if (!node.value || BODIED.has(node.value.type)) return;
      if (annotation) {
        checkContextual(node.value);
        return;
      }
      const tsNode = esTreeNodeToTSNodeMap.get(node);
      const name = tsNode.name.getText();
      for (const clause of tsNode.parent.heritageClauses ?? []) {
        for (const heritage of clause.types) {
          const base = checker.getTypeAtLocation(heritage).getProperty(name);
          if (!base) continue;
          checkValue(node.value,
            checker.getTypeOfSymbolAtLocation(base, heritage));
        }
      }
    };
    // An interface merged with a class, or with a declaration in the lib or a
    // dependency (`declare global { interface Window { ... } }`), adds
    // members to a value that nothing checks: a new member mints what its
    // type carries, and a method re-declared with another return is an
    // unchecked overload, minting what it adds over each declaration it
    // overloads.
    const checkMerge = (node: TSESTree.TSInterfaceDeclaration) => {
      const tsNode = esTreeNodeToTSNodeMap.get(node);
      const merges = (checker.getSymbolAtLocation(tsNode.name)?.declarations ?? [])
        .some((d) => d !== tsNode && (ts.isClassLike(d) || inForeignFile(d)));
      if (!merges) return;
      for (const member of node.body.body) {
        const tsMember = esTreeNodeToTSNodeMap.get(member);
        if (!tsMember.name) continue;
        const peers = (checker.getSymbolAtLocation(tsMember.name)?.declarations
          ?? []).filter((d) => d !== tsMember);
        if (peers.length === 0) {
          report(member, cachedBrands(
            checker, checker.getTypeAtLocation(tsMember)), "declaration");
          continue;
        }
        if (!ts.isMethodSignature(tsMember)) continue;
        const returned = returnOf(tsMember);
        if (returned === undefined) continue;
        let minted: Set<string> | undefined;
        for (const peer of peers) {
          const peerReturn = ts.isMethodDeclaration(peer) || ts.isMethodSignature(peer)
            ? returnOf(peer) : undefined;
          const gained = peerReturn !== undefined
            ? mintedBrands(checker, peerReturn, returned)
            : cachedBrands(checker, returned);
          minted = minted === undefined
            ? gained : new Set([...minted].filter((b) => gained.has(b)));
        }
        report(member, minted ?? [], "declaration");
      }
    };
    return {
      CallExpression(node) {
        node.arguments.forEach(checkContextual);
        if (node.callee.type !== "Identifier" || node.callee.name !== OFF_TYPE) {
          return;
        }
        const decl = checker.getResolvedSignature(
          esTreeNodeToTSNodeMap.get(node))?.declaration;
        if (decl === undefined || !TEST_MINT_SOURCE.test(
          decl.getSourceFile().fileName.replace(/\.[cm]?[jt]sx?$/, ""))) return;
        const forged = (brands: readonly string[]) => {
          const forgers = brands.map((b) => registry.malformed[b])
            .filter((stem) => stem !== undefined)
            .map((stem) => `malformed${stem[0].toUpperCase()}${stem.slice(1)}`);
          return forgers.length === brands.length
            ? `use ${forgers.join(" or ")} from ${webTestMints.join(", ")}`
            : "forge a bad brand with a malformed helper, adding one to "
              + `the test mint module (${webTestMints.join(", ")}) if the `
              + "brand has none";
        };
        const brands = [...shallowBrands(checker, typeOf(node))];
        if (brands.length > 0) {
          context.report({
            node,
            messageId: "offTypeBrand",
            data: { brand: brands.join(", "), remedy: forged(brands) },
          });
        }
        // The argument's own brand-named properties, through nested objects,
        // arrays and unions to a fixed depth, whatever the argument's source.
        const arg = node.arguments[0];
        if (arg === undefined || arg.type === "SpreadElement") return;
        const walk = (type: ts.Type, depth: number): void => {
          if (depth > OFF_TYPE_DEPTH) return;
          if (type.isUnion()) return type.types.forEach((m) => walk(m, depth));
          if (isArrayLike(checker, type)) {
            return checker.getTypeArguments(type)
              .forEach((m) => walk(m, depth + 1));
          }
          if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))
            || isForeign(type)) {
            return undefined;
          }
          for (const symbol of checker.getPropertiesOfType(type)) {
            const own = checker.getTypeOfSymbolAtLocation(
              symbol, esTreeNodeToTSNodeMap.get(arg));
            if (Object.hasOwn(registry.names, symbol.name)
              && !declaresBrand(checker, own, registry.names[symbol.name])) {
              context.report({
                node: arg,
                messageId: "offTypeSlot",
                data: {
                  name: symbol.name,
                  brand: registry.names[symbol.name].join(" or "),
                  remedy: forged(registry.names[symbol.name]),
                },
              });
            }
            walk(own, depth + 1);
          }
          return undefined;
        };
        walk(typeOf(arg), 0);
      },
      TSAsExpression: check,
      TSTypeAssertion: check,
      TSTypePredicate: checkPredicate,
      TSDeclareFunction: checkDeclaredFunction,
      MethodDefinition: checkMethodOverload,
      VariableDeclaration: checkDeclaredVariable,
      NewExpression(node) {
        node.arguments.forEach(checkContextual);
      },
      VariableDeclarator(node) {
        checkContextual(node.init);
      },
      PropertyDefinition: checkField,
      Property(node) {
        checkContextual(node.value);
      },
      AssignmentExpression(node) {
        if (node.operator === "=") checkContextual(node.right);
      },
      ReturnStatement(node) {
        checkContextual(node.argument);
      },
      TSInterfaceDeclaration: checkMerge,
      "Program:exit": ledger.exit,
    };
  },
};