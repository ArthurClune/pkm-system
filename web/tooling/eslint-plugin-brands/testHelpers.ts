// pattern: Imperative Shell
// The test helpers module, which the repo plugin's probe rule recognises as
// `typeProbe`'s home, and the test mint module, whose `offType` escape hatch
// the brand rules treat as a mint site.
export const TEST_HELPERS_SOURCE = /(?:^|\/)test-helpers(?:\.[cm]?[jt]sx?)?$/;
export const TEST_MINT_SOURCE = /(?:^|\/)test-mint$/;
export const OFF_TYPE = "offType";
export const OFF_TYPE_DEPTH = 4;
