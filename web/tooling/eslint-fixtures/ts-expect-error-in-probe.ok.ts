import { typeProbe } from "./test-helpers";
typeProbe(() => {
  // @ts-expect-error -- a string where a number goes
  const n: number = "x";
  return n;
});
