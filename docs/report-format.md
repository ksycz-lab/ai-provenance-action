# Report format

On every pull request run, the Action writes one JSON document, `ai-provenance-report.json` by default, and uploads it as a workflow artifact (Phase 5). This page is the field reference for version 1. The machine-readable contract is [`schema/report.v1.schema.json`](../schema/report.v1.schema.json). The job summary and PR comment are rendered from this report only (P4-M2).

The report is **evidence that supports an audit**, for example under ISO/IEC 42001 or the logging controls of ISO/IEC 27001. It records what contributors declared and which checks ran. It does not certify compliance and does not detect AI-written code.

A full example is the reviewed snapshot [`test/__snapshots__/P4-M1.full-report.json`](../test/__snapshots__/P4-M1.full-report.json).

## Versioning

`schemaVersion` follows semver:

- **Minor** (`1.1.0`): new optional fields only. Readers of `1.0.0` keep working if they ignore fields they do not know.
- **Major** (`2.0.0`): a field is removed, renamed, or changes meaning or type. A new schema file (`report.v2.schema.json`) is added next to the old one.

The same input always produces byte-identical JSON: keys are written in a fixed order, files are sorted by path, and the clock is passed in rather than read inside the builder.

## Root

| Field           | Meaning                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | Report format version, `1.0.0` for this schema.                                                           |
| `action`        | Which build of the Action produced the report.                                                            |
| `generatedAt`   | When the report was built, ISO 8601 in UTC (`2026-11-08T10:00:00.000Z`).                                  |
| `run`           | The workflow run that produced it.                                                                        |
| `pullRequest`   | The pull request that was analysed.                                                                       |
| `config`        | Which policy was applied.                                                                                 |
| `commits`       | Every PR commit that was read, AI-tagged or not, oldest first.                                            |
| `aiChanges`     | Files touched by AI-tagged commits, sorted by path.                                                       |
| `gates`         | One entry per configured policy gate, in config order. Empty when no gates are configured or run.         |
| `verdict`       | Overall result: `pass`, `warn` or `fail`.                                                                 |
| `verdictReason` | Optional. Why the verdict was decided without running gates: `no-ai-changes`, `truncated`, `report-only`. |
| `limitations`   | What this report cannot tell you. Always contains at least `declarations-only`.                           |

## `action`

| Field       | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| `name`      | Always `ai-provenance-action`.                            |
| `version`   | The Action's release version, for example `1.0.0`.        |
| `commitSha` | The Action's own commit SHA when known, otherwise `null`. |

## `run`

| Field        | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `repository` | `owner/repo` the workflow ran in.                                          |
| `workflow`   | Workflow name.                                                             |
| `runId`      | Workflow run ID. Together with `repository` it links back to the run.      |
| `runAttempt` | Re-run number, starting at 1. Re-runs produce separate reports.            |
| `event`      | The triggering event, for example `pull_request` or `pull_request_review`. |

## `pullRequest`

| Field     | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `number`  | PR number.                                                    |
| `url`     | PR URL on GitHub.                                             |
| `baseSha` | Base commit the PR was compared against and config read from. |
| `headSha` | Head commit that was analysed.                                |
| `author`  | PR author's login, or `null` for a deleted account.           |

## `config`

| Field    | Meaning                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------- |
| `source` | `base-branch` when the config file was read from the base SHA, `defaults` when it was absent.     |
| `path`   | Config path that was looked up, for example `.github/ai-provenance.yml`.                          |
| `sha256` | SHA-256 of the config file bytes, so an auditor can match the exact policy. `null` with defaults. |

## `commits[]`

To keep the artifact small and avoid leaking long message bodies, a commit carries only these fields. The full message is never included.

