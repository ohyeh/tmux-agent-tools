// One contender for scripts/test-tui-claim-race-smoke. Two processes is the
// concurrent claim. This file is not a *.contract.node.ts, so the 90s core
// contract lane does not run it.
// Usage: node tui-claim.race.node.ts <root> <session> <launchDir>
import { existsSync, writeFileSync } from 'node:fs'
import { claimTui, processId } from './workers.ts'
import { nodeHost } from './host.node.ts'

const [root, session, launchDir] = process.argv.slice(2)
if (!root || !session || !launchDir) throw new Error('usage: node tui-claim.race.node.ts <root> <session> <launchDir>')
const host = nodeHost({ log: () => {} })
const me = await processId(host)
const out = await claimTui(host, root, session, me, { state: 'pending', launchDir })
writeFileSync(`${root}/result-${process.pid}.json`, JSON.stringify(out))
const done = `${root}/race-done`
for (let i = 0; i < 40 && !existsSync(done); i++) await new Promise(r => setTimeout(r, 50))
