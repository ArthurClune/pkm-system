// pattern: Imperative Shell
// Stamps one id per build into the bundle (`__PKM_BUILD__`) and into
// dist/build-id.json, which the server reads and echoes as X-Pkm-Build.
// The app compares the two to notice it is running a stale cached bundle
// (docs/architecture/frontend.md § Build notes).
import type { Plugin } from "vite";

export const BUILD_ID_FILE = "build-id.json";

export function buildStampDefine(
  command: "build" | "serve", id: string,
): Record<string, string> {
  return { __PKM_BUILD__: JSON.stringify(command === "build" ? id : "dev") };
}

export function buildStampFile(id: string) {
  return {
    type: "asset" as const,
    fileName: BUILD_ID_FILE,
    source: JSON.stringify({ build: id }),
  };
}

export function buildStampPlugin(
  makeId: () => string = () => crypto.randomUUID(),
): Plugin {
  const id = makeId();
  let command: "build" | "serve" = "serve";
  return {
    name: "pkm-build-stamp",
    config(_config, env) {
      command = env.command;
      return { define: buildStampDefine(env.command, id) };
    },
    generateBundle() {
      if (command === "build") this.emitFile(buildStampFile(id));
    },
  };
}
