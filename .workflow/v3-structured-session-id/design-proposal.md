# v3 structured `cli_session_id` capture - revised design proposal

## Brain rulings applied

- OQ1 accepted: Phase-S source wording is now "CLI-owned local transcript, strictly correlated by filename UUID plus first-record field equality." The safety bar is unchanged; only source ownership widened.
- OQ2 accepted: Claude is B-only. There is no Claude transcript extractor and no Claude pane fallback in this design.
- OQ3 accepted: Codex null-on-ambiguity is allowed, but never silent. Every structured-capture bail emits one observable status/log signal.
- OQ4 accepted: replace mixed `session_id_source=claude_transcript|codex_transcript|supplied_flag` with `session_id_capture=off|supplied|transcript`. Per-CLI transcript rules live in a small internal table, not user-facing enum values.
- Round-1 writer race fixed: structured capture and pane capture are mutually exclusive. One session has one session-id writer.

## Recommendation

Revive v3 with two proven mechanisms only (`supplied` and `transcript`) across three proven CLIs:

| CLI | Mechanism | Capture mode | Status |
| --- | --- | --- | --- |
| `claude` | Wrapper supplies UUID at creation with `--session-id <uuid>` | `session_id_capture=supplied` | Proven by local `claude --help`; no background capture. |
| `codex` | Wrapper correlates Codex-owned transcript after start | `session_id_capture=transcript` | Proven source shape; remains default-off until version/race gates pass. |
| `agy` | Wrapper correlates agy-owned local store after start | `session_id_capture=transcript` | Source found in round 3; remains default-off until live resume/version/race gates pass. |
| `cursor` | None yet | `off` | Binary unavailable; no source proof. |
| `grok` | None yet | `off` | Binary unavailable; no source proof. |

Bundled profiles stay default-off until the later L gate. The design is intentionally asymmetric: Claude has a race-free creation-time ID path; Codex and agy do not expose a creation-time ID flag and must be correlated from CLI-owned local stores.

## Evidence baseline

- Built-in resume keywords already exist: `claude` uses `--resume`; `codex`, `agy`, `cursor`, and `grok` use `resume` (`skills/tmux-agent-tools/scripts/agent-tmux:25-29`).
- Profile parsing already accepts `resume_keyword` and `session_id_pattern` (`skills/tmux-agent-tools/scripts/agent-tmux:110-117`).
- `session-meta.json` is seeded with `cli_session_id: null` (`skills/tmux-agent-tools/scripts/agent-tmux:1753-1767`).
- Existing pane capture is background best-effort, opt-in only when `SESSION_ID_PATTERN` is set, and label-anchored before UUID extraction (`skills/tmux-agent-tools/scripts/agent-tmux:1712-1751`).
- `start_session` currently calls pane capture immediately after tmux session creation (`skills/tmux-agent-tools/scripts/agent-tmux:2851-2859`).
- `result --field .cli_session_id` is a special sidecar read path, independent of `result.json` (`skills/tmux-agent-tools/scripts/agent-tmux:3830-3845`).
- Resume display already redacts by default and shows the full value only behind `AGENT_TMUX_SHOW_SESSION_ID=1` (`skills/tmux-agent-tools/scripts/agent-tmux:3152-3164`).

The old Phase-S STOP was correct under the old "wrapper-owned transcript" wording (`.workflow/v3-structured-session-id/goal-doc.md:56-62`, `.workflow/v3-structured-session-id/goal-doc.md:91-99`). Round 2 replaces that wording with CLI-owned local transcripts, but only when strictly correlated.

## Approach B: supplied ID at creation

| CLI | B feasible? | Evidence | Decision |
| --- | --- | --- | --- |
| `claude` | Yes | `claude --help` exposes `--session-id <uuid>`: "Use a specific session ID for the conversation (must be a valid UUID)", and exposes `-r, --resume [value]`. | Primary and only Claude capture path. |
| `codex` | No evidence; treat as no | `codex --help` starts with optional `[PROMPT]` but no `--session-id`; `codex resume --help` accepts `[SESSION_ID]`; `codex exec --help` has a `resume` subcommand but no creation-time ID flag. | No supplied-ID path. |
| `agy` | No supplied-ID path | `agy --help` shows `--conversation Resume a previous conversation by ID`, `--continue`, and print/prompt modes, but no creation-time ID flag. | Unsupported for supplied-ID; transcript/store correlation is handled by Approach A. |
| `cursor` | Unknown | Binary not found locally. | Unsupported. |
| `grok` | Unknown | Binary not found locally. | Unsupported. |