| Field      | Meaning                                                                               |
| ---------- | ------------------------------------------------------------------------------------- |
| `sha`      | Commit SHA.                                                                           |
| `author`   | GitHub login when known, otherwise the Git author name; `null` when neither is known. |
| `subject`  | First line of the message, at most 200 characters (longer subjects end with `…`).     |
| `aiTagged` | `true` when at least one detection rule matched.                                      |
| `reasons`  | Every rule that matched. Empty when `aiTagged` is `false`.                            |

Each entry in `reasons`:

| Field     | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `rule`    | The configured rule, `trailer:<key>` or `label:<name>`, for example `trailer:Co-authored-by`. |
| `matched` | What it matched: the full trailer line, or the PR label as written on the PR.                 |

## `aiChanges[]`

| Field              | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `path`             | File path at the PR's head.                                                                      |
| `status`           | GitHub file status: `added`, `modified`, `removed`, `renamed`, `copied`, `changed`, `unchanged`. |
| `previousFilename` | Only for renames: the old path.                                                                  |
| `lines`            | Added line ranges, or `"unknown"` when no diff was available (binary file, diff too large).      |

Each range is `{ "start": 10, "end": 24 }`, inclusive, numbered on the new side of the diff. `start` and `end` describe the lines **as added by the AI-tagged commit at that commit**; later commits may move them (see `lines-as-of-commit` below). Ranges from several AI-tagged commits on the same file are merged.

## `gates[]`

| Field     | Meaning                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`      | Gate `id` from the config.                                                                                                    |
| `type`    | Gate type: `mutation-score`, `required-label` or `approvals`.                                                                 |
| `mode`    | Effective mode after per-gate override: `enforce` or `warn`.                                                                  |
| `result`  | `pass`, `fail`, `skipped` or `error` (the gate threw or its type is unknown).                                                 |
| `message` | One plain sentence explaining the result.                                                                                     |
| `details` | Optional, gate-specific evidence. The mutation gate records score, threshold, mutant counts by status and the files in scope. |

## `limitations[]`

| Field     | Meaning                                                      |
| --------- | ------------------------------------------------------------ |
| `code`    | Stable identifier, listed below.                             |
| `message` | Plain-language explanation for a human reader.               |
| `files`   | Only for `unknown-lines`: the files whose lines are unknown. |

| Code                 | When it appears                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `declarations-only`  | Always. Trailers and labels are self-declared; a commit without them is not evidence of human authorship. |
| `truncated-commits`  | The PR has more commits than could be read (REST limit 250, or `limits.max-commits`).                     |
| `truncated-files`    | More changed files than could be read (REST limit 3000, or `limits.max-files`).                           |
| `unknown-lines`      | At least one AI-touched file has `lines: "unknown"`.                                                      |
| `lines-as-of-commit` | At least one AI-touched file has line ranges. They describe each commit, not the final state of the PR.   |

## Job summary and PR comment

`renderMarkdown(report, { variant })` turns the report into Markdown for the job summary (`summary`) and the sticky PR comment (`comment`). It reads only the report, never raw GitHub data. Examples for each outcome are in [`test/__snapshots__/`](../test/__snapshots__/) (`P4-M2.pass.md`, `P4-M2.warn.md`, `P4-M2.fail.md`, `P4-M2.no-ai.md`).

- The first line is the verdict with an icon **and** a word (✅ Pass, ⚠️ Warn, ❌ Fail), so it does not depend on colour.
- Then a table of gates, then collapsible lists of AI-tagged commits and touched files, each capped at 50 entries ("…and N more, see the JSON report").
- A PR with no AI-tagged commits gets a single line.
- The comment starts with the hidden marker `<!-- ai-provenance-action -->`, so the Action can find and update its own comment.
- The comment stays under GitHub's limit of 65 536 characters: if very long paths push it over, the lists shrink until it fits.
- All text that comes from people (commit subjects, trailer values, file paths, logins) is escaped: HTML and Markdown characters become entities, and `@` and `#` get an invisible word joiner so nobody is mentioned and no issue is linked.
