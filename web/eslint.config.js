// Flat, type-aware ESLint config (config file: exempt from the FCIS header
// rule). Enforces exactly two rule families, no more:
//   * React Hooks correctness (rules-of-hooks, exhaustive-deps) so hook
//     dependency arrays cannot silently drift out of sync with the effect
//     body -- this is what lets Task 10 delete every exhaustive-deps
//     suppression rather than hide behind it.
//   * A small set of type-aware promise/error rules that catch the classes
//     of bug the offline sync + concurrency shells are most exposed to:
//     floated promises, promise-valued void callbacks (e.g. React event
//     handlers), thrown non-Errors, and untyped caught errors.
// reportUnusedDisableDirectives is an error so a stale suppression can never
// linger: the "zero exhaustive-deps suppressions" invariant is enforced by
// tooling, not by convention.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

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
  // recommended rule sets (that would be rule sprawl beyond the two named
  // families this task is scoped to).
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
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
    },
  },
);