### Claude B-only design

For `session_id_capture=supplied`:

1. Generate an RFC-4122 UUID before launch.
2. Write `session-meta.json` synchronously right after `result_init_session` and before tmux launch.
3. Append `--session-id <uuid>` to the Claude launch command.
4. Spawn no structured background capturer.
5. Spawn no pane `session_id_pattern` capturer for Claude.

This works for both interactive and oneshot because the ID is known before either branch starts the CLI. There is no poll window and no file correlation. I do not have a real counterexample where Claude accepts `--session-id` but resumes under a different ID; absent that, a transcript fallback would be dead code and a new race surface.

## Approach A: transcript correlation

Transcript mode is currently proven for Codex and agy.

### Codex source rule

Source:

- Directory: `~/.codex/sessions/YYYY/MM/DD/`.
- File: `rollout-<timestamp>-<uuid>.jsonl`.
- Accept only when filename suffix is an RFC-4122 UUID and the first JSONL object is `type == "session_meta"` with `.payload.id` equal to that filename UUID.
- Require `.payload.cwd == launch cwd` when present.

Local evidence:

- A sample `rollout-2026-06-14T01-49-19-019ec21a-39d4-7941-b3ae-21446f2f60f4.jsonl` embedded UUID `019ec21a-39d4-7941-b3ae-21446f2f60f4`; its first JSONL object had `type:"session_meta"`, `payload.id:"019ec21a-39d4-7941-b3ae-21446f2f60f4"`, and a cwd.
- `~/.codex/session_index.jsonl` and `~/.codex/history.jsonl` exist, but they are not primary sources. The transcript itself has the ID and cwd-bearing first record; index/history can lag or aggregate.

### Codex race and bail behavior

Race:

- Two Codex starts on the same day can create two new files in the same date directory.
- Cwd filtering reduces ambiguity, but two starts in the same cwd can still collide.

Mitigation:

1. Before launch, snapshot target date directories. Include today's directory and adjacent local/UTC date directories to cover midnight edges.
2. After launch, poll a bounded window, e.g. 30s, for files not in the snapshot matching `rollout-*-<uuid>.jsonl`.
3. Candidate must pass filename UUID, first-record `session_meta`, `.payload.id == filename UUID`, and cwd equality when present.
4. If exactly one candidate remains, write sidecar.
5. If zero candidates, validation failure, multiple candidates, or tied newest `mtime`, leave `cli_session_id:null` and emit an observable structured signal.

Observable signal shape should be small and non-secret:

```json
{"event":"session_id_capture","source":"codex_transcript","status":"ambiguous","reason":"multiple_candidates","candidate_count":2}
```

Do not print candidate UUIDs in normal logs. If surfaced through status later, expose only `status`, `source`, `reason`, and `candidate_count`.

### Codex hardening investigation

I checked recent local Codex `session_meta.payload` keys across 80 transcript files. Observed key sets were combinations of:

- `id`
- `timestamp`
- `cwd`
- `originator`
- `cli_version`
- `source`
- `model_provider`
- `base_instructions`
- sometimes `git`
- sometimes `forked_from_id`
- sometimes `agent_nickname` / `agent_role`

No general prompt text, argv, environment variable, wrapper marker, label, or session name field appeared in the first `session_meta.payload`. `agent_nickname` exists in some older records but is not consistently present and is not a general wrapper-controlled correlation token.

Conclusion: with current evidence, same-cwd Codex concurrency cannot be deterministically disambiguated beyond snapshot + cwd + first-record ID equality + mtime. Null-on-ambiguity with an observable signal is genuinely the floor unless a future Codex version echoes a wrapper-controlled token into `session_meta`.

## Capture config shape

Add one profile key:

```ini
session_id_capture=off|supplied|transcript
```

Rules:

