# TASK: Implement tmux-delegate subagent v1

Repo root: /Users/paul.yeh/github/tmux-agent-tools (branch main). Work directly on main.
Authoritative plan: `.workflow/tmux-delegate-subagent/plan.md`. Decisions already locked
in `.workflow/tmux-delegate-subagent/implementation-notes.md` — READ BOTH FIRST, do not
re-litigate resolved Open Questions. Use `rg`/`fd`/`jq` (never grep/find/ad-hoc parsers).
Do NOT spawn additional tmux sessions or delegate further.

Implement ALL phases below, then run the verification block. Append any new decisions you
make to implementation-notes.md.

## Phase 1 — agent-tmux runtime (file: skills/tmux-agent-tools/scripts/agent-tmux)

### 3A-1: `doctor --json`
Refactor `doctor_session()` (currently lines ~4233-4259) so it accepts an optional `--json`
arg. Default (no arg) keeps EXACT current plain-text behaviour incl. `require_tmux`.
With `--json`: do NOT call require_tmux (it hard-exits before JSON prints). Emit
`{"ok":bool,"checks":[{"name":..,"ok":bool,"detail":..}...]}` with these INDEPENDENT named checks:
- `tmux`        ok if [[ -n "$TMUX" && -x "$TMUX" ]]
- `agent_cli_binary` ok if [[ -n "$CLI_BIN" && -x "$CLI_BIN" ]]
- `git`         ok if `command -v git`
- `git_worktree` ok if `git worktree --help` works
Top-level `ok` = AND of all checks. `exit 1` when ok==false, `exit 0` otherwise.
Build JSON with printf; json-escape every `detail` (escape `\` and `"`, strip newlines) so it
works even without jq. Update dispatcher branch `doctor)` (line ~5449) to `doctor_session "$@"`.

### 3A-2: `setup` subcommand
Add `setup_session()`: run `doctor_session --json` (capture stdout + rc), then
`self_test_session` inside `$(...)` (capture combined output + rc; its internal require_tmux
exit only kills the subshell). Print combined JSON:
`{"ok":bool,"doctor":<doctor-json-raw>,"self_test":{"ok":bool,"output":"<escaped>"}}`.
Return 0 only if BOTH rc==0; else return 1. Add dispatcher branch `setup) setup_session "$@" ;;`
near `doctor)`. Add `agent-tmux setup` lines to the usage list (~line 209) and a focused help
entry (extend the `doctor|self-test)` help case to `doctor|self-test|setup)` with a setup line).

## Phase 2 — subagent + docs + evals

### 3B: create `.claude/agents/tmux-delegate.md`
Real Claude Code subagent frontmatter (NOT the openai.yaml schema):
```
---
name: tmux-delegate
description: Decide whether a coding task should be delegated to a background tmux worker (via tmux-agent-tools) or handled inline, and if delegating, construct the exact agent-tmux/claude-tmux/codex-tmux invocation. Use proactively when a task looks substantial.
tools: Bash, Read, Glob, Grep
model: sonnet
---
```
Body MUST contain:
- Delegate (substantial) when ANY: est. wall time > 30s; modifies >= 2 files; needs independent
  context window; multi-step read-plan-write cycle; runs tests/builds/lint across codebase.
- Handle inline (trivial) when: single file read/search/format; one-liner w/ immediate output;
  caller says "quick"/"inline"; marginal/unclear cases (trivial is the safe default).
- Concrete numeric thresholds stated explicitly (S7): 30s, 2 files.
- Cascade-spawning ban VERBATIM: "Workers you spawn MUST NOT spawn further workers." and instruct
  to include literally in every worker prompt: "Do not spawn additional tmux sessions or delegate
  further." Construct worker invocations from a hardcoded command skeleton; NEVER interpolate the
  raw task description string directly into the Bash command.
- A comment that `--resume` is intentionally NOT supported in v1 (CLI UUID gap; see v2 task 3A-V2).
- Every tool referenced in the body must be in the `tools:` frontmatter (S8 self-audit; list them).

### 3C: update skills/tmux-agent-tools/SKILL.md
Add an "Auto-delegation" section describing `.claude/agents/tmux-delegate.md` and when it fires,
plus a Fast-paths entry mentioning tmux-delegate. Keep `rg 'tmux-delegate' SKILL.md` matching.

### 3E: evals
- `skills/tmux-agent-tools/evals/trigger_eval.json`: add >=3 entries (same {query,should_trigger[,note]} schema):
  (1) "refactor 5 files across src/ and run the test suite" -> true
  (2) "read this file and tell me what the main exported function is called" -> false
  (3) "run a multi-step data migration across 3 modules, write a summary when done" -> true
- `skills/tmux-agent-tools/evals/evals.json`: add >=1 entry (existing {id,name,prompt,expected_output,files,assertions} schema)
  prompt about: "refactor auth/ across 4 files and run all tests — tmux-delegate or inline? show the exact call."
Keep both files valid JSON (verify with jq).

## Phase 3 — manifests + CHANGELOG (bump 0.18.1 -> 0.19.0)
- .claude-plugin/plugin.json: version
- .claude-plugin/marketplace.json: metadata.version (line ~9) AND plugins[0].version (line ~16)
- .cursor-plugin/plugin.json: version
- CHANGELOG.md: add a 0.19.0 section (date 2026-06-19) summarising: tmux-delegate subagent,
  doctor --json, setup subcommand, evals.

## VERIFICATION (run all; all must pass)
```
cd /Users/paul.yeh/github/tmux-agent-tools
S=skills/tmux-agent-tools
# S3
CLAUDE=/definitely/missing $S/scripts/agent-tmux claude doctor --json >/tmp/d.json; rc=$?
jq -e '.ok==false and any(.checks[]; .name=="agent_cli_binary" and .ok==false)' /tmp/d.json; test "$rc" -eq 1 && echo S3-OK
# doctor --json happy path
$S/scripts/agent-tmux codex doctor --json | jq -e '.ok==true' && echo DOCTOR-OK
# S4 setup
$S/scripts/agent-tmux codex setup >/tmp/s.json; echo "setup rc=$?"; jq -e '.ok' /tmp/s.json
CLAUDE=/definitely/missing $S/scripts/agent-tmux claude setup >/dev/null 2>&1; test $? -ne 0 && echo S4-MISSING-OK
# S1
fd tmux-delegate && echo S1-OK
# S2
rg -q 'tmux-delegate' $S/SKILL.md && echo S2-OK
# S5
jq -e '[.metadata.version,.plugins[0].version]|unique|length==1 and .[0]=="0.19.0"' .claude-plugin/marketplace.json
jq -e '.version=="0.19.0"' .claude-plugin/plugin.json .cursor-plugin/plugin.json
# S9
rg -c 'delegate' $S/evals/trigger_eval.json; jq -e '.evals|length>=1' $S/evals/evals.json
# JSON validity
jq . $S/evals/trigger_eval.json >/dev/null && jq . $S/evals/evals.json >/dev/null && echo JSON-OK
# bash syntax
bash -n $S/scripts/agent-tmux && echo SYNTAX-OK
```
Report PASS/FAIL per check at the end with a one-line summary. Make a single commit when green:
`git add -A && git commit` with a clear message (do NOT push).
