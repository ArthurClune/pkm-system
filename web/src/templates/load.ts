// pattern: Imperative Shell
// Bundles every template file in this directory at build time, so the
// templates work offline and change with a deploy.
import { templatesFromFiles, type PageTemplates } from "./pageTemplates";

const files = import.meta.glob<string>("./*.md",
  { query: "?raw", import: "default", eager: true });

export const PAGE_TEMPLATES: PageTemplates = templatesFromFiles(files);
