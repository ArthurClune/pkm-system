import type { BlockUid } from "../../src/api/brands";

export const asFn = (f: unknown) => f as (s: string) => BlockUid;
export const asNew = (f: unknown) => f as new (s: string) => BlockUid;
export const asProp = (f: unknown) => f as { make(): BlockUid };
export const asCallable = (f: unknown) => f as { (s: string): BlockUid };
export const asLater = (f: unknown) => f as () => Promise<BlockUid>;
export const asGeneric = (f: unknown) => f as <T>(s: string) => T;
export const asNewGeneric = (f: unknown) => f as new <T>() => T;
export const asMethodGeneric = (f: unknown) => f as { get<T>(s: string): T };
