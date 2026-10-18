// Types for the brands plugin's exports, for the type-aware lint over
// lintConfig.test.ts and eslint.config.js. Keep in step with index.mjs.
import type { ESLint } from "eslint";

/** Whether `path` (repo-relative, posix) may mint `brand`. */
export function isMintSite(brand: string, path: string): boolean;
/** A test by name (`*.test.*`) or by location in the registry's `testCode`. */
export function isTestCode(path: string): boolean;
/** A matcher for a registry path pattern (a directory prefix or a glob). */
export function pathMatcher(pattern: string): (path: string) => boolean;
/** The repo-relative posix path of a file ESLint hands the plugin. */
export function repoPath(filename: string): string;
/** The web's test files as flat-config globs, relative to the web root. */
export const testFileGlobs: string[];

declare const plugin: ESLint.Plugin;
export default plugin;
