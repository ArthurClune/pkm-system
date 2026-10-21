// A cap on fast-check's `.filter`. fast-check generates a filtered value by
// drawing until the predicate accepts one, with no limit, so a predicate that
// rejects every value spins the worker forever. The loop is synchronous: no
// vitest timeout can interrupt it, and the worker outlives a killed parent
// (orphanWatchdog.ts ends those). fast-check offers no generation hook or
// retry limit, so `capFilters` replaces `Arbitrary.prototype.filter` with
// this arbitrary, built only on the public custom-arbitrary API, which
// throws after MAX_FILTER_REJECTIONS draws in a row.
import fc from "fast-check";

// High enough that a filter accepting even one value in a hundred never
// reaches it by chance; low enough that it fails within seconds.
export const MAX_FILTER_REJECTIONS = 10_000;

export class CappedFilterArbitrary<T> extends fc.Arbitrary<T> {
  constructor(
    private readonly arb: fc.Arbitrary<T>,
    private readonly predicate: (t: T) => boolean,
  ) {
    super();
  }

  generate(mrng: fc.Random, biasFactor: number | undefined): fc.Value<T> {
    for (let i = 0; i < MAX_FILTER_REJECTIONS; i++) {
      const g = this.arb.generate(mrng, biasFactor);
      if (this.predicate(g.value)) return g;
    }
    throw new Error(
      `filter rejected ${MAX_FILTER_REJECTIONS} generated values in a row: `
      + "its predicate likely rejects every value the arbitrary draws. Build "
      + "only acceptable values (.map to a fallback), or use fc.pre in the "
      + "property for a rare case.");
  }

  // brand: untrusted -- fast-check's signature; the wrapped arbitrary checks
  canShrinkWithoutContext(value: unknown): value is T {
    return this.arb.canShrinkWithoutContext(value) && this.predicate(value);
  }

  shrink(value: T, context: unknown): fc.Stream<fc.Value<T>> {
    return this.arb.shrink(value, context)
      .filter((v) => this.predicate(v.value));
  }
}

export function capFilters(): void {
  Object.defineProperty(fc.Arbitrary.prototype, "filter", {
    configurable: true,
    writable: true,
    value: function filter<T>(
      this: fc.Arbitrary<T>, predicate: (t: T) => boolean,
    ): fc.Arbitrary<T> {
      return new CappedFilterArbitrary(this, predicate);
    },
  });
}
