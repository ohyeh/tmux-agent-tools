# Orchestration

## Sequence

1. Update the thin router with a Codex-native proxy branch.
2. Document the proxy contract in the hub and single-worker reference.
3. Add routing evals for CLI identity, execution mode, native, and inline paths.
4. Run JSON, packaging, metadata, targeted smoke, and full smoke checks.
5. Inspect the final diff and record any unverified Codex App behavior.

## Branching rules

- Native sub-agent available and external CLI worker authorized: spawn one
  supervision-only proxy.
- Native sub-agent unavailable: run the existing wrapper directly and label the
  adaptation `UNAVAILABLE-NATIVE`.
- External worker is headless: summarize material changes and heartbeat within
  60 seconds.
- External worker is headed: prefer passive status/probe/capture; ping only when
  stale.
- Inline or native-only task: do not create an external worker.

## Integration policy

The proxy never becomes a second implementation author. It launches and
supervises exactly one external worker, validates its `result.json`, and reports
the outcome through its native child thread.