- Default is `off`.
- `supplied` is valid only for `claude` until another CLI proves a creation-time UUID flag.
- `transcript` is valid only for `codex` and `agy` until another CLI proves a transcript/source rule.
- Per-CLI transcript mechanics are internal, keyed by CLI/profile identity, not exposed as enum values.
- Do not infer transcript support from `heuristic_family=codex`; `cursor` and `grok` currently lack source proof even though bundled presets share Codex-like resume defaults (`skills/tmux-agent-tools/scripts/agent-tmux:26-29`). `agy` is supported only by its explicit store-correlation rule.

This keeps the user-facing surface small and avoids building config for unproven CLIs.

## Writer model and precedence

Rejected Round-1 rule: "write only when sidecar null + tmp->mv" is not sufficient with two background writers. It is a TOCTOU race: structured capture and pane capture can both observe null and both `mv`.

Revised rule: mutual exclusion, no locks.

Precedence:

1. If `session_id_capture=supplied`, write synchronously before launch. Spawn no session-id capturer.
2. If `session_id_capture=transcript`, spawn the structured transcript capturer only. Do not spawn pane capture, even if `session_id_pattern` is set.
3. If `session_id_capture=off` and `session_id_pattern` is set, run existing pane capture.
4. Otherwise leave null.

That gives one writer per session. Pane capture remains an opt-in legacy fallback only when structured capture is off.

## Security posture

`cli_session_id` is a resume capability. Keep the full value out of normal output.

Required rules:

- Store the full ID only in `session-meta.json`, preserving current sidecar schema (`skills/tmux-agent-tools/scripts/agent-tmux:1763-1766`).
- Do not add the ID to `result.json`; current result field path explicitly says `.cli_session_id` lives only in the sidecar (`skills/tmux-agent-tools/scripts/agent-tmux:3830-3834`).
- Do not log or print full IDs during start/capture. Existing resume display redacts by default (`skills/tmux-agent-tools/scripts/agent-tmux:3152-3164`).
- The only normal full-ID read path remains explicit: `agent-tmux result --field .cli_session_id <name>` (`skills/tmux-agent-tools/scripts/agent-tmux:3834-3844`).
- Capture bail signals must not contain candidate UUIDs.

## Integration with #268 one-shot

#268 and v3 should share one profile-key round, then land separate start-session behavior.

Unified profile-key round:

- Add #268 keys:
  - `exec_mode=interactive|oneshot`
  - `prompt_via=paste|argv`
  - `prompt_flag=<string>`
- Add v3 key:
  - `session_id_capture=off|supplied|transcript`

These keys do not collide. The parser/defaults/docs can ship together while behavior stays independently testable.

Then split `start_session` implementation into two independent concerns:

1. Session ID capture concern:
   - Pre-launch supplied-ID setup for Claude.
   - Post-launch Codex/agy transcript capturer for transcript mode.
   - Pane fallback only when capture is off.
2. Execution mode concern:
   - Existing interactive tmux launch remains the default.
   - New oneshot branch synthesizes `result.json` and marker per #268.

The two concerns share setup data but do not couple outputs:

- `result.json` synthesis belongs to #268 oneshot.
- `session-meta.json` belongs to v3 capture.
- Oneshot with `session_id_capture=off` still works and leaves `cli_session_id:null`.
- Claude supplied-ID works in both interactive and oneshot because the sidecar write happens before either launch path.
- Codex/agy transcript mode in oneshot is allowed only if the corresponding oneshot persistence is proven by fixtures/live sample; otherwise leave null with a bail signal.

## Phased breakdown with hard gates

### P1 - Unified profile-key surface

Goal: add profile keys without changing runtime behavior.

Hard gates:

- Parser accepts and validates #268 keys and `session_id_capture`.
- Defaults preserve current behavior: interactive, paste, capture off.
- Unknown values fail or warn according to existing profile-parser conventions.
- Docs describe that `session_id_capture` is mechanism-only, not a per-CLI source enum.

### P2 - Claude supplied-ID path

Goal: implement the race-free path.

Hard gates:

- `session_id_capture=supplied` generates UUID, writes sidecar before launch, and adds `--session-id`.
- No background session-id capture is spawned.
- No pane session-id capture is spawned.
- Tests prove interactive and oneshot command assembly include the supplied ID and sidecar contains the same ID.
- Security test proves normal output does not print the full ID.

