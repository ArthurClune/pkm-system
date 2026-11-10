// pattern: Imperative Shell
// ESLint rules that keep brands honest on the web, the twin of the server's
// brand rules (docs/architecture/checks.md#brand-rules).
// The brand rules read tooling/brandRegistry.gen.json, generated from the
// server's brand registry, and all apply to tests as they do to product code.
import {
  isMintSite,
  isTestCode,
  pathMatcher,
  repoPath,
  testFileGlobs,
} from "./registry.mjs";
import { nameCarriesBrand } from "./nameCarriesBrand.mjs";
import { noBrandAssertion } from "./noBrandAssertion.mjs";
import { noBrandBypass } from "./noBrandBypass.mjs";

export { isMintSite, isTestCode, pathMatcher, repoPath, testFileGlobs };

export default {
  rules: {
    "name-carries-brand": nameCarriesBrand,
    "no-brand-assertion": noBrandAssertion,
    "no-brand-bypass": noBrandBypass,
  },
};
