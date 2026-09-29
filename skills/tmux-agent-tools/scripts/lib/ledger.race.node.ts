// One contender for ledger.contract.node.ts: a separate OS process running one
// ledger operation against a real directory, printing its outcome as JSON.
// Usage: node ledger.race.node.ts <op> <path> <id> [root gen0Owner now]
import { acquireLock, allocateNext, claim } from './ledger.ts'
import { nodeHost } from './host.node.ts'

const [op, path, id, root, gen0, now] = process.argv.slice(2) as [string, string, string, string?, string?, string?]
const host = nodeHost({ owner: id, log: () => {} })
let out: unknown
if (op === 'lock') {
  out = await acquireLock(host, path, { token: id, session: id, activation: '1', host: 'h', pid: process.pid, pidStart: 'x' })
} else if (op === 'allocate') {
  out = await allocateNext(host, path)
} else if (op === 'claim') {
  out = await claim(host, root!, path, gen0, id, Number(now))
} else {
  throw new Error(`unknown op ${op}`)
}
process.stdout.write(`${JSON.stringify(out)}\n`)
