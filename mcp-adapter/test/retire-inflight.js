// R4-7: a heartbeat already writing when the host goes away must not re-mark the retired
// session live. Own process: retireSession is final for the adapter module.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r47-"));
process.env.TMUX_AGENT_DIR = dir;
process.env.TMUX_AGENT_SESSION = "r47-retire";
const lib = path.resolve(__dirname, "../../skills/tmux-agent-tools/scripts/lib");
const core = {};
for (const n of ["workers.ts", "ledger.ts", "host.node.ts"]) core[n] = require(path.join(lib, n));
const original = core["host.node.ts"].nodeHost;
let pause = false;
let resume;
let entered;
const atWrite = new Promise((r) => (entered = r));
const barrier = new Promise((r) => (resume = r));
core["host.node.ts"] = {
  nodeHost: (opts) => {
    const host = original(opts);
    return {
      ...host,
      write: async (p, t) => {
        if (pause && p.endsWith(".beat")) {
          entered();
          await barrier;
        }
        return host.write(p, t);
      },
    };
  },
};
globalThis.__tmuxAgentCore = core;
const A = require("../src/adapter.js");

(async () => {
  const host = await A.getHost();
  await A.ensureAdapterLive(host);
  pause = true;
  const tick = A.ensureAdapterLive(host);
  await atWrite;
  const retiring = A.retireSession();
  setTimeout(resume, 1000); // the stuck beat write finishes long after a non-waiting retire has backdated
  await retiring;
  await tick;
  const sd = core["workers.ts"].sessionDirOf(core["workers.ts"].v3Of(dir), "r47-retire");
  const state = await core["ledger.ts"].sessionLiveness(host, sd, Date.now());
  assert.equal(state, "non-live", "an in-flight beat must not revive a retired session");
  assert.equal(await A.ensureAdapterLive(host), false, "no beat starts after shutdown began");
  assert.equal(await core["ledger.ts"].sessionLiveness(host, sd, Date.now()), "non-live");
  A.stopHeartbeat();
  console.log("retire-inflight ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
