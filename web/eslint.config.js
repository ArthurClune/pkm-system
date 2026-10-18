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
//     stays at the transport boundary, and only tests import test-helpers.
//   * No `any` flowing through production code (no-explicit-any and the
//     no-unsafe-* rules): an untyped JSON value reaching code that assumes
//     its shape fails at runtime instead of at the type check.
//   * Brand discipline (tooling/eslint-plugin-brands): a name that means a
//     brand carries it, and brands are asserted only at their mint sites.
//   * No unchecked suppression of the type checker: `@ts-ignore` and
//     `@ts-nocheck` are banned and `@ts-expect-error` says why, so a test
//     cannot silence a brand error the rules above rely on tsc to raise.
// reportUnusedDisableDirectives is an error so a stale suppression can never
// linger: the "zero exhaustive-deps suppressions" invariant is enforced by
// tooling, not by convention.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import brands, { testFileGlobs } from "./tooling/eslint-plugin-brands/index.mjs";

const apiFetchBan = {
  group: ["**/api/client"],
  importNames: ["apiFetch"],
  message:
    "Use apiGet/apiPost/apiPut/apiDelete from api/typedClient; "
    + "raw apiFetch is reserved for transport boundaries.",
};

// Every spelling of the module (`../test-helpers`, `./test-helpers.ts`,
// `../test-helpers.js`), static or dynamic.
const TEST_HELPERS_MESSAGE =
  "test helpers mint brands without a parse; product code reads or parses "
  + "them";
const testHelpersBan = {
  group: ["**/test-helpers*"],
  message: TEST_HELPERS_MESSAGE,
};
const testHelpersDynamicBan = {
  selector: "ImportExpression[source.value=/test-helpers/]",
  message: TEST_HELPERS_MESSAGE,
};

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
    files: ["src/**/*.{ts,tsx}", "tooling/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: {
      "react-hooks": reactHooks,
      brands,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
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
      "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-ignore": true,
        "ts-nocheck": true,
        "ts-expect-error": "allow-with-description",
        "ts-check": false,
      }],
      "no-restricted-imports": ["error", {
        patterns: [apiFetchBan, testHelpersBan],
      }],
      "no-restricted-syntax": ["error", testHelpersDynamicBan],
    },
  },
  {
    // Transport boundaries may import apiFetch, but not the test helpers.
    files: [
      "src/api/typedClient.ts",
      "src/sync/assets.ts",
      "src/sync/SyncProvider.tsx",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [testHelpersBan] }],
    },
  },
  {
    // Tests by name and by location (the brand registry's testCode) may
    // import the test mint module. Last, so a later override cannot take
    // that back; a transport-layer test that needs apiFetch gets its own
    // block after this one.
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
);
