export const asFn = (f: unknown) => f as (s: string) => string;
export const asNew = (f: unknown) => f as new (s: string) => string;
export const asProp = (f: unknown) => f as { make(): string };
// A type parameter a parameter mentions is the caller's own value.
export const asTied = (f: unknown) => f as { run<T>(fn: () => T): T };
// A function that returns `never` does not come back.
export const asNever = (f: unknown) => f as () => Promise<never>;
