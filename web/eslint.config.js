// Flat, type-aware ESLint config (config file: exempt from the FCIS header
// rule). Enforces exactly six policy families, no more, on product code,
// tests and tooling alike:
//   * React Hooks correctness (rules-of-hooks, exhaustive-deps) so hook
//     dependency arrays cannot silently drift out of sync with the effect
//     body -- this is what lets Task 10 delete every exhaustive-deps
//     suppression rather than hide behind it.
//   * A small set of type-aware promise/error rules that catch the classes
//     of bug the offline sync + concurrency shells are most exposed to:
//     floated promises, promise-valued void callbacks (e.g. React event
//     handlers), thrown non-Errors, and untyped caught errors.
//   * Import control: concrete JSON requests use typedClient, raw apiFetch
//     stays at the transport boundary, only tests import test-helpers,
//     test-mint, testDb and memReplica, and the Playwright specs, which
//     vitest cannot load into, mint through test-mint alone.
//   * No `any` flowing through production code (no-explicit-any and the
//     no-unsafe-* rules): an untyped JSON value reaching code that assumes
//     its shape fails at runtime instead of at the type check. Repo rules
//     (tooling/eslint-plugin-repo) hold `ReplicaDb.select` keys to a
//     literal, so a widened key type cannot claim columns the query lacks.
//   * Brand discipline (tooling/eslint-plugin-brands): a name that means a
//     brand carries it, brands are asserted only at their mint sites, and
//     `Reflect.apply` / `construct` / `set` and brand-named `Object.assign` /
//     `defineProperty` writes, or an alias of them, do not route around
//     either.
//   * No unchecked suppression of the type checker: `@ts-ignore` and
//     `@ts-nocheck` are banned and `@ts-expect-error` says why and sits only
//     in a `typeProbe(() => { ... })` block, whose body is type-checked but
//     never runs, so a test cannot silence a brand error the rules above
//     rely on tsc to raise or carry an off-type value into code that runs
//     (`offType<T>(v)` is the declared way to feed a runtime guard); that
//     rule is `repo/ts-expect-error-in-probe`.
// reportUnusedDisableDirectives is an error so a stale suppression can never
// linger: the "zero exhaustive-deps suppressions" invariant is enforced by
// tooling, not by convention.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import brands, { testFileGlobs } from "./tooling/eslint-plugin-brands/index.ts";
import repo from "./tooling/eslint-plugin-repo/index.ts";

const apiFetchBan = {
  group: ["**/api/client"],
  importNames: ["apiFetch"],
  message:
    "Use apiGet/apiPost/apiPut/apiDelete from api/typedClient; "
    + "raw apiFetch is reserved for transport boundaries.",
};

// Every spelling of the test helpers and the test mint module they
// re-export (`../test-helpers`, `./test-mint.ts`, `../test-helpers.js`),
// static or dynamic.
const TEST_HELPERS_MESSAGE =
  "test helpers mint brands without a parse; product code reads or parses "
  + "them";
const testHelpersBan = {
  group: ["**/test-helpers*", "**/test-mint*"],
  message: TEST_HELPERS_MESSAGE,
};
const testHelpersDynamicBan = {
  selector: "ImportExpression[source.value=/test-helpers|test-mint/]",
  message: TEST_HELPERS_MESSAGE,
};

// The database and replica fixtures are test code by location (the brand
// registry's testCode), so product code does not import them either.
const TEST_FIXTURES_MESSAGE =
  "testDb and memReplica are test code: product code takes a replica "
  + "through its interface and leaves the fixtures to tests";
const testFixturesBan = {
  group: ["**/testDb*", "**/memReplica*"],
  message: TEST_FIXTURES_MESSAGE,
};
const testFixturesDynamicBan = {
  selector: "ImportExpression[source.value=/testDb|memReplica/]",
  message: TEST_FIXTURES_MESSAGE,
};

// A template-literal source reads like a string but is not a Literal, so the
// two bans above never see it. Its text is checked here; a source built
// from a variable is left to the review of the caller.
const templateSourceBan = {
  selector:
    "ImportExpression > TemplateLiteral > "
    + "TemplateElement[value.raw=/test-helpers|test-mint|testDb|memReplica/]",
  message:
    "test code is not imported by product code, whatever the import() "
    + "spelling: " + TEST_HELPERS_MESSAGE + "; testDb and memReplica are "
    + "fixtures for tests",
};

