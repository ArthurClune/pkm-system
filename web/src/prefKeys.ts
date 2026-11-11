// pattern: Functional Core
// The localStorage keys and [off, on] strings of the stored on/off
// preferences. Users' browsers already hold these exact strings, so none of
// them may change: a different string reads as unknown, falls back, and
// overwrites the user's choice.

export const SIDEBAR_STORAGE_KEY = "pkm:sidebar";
export const SIDEBAR_VALUES = ["open", "collapsed"] as const;

export const BLOCK_STAMPS_STORAGE_KEY = "pkm:block-stamps";
export const BLOCK_STAMPS_VALUES = ["off", "on"] as const;
