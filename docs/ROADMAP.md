# Project Roadmap

A milestone plan and progress log for **ai-provenance-action**: a reusable GitHub Action that records which pull-request changes were AI-assisted, applies a policy to them, and produces an audit report.

**Current focus:** P0-M1 — repository scaffold and CI (in progress).

---

## How to Use This Document

### Before starting a milestone

1. Check that every dependency listed for the milestone is ✅ Completed.
2. Re-read the Goal, User scenarios and Edge cases. Update them if anything changed.
3. Write the test cases from the table as failing tests first (red), using the IDs as test names.
4. Only then write the implementation (green), then refactor.

### After completing a milestone

1. Tick the Acceptance criteria and Completion checklist.
2. Fill in Implementation notes: Summary, Architectural decisions, Deviations, Tests implemented.
3. Update the milestone status, the completion date and the Progress Summary table.
4. Update **Current focus** at the top.

### Living document rules

- [ ] Test case IDs are never reused or renumbered. A dropped case is struck through (`~~P1-M1-04~~`) with a reason.
- [ ] A new edge case found during implementation gets a new ID at the end of the table.
- [ ] Any deviation from this plan is recorded in the milestone's Implementation notes.
- [ ] Wording in docs and the README follows the "evidence, not compliance" rule (see Shared Conventions).

---

## Goal

AI-generated code should not reach production as a black box. On every pull request the Action makes three things visible:

1. **Which changes were AI-assisted**: commits declared through trailers, or the whole PR declared through a label, mapped to the files and lines they touched.
2. **Which checks ran on them**: policy gates such as a mutation-score threshold, a required label or a reviewer approval, read from reports that other jobs produced.
3. **A durable record**: a versioned JSON report uploaded as a CI artifact, plus a human-readable job summary and an optional sticky PR comment.

The output is **evidence that supports an audit** under frameworks such as ISO/IEC 42001 (AI management systems) and ISO/IEC 27001 (logging and audit trail controls). The Action does not make anyone compliant and does not detect AI-written code on its own: it records what contributors declared and what checks ran.

## Design principles

1. **Pure core, thin adapter.** Trailer parsing, rule matching, diff mapping, policy evaluation and report building are pure functions with no I/O, tested with fixtures. Only `src/adapters/` talks to GitHub or the filesystem.
2. **Declaration, not proof.** Trailers and labels are self-declared. The report says "declared as AI-assisted by rule X", never "written by AI". Absence of a trailer is not evidence of human authorship.
3. **Analyse PR commits, not the merge commit.** Squash merges and rebases rewrite or drop trailers, so the Action reads the PR's own commits through the REST API while the PR is open.
4. **The policy is owned by the base branch.** Config is read from the PR's base SHA, so a PR (including one from a fork) cannot weaken the policy that judges it.
5. **Read reports, don't run tools.** The Action never runs mutation testing or any other check. It reads report files produced by earlier jobs and fails clearly when one is missing.
6. **Fail safe, degrade gracefully.** Missing permissions (fork PRs) degrade the output channel, not the verdict: the job summary and artifact are still written even when a PR comment cannot be posted. Truncated data is flagged in the report and never silently treated as complete.
7. **Untrusted text stays untrusted.** Commit messages, trailer values, branch names and file paths are escaped before they reach Markdown, and any future LLM output is schema-validated and escaped too.
8. **Fast no-op.** A PR with no AI-tagged commits and no AI label passes in a few REST calls with a short report.

## Shared Conventions

| Topic | Decision |
|---|---|
| Repo name | `ai-provenance-action` (Marketplace display name: **AI Provenance Audit**) |
| Action type | JavaScript action, `runs.using: node24` (Node 20 was removed from runners in September 2026) |
| Language | TypeScript, `strict: true`, ESM |
| Local Node | `.nvmrc` = `24`, `engines.node >= 24` |
| GitHub API | REST only, through `@actions/github` `getOctokit().rest.*` plus `octokit.paginate`. No GraphQL calls. |
| Test runner | Vitest, fixtures under `test/fixtures/` |
| HTTP mocking (adapter tests) | `nock`, so no adapter test touches the network |
| Coverage | ≥ 95 % lines for `src/core/`, ≥ 80 % overall, enforced in CI |
| Config validation | JSON Schema (`schema/config.v1.schema.json`) validated with Ajv; errors point to the YAML path |
| Report schema | `schema/report.v1.schema.json`, `schemaVersion: "1.0.0"` (semver: additive fields bump minor, breaking changes bump major) |
| Bundler | Rollup to `dist/index.js`, committed. The CI job `check-dist` rebuilds and fails on `git diff --exit-code dist/` |
| Lint / format | ESLint (typescript-eslint) and Prettier |
| Releases | Semver tags (`v1.0.0`) plus a moving major tag (`v1`), moved by a release workflow |
| Test case IDs | `P{phase}-M{milestone}-{nn}`, e.g. `P1-M1-01`; used verbatim in test names |
| Status notation | ⏳ Planned · 🚧 In progress · ✅ Completed · ⏸️ Deferred |
| Wording rule | "Produces evidence that supports an audit". Never "makes you compliant", "certifies" or "detects AI code". |

