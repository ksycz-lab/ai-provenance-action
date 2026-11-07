# Configuration

The Action reads `.github/ai-provenance.yml` from the **pull request’s base branch** (Phase 5). This page is the field reference for version 1. The machine-readable contract is [`schema/config.v1.schema.json`](../schema/config.v1.schema.json).

The output is **evidence that supports an audit**. A config file does not certify compliance and does not detect AI-written code.

## Editor autocompletion

Point your YAML language server at the schema (`$id`: `https://github.com/ksycz/ai-provenance-action/schema/config.v1.schema.json`):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ksycz/ai-provenance-action/main/schema/config.v1.schema.json
version: 1
```

## When the file is missing

`loadConfig(undefined)` uses built-in defaults (`source: defaults`):

- Trailer rules: `Co-authored-by` whose value matches `claude|copilot|cursor|codex|gemini|devin`, plus any `Assisted-by` or `Generated-by`
- Labels: `ai-assisted`
- Policy `mode`: `enforce`
- `gates`: none (report only)
- `limits.max-commits`: 250, `limits.max-files`: 3000, `limits.on-truncated`: `fail`

## Root

| Field       | Required | Meaning                                                                |
| ----------- | -------- | ---------------------------------------------------------------------- |
| `version`   | yes      | Must be `1`. Any other number fails with “unsupported config version”. |
| `detection` | no       | How commits and PRs are declared AI-assisted.                          |
| `policy`    | no       | Enforce/warn and the list of `gates`.                                  |
| `limits`    | no       | REST pagination caps and what to do if data is truncated.              |

Unknown keys fail. The error path looks like `policy.gates[0].treshold` and may suggest `threshold`.

## `detection`

| Field      | Meaning                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `trailers` | List of trailer rules. **Replaces** the default list when present (does not append). |
| `labels`   | PR labels that tag **every** commit. **Replaces** the default list when present.     |

### `detection.trailers[]`

| Field   | Meaning                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`   | Trailer key, matched case-insensitively and exactly (`Assisted-by` does not match `Not-Assisted-by`).                                                                                                        |
| `value` | Optional regex, tested only against the trailer **value**, case-insensitive. Longer than 200 characters is rejected (ReDoS guard). Invalid patterns fail with the rule index and the regex engine’s message. |

## `policy`

| Field   | Meaning                                                                          |
| ------- | -------------------------------------------------------------------------------- |
| `mode`  | `enforce` or `warn`. Default for every gate unless the gate sets its own `mode`. |
| `gates` | Checks that run when AI-tagged changes exist. Duplicate `id` values fail.        |

### `policy.gates[]`

| Field        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `id`         | Stable name in the report (must be unique).                       |
| `type`       | `mutation-score`, `required-label`, or `approvals`.               |
| `mode`       | Optional per-gate override of `policy.mode`.                      |
| `threshold`  | For `mutation-score`: percent 0–100.                              |
| `scope`      | For `mutation-score`: `ai-files` or `all`.                        |
| `on-missing` | When a mutation report file is absent: `fail`, `warn`, or `skip`. |
| `label`      | For `required-label`: the label that must be present.             |
| `min`        | For `approvals`: how many non-author approvals are required.      |

Gate evaluation is Phase 3. This milestone only stores and validates the fields.

## `limits`

| Field          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `max-commits`  | Cap on PR commits fetched (GitHub’s REST list is limited; default 250). |
| `max-files`    | Cap on files fetched per commit (default 3000).                         |
| `on-truncated` | `fail` or `warn` when those caps are hit.                               |

## Example

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ksycz/ai-provenance-action/main/schema/config.v1.schema.json
version: 1

detection:
  trailers:
    - key: Co-authored-by
      value: '\b(claude|copilot|cursor|codex|gemini|devin)\b'
    - key: Assisted-by
    - key: Generated-by
  labels: [ai-assisted]

policy:
  mode: enforce
  gates:
    - id: mutation
      type: mutation-score
      threshold: 80
      scope: ai-files
      on-missing: fail
    - id: reviewed-label
      type: required-label
      label: ai-reviewed
      mode: warn
    - id: human-approval
      type: approvals
      min: 1

limits:
  max-commits: 250
  max-files: 3000
  on-truncated: fail
```
