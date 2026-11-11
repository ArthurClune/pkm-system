// pattern: Imperative Shell
// ESLint rules specific to this repo that are not about brands, kept apart
// from the brand plugin so its registry and type analysis stay one concern.
import { selectKeysLiteral } from "./selectKeysLiteral.ts";
import { tsExpectErrorInProbe } from "./tsExpectErrorInProbe.ts";

export default {
  rules: {
    "select-keys-literal": selectKeysLiteral,
    "ts-expect-error-in-probe": tsExpectErrorInProbe,
  },
};