### P3 - Codex/agy transcript paths

Goal: implement strict transcript/store correlation.

Hard gates:

- Fixture tests cover success, basename/payload mismatch, malformed first record, cwd mismatch, no candidates, multiple candidates, mtime tie, and decoy UUID.
- Bail cases leave null and emit one observable non-secret signal.
- Pane capture is not spawned when `session_id_capture=transcript`.
- `scripts/test-session-meta-smoke`, `scripts/ci-shellcheck`, `zsh -n skills/tmux-agent-tools/scripts/agent-tmux`, and help smoke pass.

### P4 - #268 oneshot behavior

Goal: land the execution branch without coupling it to session-id capture.

Hard gates:

- Oneshot fake fixture synthesizes `result.json` before marker.
- Interactive profiles behave identically when `exec_mode=interactive`.
- Oneshot with capture off leaves sidecar null.
- Claude supplied-ID oneshot works.
- Codex/agy transcript oneshot stays off/null unless persistence is proven.

### L - Default enablement gate

Goal: decide per CLI default posture.

Hard gates:

- At least two version samples for the same CLI confirm stable source shape.
- Source is local, CLI-owned, deterministic, and explicitly field/filename correlated.
- Ambiguity behavior is tested and observable.
- Full UUID is not printed except explicit `result --field .cli_session_id`.

Recommended default posture now:

| CLI | Capture default now | Why |
| --- | --- | --- |
| `claude` | Default-off until L, then strongest candidate for default-on | B exists and is race-free. No A fallback. |
| `codex` | Default-off | A source observed; no B flag; same-cwd ambiguity still bails. |
| `agy` | Default-off | Agy-owned store source observed; no creation ID flag; live resume/version/race gates still pending. |
| `cursor` | Default-off | Binary unavailable; no source proof. |
| `grok` | Default-off | Binary unavailable; no source proof. |

## Remaining disagreement

None. The only hard limit is Codex same-cwd concurrency: I looked for a wrapper-controlled token in `session_meta.payload` and did not find a reliable one, so observable null-on-ambiguity is the correct floor for now.

## Brain addendum (round 3): agy source FOUND — supersedes "agy: none proven"

Round 1/2 marked agy `off`/unsupported because only `agy --help` was inspected, not agy's on-disk store. A
follow-up inspection found a real, CLI-owned, cwd-correlated source — so agy moves from `off` to
`transcript`-capable (the same tier as codex, with an arguably cleaner correlation primitive). This
supersedes the agy rows in the recommendation / Approach-B / default-posture tables above.

Evidence:
- `~/.gemini/antigravity-cli/conversations/<uuid>.db` — one SQLite db per conversation, filename is an
  RFC-4122 UUID (e.g. `36198875-f777-4ff0-bc0e-ec99b3cd64e2.db`).
- `~/.gemini/antigravity-cli/cache/last_conversations.json` — an explicit `cwd → conversation UUID` map.
  Verified: `"/Users/paul.yeh/github/tmux-agent-tools": "36198875-f777-4ff0-bc0e-ec99b3cd64e2"`, and that
  UUID is also a real `conversations/<uuid>.db` file.
- Resume: `agy --conversation <uuid>` ("Resume a previous conversation by ID", from `--help`).

Correlation rule (cleaner than codex — explicit map, not newest-file heuristic), with cache-staleness guard:
1. After launch, read `last_conversations.json[<launch cwd>]` → candidate UUID.
2. Cross-check `conversations/<uuid>.db` exists AND its mtime is at/after the launch timestamp.
3. Both agree → write sidecar. Otherwise null + observable bail signal.

Caveats / gates (why still default-off):
- `last_conversations.json` lives in `cache/` — may be cleared or stale; the `.db` mtime cross-check is the
  durability guard. If they disagree, bail to null rather than trust the cache alone.
- Same-cwd concurrency is last-write-wins in the map → same null-on-ambiguity floor as codex.
- `--conversation` end-to-end resume is not yet live-verified through the wrapper; that is the L-gate live
  sample, same standard applied to codex.

Revised per-CLI posture: claude=`supplied` (race-free), **codex AND agy=`transcript`** (store correlation,
default-off until live resume + ≥2 version samples), cursor/grok=`off` (binary unavailable, unproven).
