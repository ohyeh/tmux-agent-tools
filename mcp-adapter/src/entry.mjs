// Bundle entry (build.mjs → skills/tmux-agent-tools/scripts/lib/mcp-server.mjs).
// The core is not bundled: it is the .ts files beside the bundle, loaded with
// Node's type stripping (the same files `node tui.node.ts` runs). Only that dir
// is searched; realpath keeps it right when the bundle is reached by a symlink.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));
const core = {};
for (const name of ["workers.ts", "ledger.ts", "host.node.ts"]) {
  core[name] = await import(new URL(`./${name}`, here).href);
}
globalThis.__tmuxAgentCore = core;

const { main } = await import("./server.js");
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