### Tooling choices (rationale)

Recruiter-oriented one-paragraph notes for **nock**, **Rollup**, **Ajv**, and **ESLint / Prettier** (and common alternatives) live in the [README § Tooling choices](../README.md#tooling-choices). The table above stays the decision log; the README explains *why* those picks fit a testable GitHub Action.

## Config file format (proposal)

`.github/ai-provenance.yml`, read from the **base** branch:

```yaml
version: 1

detection:
  # A commit is AI-tagged when any trailer rule matches.
  # key: trailer key, case-insensitive exact match.
  # value: optional regex tested against the trailer value, case-insensitive.
  trailers:
    - key: Co-authored-by
      value: '\b(claude|copilot|cursor|codex|gemini|devin)\b'
    - key: Assisted-by
    - key: Generated-by
  # Any of these labels marks the whole PR (every commit) as AI-assisted.
  labels: [ai-assisted]

policy:
  mode: enforce            # enforce | warn  (default for all gates)
  gates:
    - id: mutation
      type: mutation-score
      threshold: 80        # percent, 0-100
      scope: ai-files      # ai-files | all
      on-missing: fail     # fail | warn | skip  when the report file is absent
      # report path comes from the action input `mutation-report`
    - id: reviewed-label
      type: required-label
      label: ai-reviewed
      mode: warn           # per-gate override
    - id: human-approval
      type: approvals
      min: 1               # approvals from users other than the PR author

limits:
  max-commits: 250         # REST hard limit for PR commits
  max-files: 3000          # REST hard limit for PR files
  on-truncated: fail       # fail | warn
```

When the file is missing, built-in defaults apply: the four trailer rules from the brief, the `ai-assisted` label, and **no gates** (report only), so adoption is a one-line `uses:` step.

### Action inputs and outputs (proposal)

| Input | Default | Purpose |
|---|---|---|
| `github-token` | `${{ github.token }}` | REST access |
| `config-path` | `.github/ai-provenance.yml` | Config location on the base branch |
| `mutation-report` | _(empty)_ | Path to a Stryker `mutation.json` produced by an earlier job |
| `report-path` | `ai-provenance-report.json` | Where to write the JSON report |
| `upload-artifact` | `true` | Upload the report with `@actions/artifact` |
| `pr-comment` | `false` | Create or update a sticky PR comment |

| Output | Example | Purpose |
|---|---|---|
| `ai_tagged` | `true` | Any AI-tagged commit or label found |
| `ai_files` | `["src/a.ts","src/b.ts"]` | JSON array of files touched by AI-tagged commits |
| `report_path` | `ai-provenance-report.json` | Path to the JSON report |
| `verdict` | `pass` / `warn` / `fail` | Overall policy result |

---

## Phase Overview

| Phase | Name | Status | Focus |
|---|---|---|---|
| 1 | Detection core | ⏳ Planned | Pure trailer parsing, rule matching and diff-to-lines mapping |
| 2 | Configuration | ⏳ Planned | YAML config schema, defaults, validation errors |
| 3 | Policy engine | ⏳ Planned | Gate evaluation, enforce/warn, Stryker mutation score, label and approval gates |
| 4 | Audit report | ⏳ Planned | Versioned JSON report and escaped Markdown rendering |
| 5 | GitHub adapter | ⏳ Planned | REST fetching with pagination and limits, outputs, summary, artifact, sticky comment, fork handling |
| 6 | End-to-end and dogfooding | ⏳ Planned | Self-test workflows running the bundled Action on real PRs |
| 7 | Release and Marketplace | ⏳ Planned | README, threat model, release automation, `v1` tag |
| 8 | Integration with playwright-test-ai-inspector | ⏳ Planned | Adopt the Action, demo PR, cross-linked READMEs |

The phases run from easiest to hardest: Phases 1-4 are pure functions with fixtures, Phase 5 introduces I/O behind mocks, and Phases 6-8 run against real GitHub.

---

# Phase 0 — Scaffold

**Status:** ⏳ Planned · **Focus:** an empty but fully wired repo, so every later milestone starts red-green straight away.

## P0-M1 — Repository scaffold and CI

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** none

### Goal

A repo where `npm test`, `npm run lint`, `npm run build` and the `check-dist` job all run green on a placeholder `main.ts`.

### Implementation scope

- `package.json`, `tsconfig.json`, ESLint, Prettier, Vitest with coverage thresholds, Rollup config
- `action.yml` with `runs.using: node24` and the inputs and outputs above (stubbed)
- Folder layout: `src/core/` (pure), `src/adapters/` (I/O), `src/main.ts` (wiring), `schema/`, `test/fixtures/`
- Workflows: `ci.yml` (lint, typecheck, test, coverage), `check-dist.yml`
- `LICENSE` (MIT), `.nvmrc`, `CONTRIBUTING.md` stub

### Test cases

| ID | Scenario |
|---|---|
| P0-M1-01 | `npm test` runs and passes with one smoke test |
| P0-M1-02 | `check-dist` fails when `src/` changes without rebuilding `dist/` (verified once on a throwaway branch) |
| P0-M1-03 | Coverage below threshold fails CI (verified once on a throwaway branch) |
| P0-M1-04 | A dependency-cruiser rule fails CI when anything in `src/core/` imports `@actions/*`, `node:fs` or `src/adapters/` |

### Acceptance criteria

- [ ] All four CI checks are green on `main`
- [ ] Core purity is enforced by tooling (P0-M1-04), not just by convention
- [ ] `action.yml` passes `actionlint` / schema validation

### Completion checklist

- [ ] Branch protection requires `ci` and `check-dist`
- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

---

# Phase 1 — Detection core

**Status:** ⏳ Planned · **Focus:** pure functions that turn commits, labels and diffs into "what was AI-assisted, and why".

## P1-M1 — Trailer parsing

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P0-M1

### Goal

`parseTrailers(message: string): Trailer[]` extracts trailers the way `git interpret-trailers` does: only from the last paragraph of the message, as `Key: value` lines.

### User scenarios

- As a developer using Claude Code, my commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and I expect it to be recognised.
- As a developer who writes "Co-authored-by: Copilot suggested this" in the body of a message, I do not expect a false positive: that line is prose, not a trailer.

### Test cases

| ID | Scenario |
|---|---|
| P1-M1-01 | A single trailer in the last paragraph is returned as `{ key, value }` |
| P1-M1-02 | Several trailers in the last paragraph are returned in order |
| P1-M1-03 | A `Key: value` line in a middle paragraph is ignored |
| P1-M1-04 | A message with no blank line (subject only) returns no trailers |
| P1-M1-05 | CRLF line endings parse the same as LF |
| P1-M1-06 | Leading and trailing whitespace around key and value is trimmed |
| P1-M1-07 | A last paragraph that mixes trailers with ordinary prose lines is not treated as a trailer block (git rule: at least 25 % trailers, or a known git-generated trailer) |
| P1-M1-08 | A continuation line (starting with whitespace) is appended to the previous trailer value |
| P1-M1-09 | Unicode in values (names with diacritics, such as `Kateřina Sýkorová`) is preserved |
| P1-M1-10 | A 1 MB message is parsed in under 50 ms (guards against pathological input) |

### Edge cases

- Merge commits generated by GitHub ("Merge branch 'main' into feature") carry no trailers; parsed as such, not special-cased.
- `Signed-off-by` and other unrelated trailers are returned too; matching happens in P1-M2.

### Acceptance criteria

- [ ] All P1-M1 cases pass
- [ ] Function is pure and fully typed; 100 % branch coverage

### Completion checklist

- [ ] Fixtures for real-world messages (Claude Code, Copilot, Cursor) under `test/fixtures/commits/`
- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P1-M2 — Rule matching (trailers and labels)

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P1-M1

### Goal

`classifyCommits(commits, labels, rules): Classification` marks each commit as AI-tagged or not and records **every** rule that matched, so the report can say why.

### User scenarios

- As a reviewer, I want to see that a commit was tagged because `Co-authored-by` matched `copilot`, not just that it was tagged.
- As a team lead, I add the `ai-assisted` label to a PR whose author used an AI chat without trailers; every commit in the PR is then tagged with reason `label:ai-assisted`.

### Test cases

| ID | Scenario |
|---|---|
| P1-M2-01 | `Co-Authored-By: Claude …` matches the default rule (case-insensitive key and value) |
| P1-M2-02 | `Co-authored-by: GitHub Copilot <…>` matches the default rule |
| P1-M2-03 | `Co-authored-by: Jana Nováková <…>` (a human) does not match |
| P1-M2-04 | `Assisted-by:` and `Generated-by:` match on key alone when no value regex is configured |
| P1-M2-05 | A key-only rule does not match a different key that contains it (`Not-Assisted-by`) |
| P1-M2-06 | A commit matching two rules records both reasons |
| P1-M2-07 | A configured PR label tags every commit with reason `label:<name>`; label match is case-insensitive |
| P1-M2-08 | No trailers and no label gives `aiTagged: false` for every commit |
| P1-M2-09 | A custom rule from config (e.g. `X-AI-Tool: .*`) is honoured |
| P1-M2-10 | Matching uses `value` only; a regex is never tested against the whole message |

### Edge cases

- Spoofed or human-added trailers are tagged exactly like genuine ones. This is by design and is documented in the README threat model (P7-M2).

### Acceptance criteria

- [ ] All P1-M2 cases pass
- [ ] The classification output type carries `reasons: { rule: string; matched: string }[]` per commit

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P1-M3 — Diff to files and lines

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P0-M1 (independent of P1-M1 and P1-M2)

### Goal

`mapChanges(commitFiles): FileChange[]` turns the per-commit file list from the REST API (`filename`, `status`, `patch`, `previous_filename`) into files with added-line ranges, then `aggregateAiChanges()` merges ranges across all AI-tagged commits.

### User scenarios

- As an auditor, I want to see `src/cart.ts: lines 10-24, 40-41` for an AI-tagged commit, not just the file name.

### Test cases

| ID | Scenario |
|---|---|
| P1-M3-01 | A single hunk `@@ -0,0 +1,5 @@` yields added range `1-5` |
| P1-M3-02 | Multiple hunks yield multiple ranges, with context lines excluded |
| P1-M3-03 | A deletion-only hunk yields no added ranges but the file is still listed (status `modified`) |
| P1-M3-04 | A removed file is listed with status `removed` and no ranges |
| P1-M3-05 | A renamed file keeps `previousFilename` |
| P1-M3-06 | A binary file or one without `patch` (diff too large) is listed with `lines: "unknown"` |
| P1-M3-07 | Overlapping and adjacent ranges from two AI commits on the same file are merged |
| P1-M3-08 | `\ No newline at end of file` markers do not shift line numbers |
| P1-M3-09 | Files are sorted by path for deterministic output |

### Edge cases

- Ranges describe lines **as added by the AI-tagged commit at that commit**. A later human commit may move or change them. The report states this explicitly; precise final-state blame is out of scope for v1.

### Acceptance criteria

- [ ] All P1-M3 cases pass
- [ ] Output is deterministic (same input, byte-identical JSON)

### Completion checklist

- [ ] Patch fixtures recorded from real REST responses
- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

---

# Phase 2 — Configuration

**Status:** ⏳ Planned · **Focus:** a small, strictly validated YAML config with helpful errors.

## P2-M1 — Config schema, defaults and validation

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P1-M2

### Goal

`loadConfig(yamlText | undefined): Result<Config, ConfigError[]>` parses YAML, applies defaults, validates against `schema/config.v1.schema.json` and compiles regexes safely.

### User scenarios

- As an adopter with no config file, the Action works with defaults and the report says `config: defaults`.
- As an adopter with a typo (`treshold`), I get an error naming `policy.gates[0].treshold` and suggesting `threshold`, and the job fails before doing anything else.

### Test cases

| ID | Scenario |
|---|---|
| P2-M1-01 | `undefined` input returns the built-in defaults |
| P2-M1-02 | A minimal valid config merges with defaults (user `labels` replace the default list rather than appending) |
| P2-M1-03 | An unknown key fails with its YAML path |
| P2-M1-04 | `version: 2` fails with "unsupported config version" |
| P2-M1-05 | An invalid regex fails with the rule index and the regex error message |
| P2-M1-06 | A regex longer than 200 characters is rejected (ReDoS guard) |
| P2-M1-07 | `threshold` outside 0-100 fails |
| P2-M1-08 | Duplicate gate `id`s fail |
| P2-M1-09 | Malformed YAML fails with line and column |
| P2-M1-10 | The JSON Schema file itself is valid and is exported for editor autocompletion |

### Acceptance criteria

- [ ] All P2-M1 cases pass
- [ ] `docs/configuration.md` documents every field, generated or checked against the schema

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

---

# Phase 3 — Policy engine

**Status:** ⏳ Planned · **Focus:** decide pass, warn or fail from classification, config and evidence, with no I/O.

## P3-M1 — Evaluation engine and enforce/warn

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P2-M1

### Goal

`evaluatePolicy(ctx, config): PolicyResult` runs each gate and combines results. Each gate returns `pass | fail | skipped | error` with a message; the gate's `mode` maps `fail`/`error` to the verdict `fail` (enforce) or `warn` (warn).

### User scenarios

- As a team piloting the Action, I set `mode: warn`, so failing gates show up in the summary without blocking merges.
- As a PR author with no AI-tagged commits, gates are not evaluated and the verdict is `pass` with reason `no-ai-changes`.

### Test cases

| ID | Scenario |
|---|---|
| P3-M1-01 | No AI-tagged commits gives verdict `pass`, every gate `skipped`, reason `no-ai-changes` |
| P3-M1-02 | All gates pass gives `pass` |
| P3-M1-03 | One enforced gate fails gives `fail` |
| P3-M1-04 | One warn-mode gate fails and the others pass gives `warn` |
| P3-M1-05 | Global `mode: warn` downgrades every failure to `warn` unless a gate overrides with `enforce` |
| P3-M1-06 | A gate that throws becomes `error` with the message, and other gates still run |
| P3-M1-07 | Truncated input data with `on-truncated: fail` gives `fail` with reason `truncated` |
| P3-M1-08 | Zero gates configured with AI changes present gives `pass` with note `report-only` |

### Acceptance criteria

- [ ] All P3-M1 cases pass
- [ ] Gates implement one `Gate` interface; adding a gate type touches no engine code

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P3-M2 — Mutation-score gate (Stryker report)

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P3-M1

### Goal

Parse a Stryker report in the `mutation-testing-report-schema` format and compute the mutation score, either over all files or only over AI-touched files.

### User scenarios

- As an SDET, my Stryker job uploads `reports/mutation/mutation.json`; this gate downloads nothing, it just reads the path I pass and fails the PR if AI-touched files score below 80 %.

### Test cases

| ID | Scenario |
|---|---|
| P3-M2-01 | Score = detected / valid × 100, where detected = Killed + Timeout and valid excludes CompileError, RuntimeError and Ignored (Stryker's definition) |
| P3-M2-02 | `scope: ai-files` counts only mutants in files listed in `ai_files` |
| P3-M2-03 | Report paths are normalised (relative to project root, forward slashes) before matching PR paths |
| P3-M2-04 | Score exactly equal to the threshold passes |
| P3-M2-05 | AI files with no mutants (config, docs) gives `skipped` with "no mutants in scope", not `pass` |
| P3-M2-06 | Report missing with `on-missing: fail` gives `fail`; with `skip` gives `skipped` |
| P3-M2-07 | A malformed JSON or wrong schema gives `error` with a clear message |
| P3-M2-08 | A report from Stryker JS and one from Stryker.NET (fixtures) both parse |

### Acceptance criteria

- [ ] All P3-M2 cases pass
- [ ] The report records the score, threshold, mutant counts by status and the files in scope

### Completion checklist

- [ ] Real Stryker fixtures committed with a note on the version that generated them
- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P3-M3 — Required-label and approvals gates

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P3-M1

### Goal

Two gates over data the adapter already fetched: PR labels, and PR reviews reduced to each reviewer's latest state.

### User scenarios

- As a team lead, AI-assisted PRs need an `ai-reviewed` label set by a reviewer and at least one approval from someone other than the author.

### Test cases

| ID | Scenario |
|---|---|
| P3-M3-01 | Label present passes; absent fails; matching is case-insensitive |
| P3-M3-02 | One approval from a non-author with `min: 1` passes |
| P3-M3-03 | An approval from the PR author does not count |
| P3-M3-04 | A reviewer who approved and later requested changes counts as not approved (latest state wins) |
| P3-M3-05 | `COMMENTED` reviews do not change a reviewer's latest decisive state |
| P3-M3-06 | Dismissed reviews do not count |
| P3-M3-07 | Bot reviewers (`type: Bot`) do not count |

### Edge cases

- Gates are evaluated when the workflow runs. A label or approval added later only counts when the workflow re-runs, so the docs recommend triggering on `pull_request_review` and `labeled` events too.

### Acceptance criteria

- [ ] All P3-M3 cases pass

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

---

# Phase 4 — Audit report

**Status:** ⏳ Planned · **Focus:** one versioned JSON document, and one safe Markdown view of it.

## P4-M1 — JSON report and schema

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P1-M3, P3-M1

### Goal

`buildReport(input): Report` produces a document that validates against `schema/report.v1.schema.json`.

### Report contents

`schemaVersion`, `action` (name, version, commit SHA), `generatedAt` (ISO 8601 UTC), `run` (repository, workflow, run ID, run attempt, event), `pullRequest` (number, URL, base and head SHA, author), `config` (source: `base-branch` / `defaults`, path, SHA-256 hash), `commits[]` (SHA, author, `aiTagged`, `reasons[]`), `aiChanges[]` (file, status, line ranges or `unknown`), `gates[]` (id, type, mode, result, details), `verdict`, `limitations[]` (truncation, unknown lines, "trailers are declarations").

### Test cases

| ID | Scenario |
|---|---|
| P4-M1-01 | A full fixture input produces a report that validates against the schema |
| P4-M1-02 | The no-AI case produces a short valid report (empty `aiChanges`, verdict `pass`) |
| P4-M1-03 | Same input with an injected clock gives byte-identical output (stable key order) |
| P4-M1-04 | Truncation and unknown-lines limitations are listed when present |
| P4-M1-05 | Commit messages are not included in full, only SHA, subject (max 200 characters) and matched trailers, to keep the artifact small and avoid leaking long bodies |
| P4-M1-06 | Snapshot test of the full fixture report (reviewed in PR diffs) |

### Acceptance criteria

- [ ] All P4-M1 cases pass
- [ ] `docs/report-format.md` documents every field and the versioning policy

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P4-M2 — Markdown rendering and escaping

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P4-M1

### Goal

`renderMarkdown(report, { variant: "summary" | "comment" }): string` renders the job summary and PR comment from the report only, never from raw API data.

### User scenarios

- As a reviewer, the PR comment shows the verdict first, then a table of gates, then a collapsible `<details>` list of AI-tagged commits and files.

### Test cases

| ID | Scenario |
|---|---|
| P4-M2-01 | Verdict line uses ✅ / ⚠️ / ❌ and plain text (not colour only) |
| P4-M2-02 | A trailer value containing `<script>`, `|`, backticks or `@mention` is escaped and does not break the table or ping anyone |
| P4-M2-03 | A file path with Markdown characters (`*`, `_`, `[`) renders literally |
| P4-M2-04 | Long lists are capped (e.g. 50 files) with "…and N more, see the artifact" |
| P4-M2-05 | Comment output starts with the hidden marker `<!-- ai-provenance-action -->` |
| P4-M2-06 | Comment output stays under GitHub's 65 536-character limit for a 3000-file fixture |
| P4-M2-07 | The no-AI case renders a single line |
| P4-M2-08 | Snapshot tests for pass, warn, fail and no-AI |

### Acceptance criteria

- [ ] All P4-M2 cases pass
- [ ] The wording follows the evidence-not-compliance rule (checked by a test that greps rendered output for banned words such as "compliant" and "certified")

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

---

# Phase 5 — GitHub adapter

**Status:** ⏳ Planned · **Focus:** a thin REST layer, tested with `nock`, that feeds the pure core and publishes its outputs.

## P5-M1 — REST data fetching with pagination and limits

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P1-M3

### Goal

Fetch everything the core needs with REST only: PR metadata and labels, PR commits (`GET /pulls/{n}/commits`), files per AI-tagged commit (`GET /commits/{sha}`), and reviews (`GET /pulls/{n}/reviews`).

### Test cases

| ID | Scenario |
|---|---|
| P5-M1-01 | Commits are fetched with pagination (`per_page=100`) across 3 pages |
| P5-M1-02 | A PR with more than 250 commits sets `truncated: commits` (REST limit), never silently drops |
| P5-M1-03 | Commit files are fetched **only** for AI-tagged commits (no-AI PRs make no per-commit calls) |
| P5-M1-04 | A commit with more than 300 files is paginated, and truncation over `max-files` is flagged |
| P5-M1-05 | A 403 secondary rate limit is retried once with `retry-after`, then fails with a clear message |
| P5-M1-06 | Running on a non-PR event (`push`) fails fast with "this Action needs a pull_request event" |
| P5-M1-07 | No GraphQL endpoint is ever called (nock rejects `/graphql`) |

### Acceptance criteria

- [ ] All P5-M1 cases pass with no network access
- [ ] Number of API calls for a no-AI PR is ≤ 3 (asserted)

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P5-M2 — Config from the base branch

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P2-M1, P5-M1

### Goal

Read the config with `GET /contents/{path}?ref={base.sha}`, so the PR under review cannot change its own policy.

### Test cases

| ID | Scenario |
|---|---|
| P5-M2-01 | Config is requested with `ref` = base SHA, never head SHA |
| P5-M2-02 | 404 gives defaults and `config.source: defaults` |
| P5-M2-03 | A PR that edits `.github/ai-provenance.yml` is still judged by the base version, and the report notes `configChangedInPr: true` |
| P5-M2-04 | Invalid config fails the job with the P2-M1 error messages |

### Acceptance criteria

- [ ] All P5-M2 cases pass
- [ ] Threat model entry written for "PR weakens its own policy"

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P5-M3 — Outputs, job summary and artifact

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P4-M2, P5-M2, P3-M2, P3-M3

### Goal

Wire everything in `main.ts`: set outputs, write the job summary, write the JSON report and upload it as an artifact, read the mutation report from the `mutation-report` input, and set the job status from the verdict.

### Test cases

| ID | Scenario |
|---|---|
| P5-M3-01 | Outputs `ai_tagged`, `ai_files` (valid JSON array), `report_path` and `verdict` are set |
| P5-M3-02 | Verdict `fail` calls `core.setFailed`; `warn` emits a `core.warning` annotation and exits 0 |
| P5-M3-03 | The job summary is written in every outcome, including failure |
| P5-M3-04 | The artifact is named `ai-provenance-<pr>-<run_attempt>` so re-runs do not collide |
| P5-M3-05 | `upload-artifact: false` writes the file but skips the upload |
| P5-M3-06 | A `mutation-report` path outside the workspace is rejected (path traversal guard) |

### Acceptance criteria

- [ ] All P5-M3 cases pass
- [ ] `action.yml` inputs and outputs match the README table (checked by a test)

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

## P5-M4 — Sticky PR comment and fork PRs

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P5-M3

### Goal

Create or update one comment identified by the hidden marker, and degrade gracefully when the token is read-only.

### User scenarios

- As an external contributor opening a PR from a fork, the check still runs and the summary and artifact are produced; only the comment is skipped, with a notice explaining why.

### Test cases

| ID | Scenario |
|---|---|
| P5-M4-01 | No existing comment: one is created |
| P5-M4-02 | Existing marked comment: it is updated, not duplicated (marker searched across paginated comments) |
| P5-M4-03 | A comment by another user that contains the marker text is not edited (author must be the token's identity) |
| P5-M4-04 | 403 on comment (fork, read-only token) gives a `core.notice`, and the verdict is unchanged |
| P5-M4-05 | Fork PR detection (`head.repo.full_name != base.repo.full_name`) is recorded in the report |
| P5-M4-06 | No-AI PR with an existing comment updates it to the short version rather than leaving a stale failure |

### Acceptance criteria

- [ ] All P5-M4 cases pass
- [ ] README explains why `pull_request_target` is **not** recommended, and the permissions block needed (`contents: read`, `pull-requests: write` only when `pr-comment: true`)

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

---

# Phase 6 — End-to-end and dogfooding

**Status:** ⏳ Planned · **Focus:** prove the bundled `dist/` works on real GitHub, not only under mocks.

## P6-M1 — Self-test workflow and scenario PRs

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P5-M4

### Goal

An `e2e.yml` workflow runs `uses: ./` on this repo's own PRs, and a set of long-lived scenario branches shows each outcome.

### Test cases

| ID | Scenario |
|---|---|
| P6-M1-01 | A PR with no AI trailers: verdict `pass`, short summary, `ai_tagged=false` |
| P6-M1-02 | A PR with a Claude trailer and a passing fixture mutation report: `pass` with full report |
| P6-M1-03 | A PR with a Copilot trailer and a mutation score below threshold: `fail` |
| P6-M1-04 | The same as P6-M1-03 in warn mode: `warn`, job green, annotation shown |
| P6-M1-05 | A downstream job uses `if: needs.provenance.outputs.ai_tagged == 'true'` and runs only then |
| P6-M1-06 | Squash-merging a tagged PR: the report artifact from the PR run still lists the original trailers |
| P6-M1-07 | A PR from a test fork: comment skipped, summary and artifact present |
| P6-M1-08 | The downloaded artifact validates against `schema/report.v1.schema.json` in a follow-up job |

### Acceptance criteria

- [ ] All scenario runs are linked from `docs/scenarios.md` with screenshots of the summary and comment
- [ ] E2E runs on every PR to `main`

### Completion checklist

- [ ] Implementation notes filled in

### Implementation notes

_To be filled in after completion._

---

# Phase 7 — Release and Marketplace

**Status:** ⏳ Planned · **Focus:** a README a recruiter or adopter can read in two minutes, and a repeatable release.

## P7-M1 — README and Marketplace metadata

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P6-M1

### Scope

- README sections: what it does (three bullets), quick start (copy-paste workflow), inputs and outputs, config reference link, example summary screenshot, permissions, "What this is not" (not AI detection, not certification), ISO/IEC 42001 and 27001 mapping table phrased as "evidence that supports"
- `action.yml` `branding` (icon, colour), `description` ≤ 125 characters
- Badges: CI, coverage, check-dist, latest release

### Test cases

| ID | Scenario |
|---|---|
| P7-M1-01 | Quick-start workflow copied verbatim from the README runs green on a fresh test repo |
| P7-M1-02 | Every input and output in `action.yml` appears in the README (doc test from P5-M3) |
| P7-M1-03 | Markdown link check passes |

### Acceptance criteria

- [ ] All P7-M1 cases pass

### Implementation notes

_To be filled in after completion._

## P7-M2 — Threat model and security docs

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P6-M1

### Scope

`docs/threat-model.md` and `SECURITY.md` covering: spoofed or missing trailers (declaration, not proof), a PR weakening its own policy (base-branch config), Markdown and mention injection (escaping), fork PRs (read-only token, no `pull_request_target`), ReDoS through config regexes, a forged mutation report (trust boundary: the report comes from your own earlier job; recommend artifacts from the same run), and truncation on very large PRs.

### Acceptance criteria

- [ ] Every threat links to the test IDs that cover it

### Implementation notes

_To be filled in after completion._

## P7-M3 — Release automation

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P7-M1

### Scope

A `release.yml` workflow triggered by a `vX.Y.Z` tag: verifies `dist/` is current, creates the GitHub release with notes, and moves the `vX` major tag. A `CHANGELOG.md`.

### Test cases

| ID | Scenario |
|---|---|
| P7-M3-01 | Tag `v1.0.0` creates a release and moves `v1` to the same SHA |
| P7-M3-02 | A tag on a commit where `dist/` is stale fails the release |
| P7-M3-03 | A pre-release tag (`v1.1.0-rc.1`) does not move `v1` |
| P7-M3-04 | `uses: ksycz/ai-provenance-action@v1` from another repo resolves to the latest `v1.x` |

### Acceptance criteria

- [ ] `v1.0.0` published on the Marketplace

### Implementation notes

_To be filled in after completion._

---

# Phase 8 — Integration with playwright-test-ai-inspector

**Status:** ⏳ Planned · **Focus:** "I built a reusable Action and use it in my own project."

## P8-M1 — Adopt the Action

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P7-M3

### Scope

A PR to `ksycz/playwright-test-ai-inspector` that adds an `ai-provenance` job pinned to `@v1`, a `.github/ai-provenance.yml` on its `main`, and (if Stryker is not set up there yet) a Stryker job scoped to the `ai/` tooling so the mutation gate has real input.

### Test cases

| ID | Scenario |
|---|---|
| P8-M1-01 | Existing Playwright CI is unchanged in duration and result on a no-AI PR |
| P8-M1-02 | The provenance job runs after the Stryker job and reads its report from the same run's artifact |

## P8-M2 — Demo PR

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P8-M1

### Scope

A real, small AI-assisted change (committed with an AI trailer) that shows the gate failing first (mutation score below threshold), then passing after tests are added. Both runs stay visible in the PR history, with the sticky comment and the downloadable audit artifact.

### Test cases

| ID | Scenario |
|---|---|
| P8-M2-01 | First push: verdict `fail`, comment shows the mutation gate below threshold |
| P8-M2-02 | After adding tests: the same comment is updated to `pass` |
| P8-M2-03 | The artifact for each run is downloadable and validates against the schema |

## P8-M3 — Cross-linked READMEs

**Status:** ⏳ Planned
**Completed:** —
**Dependencies:** P8-M2

### Scope

- playwright-test-ai-inspector README: an "AI provenance and audit trail" section linking to the Action, the demo PR and a screenshot; its ROADMAP entry marked ✅
- ai-provenance-action README: a "Used in" section linking back to the demo PR

### Acceptance criteria

- [ ] Both pinned repos link to each other, and both links resolve
- [ ] The demo PR is linked from both READMEs

---

## Dependency graph

```text
P0-M1 Scaffold
├── P1-M1 Trailer parsing
│   └── P1-M2 Rule matching
│       └── P2-M1 Config
│           ├── P3-M1 Policy engine
│           │   ├── P3-M2 Mutation gate ──────────┐
│           │   ├── P3-M3 Label/approval gates ───┤
│           │   └── P4-M1 JSON report             │
│           │       └── P4-M2 Markdown            │
│           └── P5-M2 Config from base ───────────┤
└── P1-M3 Diff → lines                            │
    ├── P4-M1 (also depends here)                 │
    └── P5-M1 REST fetching                       │
        └── P5-M2                                 │
                                                  ▼
                                    P5-M3 Outputs/summary/artifact
                                    └── P5-M4 Sticky comment + forks
                                        └── P6-M1 E2E + dogfooding
                                            ├── P7-M1 README
                                            │   └── P7-M3 Release v1
                                            │       └── P8-M1 Adopt
                                            │           └── P8-M2 Demo PR
                                            │               └── P8-M3 Cross-links
                                            └── P7-M2 Threat model
```

---

## Post-v1 backlog (not scheduled)

| Item | Notes |
|---|---|
| LLM summary paragraph | Provider abstraction (`none` default, `openai`, `anthropic`). Off by default; never runs on fork PRs (no secrets). Output is schema-validated (`{ summary: string ≤ 600 chars }`), escaped, and labelled "AI-generated summary" in the comment. The JSON report remains the source of truth. |
| Coverage gate | Read an lcov / Istanbul JSON report for AI-touched lines |
| SARIF / code-scanning gate | Require zero new alerts on AI-touched files |
| Signed reports | Artifact attestations (`actions/attest-build-provenance`) for the JSON report |
| Final-state line mapping | Blame-based mapping of AI lines at the PR head |

---

## Progress Summary

| Milestone | Status | Completed |
|---|---|---|
| P0-M1 — Repository scaffold and CI | 🚧 In progress | — |
| P1-M1 — Trailer parsing | ⏳ Planned | — |
| P1-M2 — Rule matching | ⏳ Planned | — |
| P1-M3 — Diff to files and lines | ⏳ Planned | — |
| P2-M1 — Config schema, defaults and validation | ⏳ Planned | — |
| P3-M1 — Evaluation engine and enforce/warn | ⏳ Planned | — |
| P3-M2 — Mutation-score gate | ⏳ Planned | — |
| P3-M3 — Required-label and approvals gates | ⏳ Planned | — |
| P4-M1 — JSON report and schema | ⏳ Planned | — |
| P4-M2 — Markdown rendering and escaping | ⏳ Planned | — |
| P5-M1 — REST data fetching | ⏳ Planned | — |
| P5-M2 — Config from the base branch | ⏳ Planned | — |
| P5-M3 — Outputs, job summary and artifact | ⏳ Planned | — |
| P5-M4 — Sticky PR comment and fork PRs | ⏳ Planned | — |
| P6-M1 — Self-test workflow and scenario PRs | ⏳ Planned | — |
| P7-M1 — README and Marketplace metadata | ⏳ Planned | — |
| P7-M2 — Threat model and security docs | ⏳ Planned | — |
| P7-M3 — Release automation | ⏳ Planned | — |
| P8-M1 — Adopt the Action | ⏳ Planned | — |
| P8-M2 — Demo PR | ⏳ Planned | — |
| P8-M3 — Cross-linked READMEs | ⏳ Planned | — |

**Phase status:** P0 scaffold underway.

- 21 milestones across 9 phases (0-8), ~140 test cases
- v1 scope ends at P7-M3; Phase 8 is the portfolio integration
</user_query>