// One project service serves every block: typescript-eslint builds it once,
// from the first file it parses, so the options are the same everywhere.
// playwright.config.ts sits in no tsconfig.json's `include` that the service
// finds (the nearest is web/tsconfig.json), so it falls to the default
// project, e2e/tsconfig.json.
const typed = {
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ["playwright.config.ts"],
        defaultProject: "e2e/tsconfig.json",
      },
      tsconfigRootDir: import.meta.dirname,
    },
  },
  linterOptions: {
    reportUnusedDisableDirectives: "error",
  },
};

const rules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "brands/name-carries-brand": "error",
  "brands/no-brand-assertion": "error",
  "brands/no-brand-bypass": "error",
  "repo/select-keys-literal": "error",
  "repo/ts-expect-error-in-probe": "error",
  "@typescript-eslint/ban-ts-comment": ["error", {
    "ts-ignore": true,
    "ts-nocheck": true,
    "ts-expect-error": "allow-with-description",
    "ts-check": false,
  }],
  "no-restricted-imports": ["error", {
    patterns: [apiFetchBan, testHelpersBan, testFixturesBan],
  }],
  "no-restricted-syntax": ["error",
    testHelpersDynamicBan, testFixturesDynamicBan, templateSourceBan],
};

const E2E_HELPERS_MESSAGE =
  "test-helpers imports vitest, which Playwright cannot load; mint from "
  + "src/test-mint";

export default tseslint.config(
  {
    // Global ignores (config object with only `ignores`): skipped entirely by
    // the CLI. The eslint-fixtures carry INTENTIONAL violations, so they must
    // never be linted by `pnpm lint`; lintConfig.test.ts reaches them with
    // `ignore: false` to assert each rule fires.
    ignores: [
      "dist/**",
      "dev-dist/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "tooling/eslint-fixtures/**",
      "**/*.d.ts",
    ],
  },
  // base only: registers the typescript-eslint parser + plugin so the
  // @typescript-eslint/* rules below resolve, WITHOUT pulling in any of the
  // recommended rule sets (that would be rule sprawl beyond the six policy
  // families named above).
  tseslint.configs.base,
  {
    // Tests and test support included: agents copy the code they read, and
    // tests are most of it.
    files: ["src/**/*.{ts,tsx}", "tooling/**/*.{ts,tsx,mjs}"],
    ...typed,
    plugins: { "react-hooks": reactHooks, brands, repo },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      ...rules,
    },
  },
  {
    // The Playwright specs and their config hold no React, and the fixture
    // callback Playwright names `use` is not a hook, so the hooks rules stay
    // off here.
    files: ["e2e/**/*.{ts,mjs}", "playwright.config.ts"],
    ...typed,
    plugins: { brands, repo },
    rules,
  },
  {
    // Transport boundaries may import apiFetch, but not the test helpers.
    files: [
      "src/api/typedClient.ts",
      "src/sync/assets.ts",
      "src/sync/SyncProvider.tsx",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [testHelpersBan, testFixturesBan] }],
    },
  },
  {
    // The outline engine sits below the UI: a type it needs from a
    // component lives in outline/. Replaces the base bans, so repeats them.
    files: ["src/outline/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [apiFetchBan, testHelpersBan, testFixturesBan, {
          group: ["**/components/*", "**/views/*", "**/dnd/*"],
          message: "the outline engine imports no UI code; put the type "
            + "in outline/",
        }],
      }],
    },
  },
  {
    // Tests by name and by location (the brand registry's testCode) may
    // import the test mint module. After the product blocks, so none of
    // them takes that back; a transport-layer test that needs apiFetch, and
    // the e2e specs, which may not load vitest, get their own blocks after
    // this one.
    files: testFileGlobs,
    rules: {
      "no-restricted-imports": ["error", { patterns: [apiFetchBan] }],
      "no-restricted-syntax": "off",
    },
  },
  {
    // Tests that stub the transport itself: typedClient calls apiFetch, so a
    // view test that mocks the network at that seam must import it.
    files: [
      "src/components/PageTitle.test.tsx",
      "src/sync/SyncProvider.test.tsx",
      "src/views/Files.test.tsx",
      "src/views/Settings.test.tsx",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // test-helpers imports vitest, which fails to load under Playwright.
    // The static import, import() and a template-literal source are all
    // closed.
    files: ["e2e/**/*.{ts,mjs}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [apiFetchBan, {
        group: ["**/test-helpers*"],
        message: E2E_HELPERS_MESSAGE,
      }] }],
      "no-restricted-syntax": ["error", {
        selector: "ImportExpression[source.value=/test-helpers/]",
        message: E2E_HELPERS_MESSAGE,
      }, {
        selector: "ImportExpression > TemplateLiteral > "
          + "TemplateElement[value.raw=/test-helpers/]",
        message: E2E_HELPERS_MESSAGE,
      }],
    },
  },
);
