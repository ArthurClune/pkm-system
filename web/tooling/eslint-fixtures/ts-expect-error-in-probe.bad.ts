import { typeProbe } from "../../src/test-helpers";

const count: number = 1;

// a bare suppression statement
// @ts-expect-error -- a string where a number goes
export const bare: number = "x";

// inside a callback that runs
export const inRunner = () => {
  // @ts-expect-error -- a string where a number goes
  const n: number = "x";
  return n;
};

// inside a local lookalike of the probe
function typeProbeLocal(f: () => void): void { f(); }
export const lookalike = (typeProbe: (f: () => void) => void) => {
  typeProbe(() => {
    // @ts-expect-error -- a string where a number goes
    const n: number = "x";
    return n;
  });
  typeProbeLocal(() => {
    // @ts-expect-error -- a string where a number goes
    const n: number = "x";
    return n;
  });
};

// a probe body passed by reference
const body = () => {
  // @ts-expect-error -- a string where a number goes
  const n: number = "x";
  return n;
};
typeProbe(body);

// a block comment is the same directive
/* @ts-expect-error -- a string where a number goes */
export const block: number = "x";

// not a suppression: the text only mentions @ts-expect-error mid-line
export const text = count;
