import type {
  CanonicalTitle,
  NormalizedTitle,
  RawTitle,
} from "../../src/api/brands";
export function wire(pageTitle: NormalizedTitle): void {
  void pageTitle;
}
export function raw(rawTitle: RawTitle): void {
  void rawTitle;
}
export function normalized(normalizedTitle: NormalizedTitle): void {
  void normalizedTitle;
}
export function canonical(canonicalTitle: CanonicalTitle): void {
  void canonicalTitle;
}
