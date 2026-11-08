# Project Roadmap

A milestone plan and progress log for **ai-provenance-action**: a reusable GitHub Action that records which pull-request changes were AI-assisted, applies a policy to them, and produces an audit report.

**Current focus:** P0–P5 complete; the Action runs end to end with its sticky PR comment. Next: P6-M1 self-test workflow and scenario PRs.

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
| 0 | Scaffold | ✅ Completed | Wired repo, CI, check-dist and core-purity rule |
| 1 | Detection core | ✅ Completed | Pure trailer parsing, rule matching and diff-to-lines mapping |
| 2 | Configuration | ✅ Completed | YAML config schema, defaults, validation errors |
| 3 | Policy engine | ✅ Completed | Gate evaluation, enforce/warn, Stryker mutation score, label and approval gates |
| 4 | Audit report | ✅ Completed | Versioned JSON report and escaped Markdown rendering |
| 5 | GitHub adapter | ✅ Completed | REST fetching with pagination and limits, outputs, summary, artifact, sticky comment, fork handling |
| 6 | End-to-end and dogfooding | ⏳ Planned | Self-test workflows running the bundled Action on real PRs |
| 7 | Release and Marketplace | ⏳ Planned | README, threat model, release automation, `v1` tag |
| 8 | Integration with playwright-test-ai-inspector | ⏳ Planned | Adopt the Action, demo PR, cross-linked READMEs |

The phases run from easiest to hardest: Phases 1-4 are pure functions with fixtures, Phase 5 introduces I/O behind mocks, and Phases 6-8 run against real GitHub.

---

# Phase 0 — Scaffold

**Status:** ✅ Completed · **Focus:** an empty but fully wired repo, so every later milestone starts red-green straight away.

## P0-M1 — Repository scaffold and CI

**Status:** ✅ Completed
**Completed:** 2026-11-08
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

- [x] All four CI checks are green on `main`
- [x] Core purity is enforced by tooling (P0-M1-04), not just by convention
- [x] `action.yml` passes `actionlint` / schema validation

### Completion checklist

- [x] Branch protection requires `ci` and `check-dist`
- [x] Implementation notes filled in

### Implementation notes

**Summary:** The repo is wired end to end on a placeholder `main.ts`. `ci` runs typecheck, lint (ESLint + Prettier), the core-purity rule, tests with coverage and the build, and a separate `actionlint` job lints the workflows. `check-dist` rebuilds and fails on any `dist/` diff.

**Architectural decisions:** `main` is protected by a repository ruleset rather than classic branch protection: no deletion, no force pushes, changes only through pull requests (0 approvals, since this is a solo repo), and `ci`, `check-dist` and `actionlint` must pass. `actionlint` only covers workflow files, so `action.yml` was checked separately against the SchemaStore GitHub Action schema.

**Deviations:** `actionlint` is also a required check, one more than the two named in the checklist.

**Tests implemented:** P0-M1-01 and P0-M1-04 as Vitest tests. P0-M1-02 and P0-M1-03 were verified once on throwaway draft PRs, closed unmerged:

