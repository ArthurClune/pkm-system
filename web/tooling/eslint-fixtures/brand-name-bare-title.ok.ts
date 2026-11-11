import type { CanonicalTitle, RawTitle } from "../../src/api/brands";
export function bare(title: CanonicalTitle): void {
  void title;
}
export const names: RawTitle[] = [];
names.forEach((title) => {
  void title;
});
export function ok<T extends RawTitle>(title: T): void {
  void title;
}
