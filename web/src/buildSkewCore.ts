// pattern: Functional Core

/** Whether a bundle built as `own` is stale against the server's `served`
 * build (its X-Pkm-Build header). A dev bundle has no stamp to compare. */
export function isStaleBuild(own: string, served: string | null): boolean {
  return own !== "dev" && served !== null && served !== own;
}