- P0-M1-02: [#10](https://github.com/ksycz/ai-provenance-action/pull/10) changed `src/main.ts` without rebuilding; only `check-dist` failed.
- P0-M1-03: [#11](https://github.com/ksycz/ai-provenance-action/pull/11) added an untested file in `src/core/`; only `ci` failed, at the coverage step (72.6 % core lines against the 95 % threshold).

---

# Phase 1 — Detection core

**Status:** ✅ Completed · **Focus:** pure functions that turn commits, labels and diffs into "what was AI-assisted, and why".

## P1-M1 — Trailer parsing

**Status:** ✅ Completed
**Completed:** 2026-11-07
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

- [x] All P1-M1 cases pass
- [x] Function is pure and fully typed; 100 % branch coverage

### Completion checklist

- [x] Fixtures for real-world messages (Claude Code, Copilot, Cursor) under `test/fixtures/commits/`
- [x] Implementation notes filled in

### Implementation notes

**Summary:** `parseTrailers()` in `src/core/parse-trailers.ts` copies `git interpret-trailers --parse` (Git 2.50): last paragraph only, after a blank line; unfold continuation lines with a space.

**Architectural decisions:** Pure function, no I/O. Git-generated prefix that unlocks mixed blocks is only `Signed-off-by: ` (and cherry-pick lines), not `Co-authored-by`. Matching AI tools is P1-M2.

**Deviations:** P1-M1-07 also asserts the Signed-off-by 25% exception and an orphan continuation, so we match Git rather than treating every mixed paragraph as empty.

**Tests implemented:** P1-M1-01 … P1-M1-10 plus real-world fixtures.

## P1-M2 — Rule matching (trailers and labels)

**Status:** ✅ Completed
**Completed:** 2026-11-07
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

- [x] All P1-M2 cases pass
- [x] The classification output type carries `reasons: { rule: string; matched: string }[]` per commit

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `classifyCommits(commits, labels, rules)` parses each message with `parseTrailers`, matches configured trailer rules, and applies PR labels to every commit. Each match is a `{ rule, matched }` reason so the report can say *why*.

**Architectural decisions:** Default rules live in `DEFAULT_DETECTION_RULES` until P2-M1 loads YAML. Trailer reasons use `trailer:<configured key>`; labels use `label:<configured name>` with the actual PR label in `matched`. Value regexes are case-insensitive and run only on the trailer value.

**Deviations:** none.

**Tests implemented:** P1-M2-01 … P1-M2-10.

## P1-M3 — Diff to files and lines

**Status:** ✅ Completed
**Completed:** 2026-11-07
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

- [x] All P1-M3 cases pass
- [x] Output is deterministic (same input, byte-identical JSON)

### Completion checklist

- [x] Patch fixtures recorded from real REST responses
- [x] Implementation notes filled in

### Implementation notes

**Summary:** `mapChanges()` reads GitHub-shaped `{ filename, status, patch, previous_filename }` and records added-line ranges on the new side of the unified diff. `aggregateAiChanges()` unions ranges per path across AI-tagged commits (oldest first; later status/rename wins). Adjacent and overlapping ranges merge.

**Architectural decisions:** Missing `patch` (binary / truncated diff) is `lines: "unknown"`, never guessed. Removed files always have empty ranges. Line numbers are as of that commit, not final blame.

**Deviations:** P1-M3-08 expects merged adjacent added lines (`2-3`) after ignoring `\\ No newline at end of file`; the marker must not shift numbers.

**Tests implemented:** P1-M3-01 … P1-M3-09 plus `test/fixtures/patches/commit-files.rest.json`.

---

# Phase 2 — Configuration

**Status:** ✅ Completed · **Focus:** a small, strictly validated YAML config with helpful errors.

## P2-M1 — Config schema, defaults and validation

**Status:** ✅ Completed
**Completed:** 2026-11-07
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

- [x] All P2-M1 cases pass
- [x] `docs/configuration.md` documents every field, generated or checked against the schema

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `loadConfig(yamlText | undefined)` parses YAML, validates against `schema/config.v1.schema.json` (Ajv 2020-12), compiles trailer regexes, and merges with defaults. Missing file (`undefined`) is `source: defaults` with no gates.

**Architectural decisions:** User `labels` / `trailers` replace the default lists. YAML stays kebab-case; the in-memory `Config` uses camelCase (`onMissing`, `maxCommits`). Regexes longer than 200 characters are rejected before `new RegExp`. Unknown keys report a YAML path and a close-key suggestion (`treshold` → `threshold`).

**Deviations:** none.

**Tests implemented:** P2-M1-01 … P2-M1-10. Docs field names are asserted against the schema.

---

# Phase 3 — Policy engine

**Status:** ✅ Completed · **Focus:** decide pass, warn or fail from classification, config and evidence, with no I/O.

## P3-M1 — Evaluation engine and enforce/warn

**Status:** ✅ Completed
**Completed:** 2026-11-07
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

- [x] All P3-M1 cases pass
- [x] Gates implement one `Gate` interface; adding a gate type touches no engine code

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `evaluatePolicy(ctx, config, handlers)` skips gates when there is no AI, fail-fast skips them when input is truncated and `on-truncated: fail`, otherwise runs every configured gate. `fail`/`error` become verdict `fail` or `warn` from the gate's mode (gate `mode` overrides global `policy.mode`).

**Architectural decisions:** Handlers are injected (`Gate` with a `type` string). The engine never switches on mutation vs label vs approvals. Unknown types and thrown errors both become `result: error`; later gates still run.

**Deviations:** Truncation with `on-truncated: fail` skips remaining gates (fail-safe: we may have missed AI commits). `report-only` is both `reason` and `note` so either field is easy to assert.

**Tests implemented:** P3-M1-01 … P3-M1-08.

## P3-M2 — Mutation-score gate (Stryker report)

**Status:** ✅ Completed
**Completed:** 2026-11-07
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

- [x] All P3-M2 cases pass
- [x] The report records the score, threshold, mutant counts by status and the files in scope

### Completion checklist

- [x] Real Stryker fixtures committed with a note on the version that generated them
- [x] Implementation notes filled in

### Implementation notes

**Summary:** `mutationScoreGate` implements `Gate` (`type: mutation-score`). It does not read disk: `PolicyContext.mutationReport` is `missing` | `invalid` | `present`. Score is Stryker’s detected/valid (Killed+Timeout over all except CompileError, RuntimeError, Ignored). `scope: ai-files` matches normalised paths.

**Architectural decisions:** Malformed reports **throw**, so the engine records `error` (P3-M1-06). Missing reports use `on-missing` (`fail` or `skip`). Details (`score`, `threshold`, `counts`, `filesInScope`) pass through `GateEvaluation.details` for the later JSON report.

**Deviations:** Fixtures are reduced schema-shaped documents, not dumps from a live Stryker run; versions are noted in `test/fixtures/stryker/README.md`.

**Tests implemented:** P3-M2-01 … P3-M2-08.

## P3-M3 — Required-label and approvals gates

**Status:** ✅ Completed
**Completed:** 2026-11-07
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

- [x] All P3-M3 cases pass

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `requiredLabelGate` and `approvalsGate` implement `Gate`. Labels match case-insensitively. Approvals reduce reviews per login to the latest `APPROVED` or `CHANGES_REQUESTED`; `COMMENTED` is ignored; `DISMISSED`, the PR author, and `type: Bot` do not count.

**Architectural decisions:** Review data is already-fetched (`PolicyContext.reviews`), no I/O. `min` defaults to 1.

**Deviations:** none. Docs note that `pull_request_review` and `labeled` should re-run the workflow.

**Tests implemented:** P3-M3-01 … P3-M3-07.

---

# Phase 4 — Audit report

**Status:** ✅ Completed · **Focus:** one versioned JSON document, and one safe Markdown view of it.

## P4-M1 — JSON report and schema

**Status:** ✅ Completed
**Completed:** 2026-11-08
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
| P4-M1-07 | `docs/report-format.md` mentions every field in the report schema (doc test, like P2-M1-10) |

### Acceptance criteria

- [x] All P4-M1 cases pass
- [x] `docs/report-format.md` documents every field and the versioning policy

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `buildReport(input)` in `src/core/build-report.ts` combines the PR commits, the classification, the aggregated AI changes and the policy result into one document that validates against `schema/report.v1.schema.json` (`schemaVersion: "1.0.0"`). `serializeReport()` writes it as pretty JSON with a trailing newline.

**Architectural decisions:** The builder stays pure: the clock (`generatedAt: Date`) and the config `sha256` come in through the input, so hashing and file reads stay in the adapter. Every object is rebuilt with a fixed key order and files are sorted by path, so the same input gives byte-identical output whatever order the caller used. Commits keep only SHA, author, a subject cut to 200 code points (with `…`) and the matched reasons; the message body never reaches the report. `limitations[]` uses stable codes (`declarations-only` always, plus `truncated-commits`, `truncated-files`, `unknown-lines` with the affected files, and `lines-as-of-commit`). The policy `reason` is exposed as optional `verdictReason`.

**Deviations:** Added P4-M1-07, a doc test that every schema field appears in `docs/report-format.md`. The snapshot is a JSON file (`test/__snapshots__/P4-M1.full-report.json`), excluded from Prettier so it stays byte-identical to the serializer output.

**Tests implemented:** P4-M1-01 … P4-M1-07. The full fixture is built with the real `classifyCommits`, `mapChanges`/`aggregateAiChanges` and `evaluatePolicy` over the existing commit and patch fixtures.

## P4-M2 — Markdown rendering and escaping

**Status:** ✅ Completed
**Completed:** 2026-11-08
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
| P4-M2-09 | Rendered output contains no banned wording ("compliant", "certified", "detects AI"), for every outcome and both variants |
| P4-M2-10 | Truncated input: the verdict line says the gates were not run, and the truncation warning is shown |
| P4-M2-11 | No gates configured: the verdict line says it is a report only |
| P4-M2-12 | A removed file is listed with "no added lines"; a one-line range prints as a single number |

### Acceptance criteria

- [x] All P4-M2 cases pass
- [x] The wording follows the evidence-not-compliance rule (checked by a test that greps rendered output for banned words such as "compliant" and "certified")

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `renderMarkdown(report, { variant })` in `src/core/render-markdown.ts` renders the job summary and the sticky PR comment from the P4-M1 report only. Order: verdict line (icon + word + counts), an optional truncation warning, the gates table, collapsible `<details>` lists of AI-tagged commits and touched files, and a footer in the evidence-not-compliance wording. The comment variant is the summary with `<!-- ai-provenance-action -->` as its first line.

**Architectural decisions:** `escapeMarkdown()` puts every piece of untrusted text on one line, turns HTML and Markdown specials into numeric entities, and adds an invisible word joiner (U+2060) after `@` and `#`. Entities alone are not enough there: GitHub links mentions and issue numbers after it decodes entities. Lists are capped at 50. A length guard halves the cap until the output fits a 60 000-character budget (headroom under GitHub's 65 536 limit), down to no lists at all.

**Deviations:** Added P4-M2-09 (banned-wording test, the acceptance criterion as a test) and P4-M2-10 … 12 for the truncated, report-only and removed-file branches. Those three tests were written after the code; each was checked to fail with its branch broken on purpose, then pass with it restored. The "…and N more" line points to "the JSON report", the artifact's content, because the artifact name is only decided in P5-M3. The hostile-input output was also checked with `cmark-gfm`: table columns stay intact, `<script>` shows as text, and no `@name` or `#number` survives in linkable form.

**Tests implemented:** P4-M2-01 … P4-M2-12, with Markdown snapshots in `test/__snapshots__/P4-M2.*.md`. The report fixtures come from the reviewed P4-M1 JSON snapshot.

---

# Phase 5 — GitHub adapter

**Status:** ✅ Completed · **Focus:** a thin REST layer, tested with `nock`, that feeds the pure core and publishes its outputs.

## P5-M1 — REST data fetching with pagination and limits

**Status:** ✅ Completed
**Completed:** 2026-11-08
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
| P5-M1-08 | Other errors (404, a plain 403 without `retry-after`, any non-403/429 status even with `retry-after`) are not retried |
| P5-M1-09 | Once `max-files` is reached, later AI-tagged commits are not fetched at all |

### Acceptance criteria

- [x] All P5-M1 cases pass with no network access
- [x] Number of API calls for a no-AI PR is ≤ 3 (asserted)

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `src/adapters/fetch-pull-request.ts` adds `pullRequestRef(context)` (fails fast on a non-PR event) and `gatherPullRequestData(client, ref, config)`. It reads the PR (`GET /pulls/{n}`), its commits (`GET /pulls/{n}/commits`, `per_page=100`, paginated), classifies them with the core, and only when something is AI-tagged fetches files per tagged commit (`GET /commits/{sha}`, following `Link` pages past 300 files) and the reviews. A no-AI PR costs 2 calls.

**Architectural decisions:** The Octokit client is passed in. Production code will use `getOctokit(token)` from `@actions/github`. Tests use the same real Octokit with Node's built-in `fetch`, so `nock` sees every request with real URLs, headers and pagination. The default client sends through its own `undici` dispatcher, which `nock` does not intercept. Every API step goes through `withRetry`: a 403 or 429 with `retry-after` (or a "secondary rate limit" message) waits and retries once, then fails with "re-run the job later"; any other error is thrown unchanged. `sleep` is injectable so tests do not wait. Commits beyond `max-commits`, or fewer listed than the PR's `commits` count (REST stops at 250), set `truncated.commits`. Files stop at `max-files` across all tagged commits and set `truncated.files`. Fork PRs are recorded (`isFork`) for P5-M4.

**Deviations:** Reviews are fetched only when a commit is AI-tagged, since gates are skipped otherwise; this keeps a no-AI PR at 2 calls instead of 3. Added P5-M1-08 and P5-M1-09, written after the code. Each was checked by breaking the code on purpose; the first try showed the 403/429 status check was untested, so P5-M1-08 gained a 404-with-`retry-after` case.

**Tests implemented:** P5-M1-01 … P5-M1-09 in `test/P5-M1.fetch-pull-request.test.ts`, all with `nock.disableNetConnect()`.

## P5-M2 — Config from the base branch

**Status:** ✅ Completed
**Completed:** 2026-11-08
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
| P5-M2-05 | `config.sha256` is the SHA-256 of the base file's bytes |
| P5-M2-06 | The PR comment says when the PR changes the config file |

### Acceptance criteria

- [x] All P5-M2 cases pass
- [x] Threat model entry written for "PR weakens its own policy" ([docs/threat-model.md](./threat-model.md))

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `loadBaseConfig(client, repo, { baseSha, headSha }, path)` in `src/adapters/load-base-config.ts` reads the config with `GET /contents/{path}?ref=<base sha>`, validates it with `loadConfig()` (P2-M1), and returns the config, its source (`base-branch` or `defaults`), the SHA-256 of the file bytes and `changedInPr`. A missing file gives the defaults; an invalid file throws one error listing every problem with its YAML path and suggestion.

**Architectural decisions:** To set `changedInPr` without ever reading the head version, the adapter walks Git trees at the head commit (`GET /git/trees/{sha}`, one call per path segment, 2 for the default path) and compares the config's blob SHA with the base file's. Only tree metadata is fetched, so the PR's version can never be parsed or used by mistake. The retry helper moved to `src/adapters/retry.ts` so both adapters share it.

**Deviations:** The report field is `config.changedInPr`, inside the existing `config` block, rather than a top-level `configChangedInPr`. The report schema is still `1.0.0`, because nothing has been released yet. Added P5-M2-05 (hash of the exact bytes) and P5-M2-06 (the PR comment shows an ℹ️ note when the PR changes the config), both written test-first. `docs/threat-model.md` is started here with this one entry; P7-M2 completes it.

**Tests implemented:** P5-M2-01 … P5-M2-06 in `test/P5-M2.load-base-config.test.ts`, with `nock` and no network.

## P5-M3 — Outputs, job summary and artifact

**Status:** ✅ Completed
**Completed:** 2026-11-08
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
| P5-M3-07 | `action.yml` inputs and outputs match the README tables (the acceptance criterion as a test) |
| P5-M3-08 | A `mutation-report` inside the workspace is read and the mutation gate scores the AI-touched files |

### Acceptance criteria

- [x] All P5-M3 cases pass
- [x] `action.yml` inputs and outputs match the README table (checked by a test)

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `run(deps)` in `src/adapters/run.ts` is the whole Action. It reads the PR (`fetchPullRequest`), loads the policy from the base commit, gathers commits, files and reviews with that policy's detection rules, reads the mutation report, evaluates the gates and builds the report. Then it writes the report file, sets the four outputs, writes the job summary and uploads the artifact `ai-provenance-<pr>-<run_attempt>`. A `fail` verdict calls `setFailed`; `warn` emits a warning and the step passes. `src/main.ts` only builds the real dependencies (`@actions/core`, `getOctokit`, `DefaultArtifactClient`, the GitHub context) and calls `run`.

**Architectural decisions:** Everything `run` touches comes in through `ActionDeps`, so tests drive the real adapters with `nock` and real files in a temporary workspace, with small recording fakes only for `core` and the upload. Any error before a report exists still writes a one-line ❌ summary, then fails the step. User paths (`mutation-report`, `report-path`) are resolved against the workspace and refused when they leave it, including through `..`, absolute paths and symlinks (checked with `realpath`). `fetchPullRequest` was split out of `gatherPullRequestData`: the PR's base and head SHAs are needed to load the config before commits are classified, and the PR is passed on (`prefetched`), so it is fetched only once.

**Deviations:** The README had no inputs and outputs tables yet, so they were added here and checked against `action.yml` (P5-M3-07). P5-M3-08 was written after the code; breaking the file read, or not passing the report to the gates, both made it fail. Rollup needed `@rollup/plugin-json` (the schemas are imported as JSON) and `inlineDynamicImports`. The bundle grew from 1.1 MB to 6.6 MB, mostly the Azure storage SDK behind `@actions/artifact`. The optional `kerberos` module stays external: it is loaded lazily, only for Negotiate proxy authentication. The built `dist/index.js` was smoke-run with a fake runner environment: on a `push` event it fails cleanly and writes the summary.

**Tests implemented:** P5-M3-01 … P5-M3-08 in `test/P5-M3.run.test.ts`.

## P5-M4 — Sticky PR comment and fork PRs

**Status:** ✅ Completed
**Completed:** 2026-11-08
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
| P5-M4-07 | A no-AI PR with no existing comment gets none, and `pr-comment: false` makes no comment calls at all |

### Acceptance criteria

- [x] All P5-M4 cases pass
- [x] README explains why `pull_request_target` is **not** recommended, and the permissions block needed (`contents: read`, `pull-requests: write` only when `pr-comment: true`)

### Completion checklist

- [x] Implementation notes filled in

### Implementation notes

**Summary:** `upsertComment()` in `src/adapters/pr-comment.ts` lists the PR's comments (paginated) and looks for one that starts with `<!-- ai-provenance-action -->` and was written by the token's identity. It updates that comment, or creates one. `run()` calls it when `pr-comment: true`. A 403 (fork PRs get a read-only token) becomes a `core.notice`; any other comment error becomes a warning. Neither changes the verdict, the summary or the artifact. The report gains `pullRequest.isFork`.

**Architectural decisions:** The token's identity comes from `GET /user`, which works for personal tokens. The workflow `GITHUB_TOKEN` gets a 403 there and always comments as `github-actions[bot]`, so that is the fallback. A PR with no AI-tagged commits updates an existing comment to the one-line version but never creates a new one, to avoid noise on ordinary PRs.

**Deviations:** Added P5-M4-07 (no new comment on no-AI PRs; no comment calls with `pr-comment: false`). The report schema gains the required field `pullRequest.isFork`, still `1.0.0` before the first release. The `run()` test harness moved to `test/helpers/action-harness.ts` and is shared by the P5-M3 and P5-M4 tests. The README Quick start is now a real workflow with a permissions block, and `docs/threat-model.md` gains entries for fake comments and fork PRs.

**Tests implemented:** P5-M4-01 … P5-M4-07 in `test/P5-M4.pr-comment.test.ts`, all written before the code.

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
| P0-M1 — Repository scaffold and CI | ✅ Completed | 2026-11-08 |
| P1-M1 — Trailer parsing | ✅ Completed | 2026-11-07 |
| P1-M2 — Rule matching | ✅ Completed | 2026-11-07 |
| P1-M3 — Diff to files and lines | ✅ Completed | 2026-11-07 |
| P2-M1 — Config schema, defaults and validation | ✅ Completed | 2026-11-07 |
| P3-M1 — Evaluation engine and enforce/warn | ✅ Completed | 2026-11-07 |
| P3-M2 — Mutation-score gate | ✅ Completed | 2026-11-07 |
| P3-M3 — Required-label and approvals gates | ✅ Completed | 2026-11-07 |
| P4-M1 — JSON report and schema | ✅ Completed | 2026-11-08 |
| P4-M2 — Markdown rendering and escaping | ✅ Completed | 2026-11-08 |
| P5-M1 — REST data fetching | ✅ Completed | 2026-11-08 |
| P5-M2 — Config from the base branch | ✅ Completed | 2026-11-08 |
| P5-M3 — Outputs, job summary and artifact | ✅ Completed | 2026-11-08 |
| P5-M4 — Sticky PR comment and fork PRs | ✅ Completed | 2026-11-08 |
| P6-M1 — Self-test workflow and scenario PRs | ⏳ Planned | — |
| P7-M1 — README and Marketplace metadata | ⏳ Planned | — |
| P7-M2 — Threat model and security docs | ⏳ Planned | — |
| P7-M3 — Release automation | ⏳ Planned | — |
| P8-M1 — Adopt the Action | ⏳ Planned | — |
| P8-M2 — Demo PR | ⏳ Planned | — |
| P8-M3 — Cross-linked READMEs | ⏳ Planned | — |

**Phase status:** P0–P5 complete. Next: P6-M1.

- 21 milestones across 9 phases (0-8), ~140 test cases
- v1 scope ends at P7-M3; Phase 8 is the portfolio integration
</user_query>