# Design — Issue #125: Result schema validation (lightweight)

Status: v1 landed in PR following this doc; `run`-time enforcement and
full JSON Schema deferred.
Tracking: https://github.com/ohyeh/tmux-agent-tools/issues/125

## Problem

#97 ships `result.json` convention. Operators have no way to enforce
that the agent actually wrote the expected shape before consuming it
— a missing `status` field or a renamed key fails downstream parsing
when the agent's already gone.

## Goal (v1 — this PR)

- `--result-schema <abs.json>` flag on `start` / `resume`. Path is
  persisted to `$TMUX_AGENT_DIR/<name>/result-schema-path`.
- `result --validate <name>` reads the schema + result file, emits a
  validation report.
- Lightweight validator written in shell + jq. Covers:
  - top-level `type` (object / array / string / integer / number /
    boolean / null)
  - top-level `required` keys (presence check)
  - top-level `additionalProperties: false` (extra-key rejection)

## Non-goals (v2+)

- Full JSON Schema draft-07 semantics (`$ref`, `oneOf`, nested
  `properties.X.required`, pattern, format, etc.) — requires an
  external validator (`ajv-cli`, python `jsonschema`).
- Sentinel-time enforcement (auto-fail the agent at exit). The v1
  validator runs on demand via `result --validate`.
- CI mode integration (#120) — when CI mode lands, it will set
  `--validate` implicitly.

## Output

```jsonc
{
  "schema_version": 1,
  "present": true,
  "valid": false,
  "errors": [
    {"path": ".", "message": "missing required key: status"},
    {"path": "extra_field", "message": "additional property not allowed"}
  ],
  "body": { /* parsed result.json content */ }
}
```

Errors:
- `path` is JSON-pointer-ish — `.` for root, `<key>` for first-level
  fields, `<key>.<subkey>` only when v2 deepens the validator.
- `message` is human-readable, not machine-keyed (v2 may add `code`).

## Behavior matrix

| state | exit | `.present` | `.valid` |
|---|---|---|---|
| schema not configured | 0 | true (file read) | true (skipped validation) |
| result file missing | 0 | false | false (no body to check) |
| result file not JSON | 0 | true | false (errors include parse_error) |
| result valid against schema | 0 | true | true |
| result fails schema | 2 | true | false |

`exit 2` on schema-fail (not 1) so CI can distinguish "missing
result file" from "result file violates contract".

## Example schema (ships in `schemas/`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema_version", "status", "summary"],
  "additionalProperties": false,
  "properties": {
    "schema_version": {"type": "integer"},
    "status": {"type": "string"},
    "summary": {"type": "string"},
    "artifacts": {"type": "array"},
    "errors": {"type": "array"}
  }
}
```

## Test plan

`scripts/test-result-schema-smoke` covers:
- valid result → `valid: true`
- missing required key → `valid: false` with the key named in errors
- extra key with `additionalProperties: false` → `valid: false`
- non-JSON result → `valid: false` with parse_error
- missing result file → `present: false, valid: false`
- relative `--result-schema` path → exit 2 at start time
- non-existent schema file → exit 1 at start time

## Rollout

1. Land this design.
2. Implement `--result-schema` flag, persistence, and the lightweight
   validator (this PR).
3. Future: ajv-cli integration as a docs-only update (no Schema spec
   change needed — caller provides a full schema, our v1 only
   exercises the subset).
4. Future: `start --result-schema ... --enforce` to auto-fail the
   sentinel when validation fails.
