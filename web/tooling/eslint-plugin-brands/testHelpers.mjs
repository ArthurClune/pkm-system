// pattern: Imperative Shell
// The test helpers module and its `offType` escape hatch, which the brand rules
// treat as a mint site and the repo plugin's probe rule recognises.
export const TEST_HELPERS_SOURCE = /(?:^|\/)test-helpers(?:\.[cm]?[jt]sx?)?$/;
export const OFF_TYPE = "offType";
export const OFF_TYPE_DEPTH = 4;
