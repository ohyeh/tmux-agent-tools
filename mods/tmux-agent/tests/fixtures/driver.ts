import type { Plugin } from 'claude-code/testing'

/**
 * A test's `$` is the engine's event surface, not a plugin's noun, so the way to
 * exercise `$.tmux` is the way any dependent plugin would: from a plugin loaded
 * beside the one under test. That also checks the noun contract from the outside.
 */
export const driver: Plugin = {
  name: 'tmux-driver',
  register: on => {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'outstanding', description: 'list outstanding workers' })
      await $.command.register({ name: 'stalled', description: 'list stalled workers' })
      return next(e)
    })

    // Reconcile at the end of a turn, never from inside a command: the engine
    // refuses a prompt.submit raised in a command hook, because it would wait on
    // the very turn that hook holds. In production the tick does this. A test CAN
    // drive the timer (`mock.clock` advances `$.clock.every`, and the panel and
    // mode-gate tests rely on exactly that); this hook exists so a delivery test
    // can raise reconcile at a point it chooses, without a 10s clock in between.
    on('turn.complete', async ($, e, next) => {
      await $.tmux.reconcile()
      return next(e)
    })

    on('command.run', { command: 'outstanding' }, async $ => ({
      text: (await $.tmux.outstanding()).map(d => d.name).join(','),
    }))

    on('command.run', { command: 'stalled' }, async $ => ({
      text: (await $.tmux.stalled()).map(s => `${s.dispatch.name}:${s.idleSeconds}`).join(','),
    }))
  },
}

/** The engine's own `$.command.run` takes the whole input, not a plugin's short form. */
export const run = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
})

/** One finished turn, the event the driver reconciles on. */
export const turn = () => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
})
