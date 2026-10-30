import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Host } from './workers.ts'
import { createRequire } from 'node:module'
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'

const ref = process.env.MODEL_TEST_REF
const coreUrl = new URL('./workers.ts', import.meta.url)
const source = (rel: string) => ref
  ? execFileSync('git', ['show', `${ref}:${rel}`], { encoding: 'utf8' })
  : readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8')
const coreSource = ref && stripTypeScriptTypes(source('skills/tmux-agent-tools/scripts/lib/workers.ts'))
  .replaceAll("from './", `from '${new URL('./', coreUrl).href}`)
const { missingSections, assignWorker } = await import(coreSource
  ? `data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}` : coreUrl.href)

const require = createRequire(import.meta.url)
const { spawnTmuxAgent, stopHeartbeat } = require('../../../../mcp-adapter/src/adapter.js')
const base = 'GOAL: probe\nACCEPTANCE: evidence\nREPORT: summary'
const adapterSource = source('mcp-adapter/src/adapter.js')
const formatBrief = runInNewContext(`${adapterSource.slice(adapterSource.indexOf('function formatBrief('), adapterSource.indexOf('function classifyBlocked('))}; formatBrief`, {
  missingSections, NO_CASCADE_GUARD: '', NO_BACKGROUND_JOBS_GUARD: '', NO_EXTERNAL_SIDE_EFFECTS_GUARD: '',
})

for (const [name, brief] of [
  ['missing', base], ['bare', `${base}\nMODEL:`],
  ['next section', 'GOAL: probe\nMODEL:\nACCEPTANCE: evidence\nREPORT: summary'],
  ['bold bare', `${base}\n**MODEL:**  `],
]) test(`MODEL contract: ${name} stops dispatch before host access`, async () => {
  const host = new Proxy({}, { get() { throw new Error('invalid brief reached host') } }) as Host
    assert.deepEqual(missingSections(brief), ['MODEL'])
    const result = await assignWorker(host, { profile: 'codex', name: 'probe', dir: '/work', brief })
    assert.ok('deny' in result && result.deny.includes('MODEL'))
})

test('MODEL contract: reason, path and inline diagram are accepted', () => {
  for (const model of ['none — read-only search', '/work/.workflow/run/system-model.json', '```mermaid\nflowchart LR\n A --> B\n```\nT1: A to B; INV-1: one result']) {
    assert.deepEqual(missingSections(`${base}\nMODEL: ${model}`), [])
    assert.deepEqual(missingSections(`## MODEL\n${model}\n${base}`), [])
  }
})

test('MODEL contract: MCP adapter refuses missing and bare MODEL, without inventing a reason', async () => {
  try {
    for (const task of [base, `${base}\nMODEL:`, 'GOAL: x\nMODEL:\nREPORT: summary\nACCEPTANCE: evidence']) {
      // Test the adapter formatter first. Old code fails here without a launch.
      assert.throws(() => formatBrief(task), /missing MODEL/)
      await assert.rejects(spawnTmuxAgent({ cli: 'fake', repoPath: process.cwd(), task }), /MODEL/)
    }
  } finally { await stopHeartbeat() }
})

test('MODEL contract: MCP adapter keeps an explicit reason', () => {
  assert.match(formatBrief('read the code\nMODEL: none — read-only search'), /MODEL: none — read-only search/)
})

test('MODEL contract: CLI brief producer requires a model and preserves it', () => {
  const bin = new URL('../agent-tmux', import.meta.url).pathname
  const args = [bin, 'codex', 'brief', '--template', 'implement', '--goal', 'x', '--acceptance', 'y', '--dry-run']
  assert.equal(spawnSync('zsh', args, { encoding: 'utf8' }).status, 2)
  const result = spawnSync('zsh', [...args, '--model', 'none — read-only search'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /MODEL: none — read-only search/)
})
