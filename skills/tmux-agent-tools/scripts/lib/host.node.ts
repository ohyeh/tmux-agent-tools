// `Host` for plain node (collector, TUI, MCP, CLI verbs). The engine-only capabilities
// answer observably: no submit, no in-process agents (p0-contract.md §9).
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { wrapperCall, type Host } from './workers.ts'

export type NodeHostOptions = {
  owner?: string
  cwd?: string
  /** File-backed store (UI preferences only, §1: the ledger never lives in a store). */
  storePath?: string
  submit?: Host['submit']
  log?: (text: string) => void
}

export function nodeHost(opts: NodeHostOptions = {}): Host {
  const log = opts.log ?? ((text: string) => process.stderr.write(`${text}\n`))
  const readStore = async (): Promise<Record<string, unknown>> => {
    if (!opts.storePath) return {}
    try {
      return JSON.parse(await readFile(opts.storePath, 'utf8')) as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  const writeStore = async (data: Record<string, unknown>) => {
    if (!opts.storePath) throw new Error('tmux-agent: this host has no store')
    const tmp = `${opts.storePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(data))
    await rename(tmp, opts.storePath)
  }
  const host: Host = {
    now: async () => Date.now(),
    owner: () => opts.owner,
    cwd: () => opts.cwd,
    envTmuxAgentDir: async () => process.env.TMUX_AGENT_DIR,
    envXdgStateHome: async () => process.env.XDG_STATE_HOME,
    envHome: async () => process.env.HOME,
    envPath: async () => process.env.PATH,
    read: path => readFile(path, 'utf8'),
    write: async (path, text) => {
      await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      await writeFile(path, text)
    },
    stat: async path => {
      const st = await stat(path)
      return { mtimeMs: st.mtimeMs, size: st.size }
    },
    exists: async path =>
      stat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        },
      ),
    list: async path => (await readdir(path, { withFileTypes: true })).map(d => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' })),
    storeGet: async key => (await readStore())[key],
    storeSet: async (key, value) => writeStore({ ...(await readStore()), [key]: value }),
    storeKeys: async () => Object.keys(await readStore()),
    storeDelete: async key => {
      const data = await readStore()
      delete data[key]
      await writeStore(data)
    },
    submit: opts.submit ?? (async () => ({ drop: 'this host cannot submit a prompt' })),
    toast: text => log(text),
    log,
    // The same wrapper seam as the mod (workers.ts wrapperCall): binary + TMUX_AGENT_DIR.
    run: async (argv, cwd, timeoutMs) => {
      const call = await wrapperCall(host, argv)
      const env = call.env ? { ...process.env, ...call.env } : undefined
      return new Promise(resolve => {
        execFile(call.argv[0]!, call.argv.slice(1), { cwd, timeout: timeoutMs, encoding: 'utf8', ...(env ? { env } : {}) }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
          resolve({ exitCode: code, stdout, stderr: stderr || (error && typeof error.code !== 'number' ? String(error) : '') })
        })
      })
    },
    agentList: async () => [],
  }
  return host
}
