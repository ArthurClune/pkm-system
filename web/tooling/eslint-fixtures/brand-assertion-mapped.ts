import type { BlockUid } from "../../src/api/brands";

interface Cols {
  uid: BlockUid;
  text: string;
}

export function partial(v: unknown): unknown {
  return v as Partial<Cols>;
}
export function record(v: unknown): unknown {
  return v as Record<string, BlockUid>;
}
export function indexed(v: unknown): unknown {
  return v as { [k: string]: BlockUid };
}
export function picked(v: unknown): unknown {
  return v as Pick<Cols, "uid">[];
}
