// Flat, type-aware ESLint config (config file: exempt from the FCIS header
// rule). Enforces exactly five policy families, no more:
//   * React Hooks correctness (rules-of-hooks, exhaustive-deps) so hook
//     dependency arrays cannot silently drift out of sync with the effect
//     body -- this is what lets Task 10 delete every exhaustive-deps
//     suppression rather than hide behind it.
//   * A small set of type-aware promise/error rules that catch the classes
//     of bug the offline sync + concurrency shells are most exposed to:
//     floated promises, promise-valued void callbacks (e.g. React event
//     handlers), thrown non-Errors, and untyped caught errors.
//   * API-boundary import control: concrete JSON requests use typedClient;
//     raw apiFetch stays at the transport boundary.
//   * No `any` flowing through production code (no-explicit-any and the
//     no-unsafe-* rules): an untyped JSON value reaching code that assumes
//     its shape fails at runtime instead of at the type check.
//   * Brand discipline (tooling/eslint-plugin-brands): a name that means a
//     brand carries it, and brands are asserted only at their mint sites.
// reportUnusedDisableDirectives is an error so a stale suppression can never
// linger: the "zero exhaustive-deps suppressions" invariant is enforced by
// tooling, not by convention.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import brands from "./tooling/eslint-plugin-brands/index.mjs";

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
  // recommended rule sets (that would be rule sprawl beyond the four named
  // policy families this task is scoped to).
  tseslint.configs.base,
  {
    files: ["src/**/*.{ts,tsx}", "tooling/**/*.{ts,tsx}"],
    // Test/support files are exercised by vitest and Playwright, not shipped;
    // keep the type-aware promise rules focused on production + tooling code.
    ignores: [
      "**/*.test.{ts,tsx}",
      "src/test-setup.ts",
      "src/test-helpers.ts",
    ],
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
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/api/client"],
          importNames: ["apiFetch"],
          message:
            "Use apiGet/apiPost/apiPut/apiDelete from api/typedClient; "
            + "raw apiFetch is reserved for transport boundaries.",
        }],
      }],
    },
  },
  {
    files: [
      "src/api/typedClient.ts",
      "src/sync/assets.ts",
      "src/sync/SyncProvider.tsx",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
