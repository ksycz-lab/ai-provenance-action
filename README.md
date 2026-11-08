# AI Provenance Audit (`ai-provenance-action`)

Reusable GitHub Action that records **declared** AI-assisted pull-request changes, evaluates policy gates from other jobs, and publishes an audit report. It produces **evidence that supports an audit**; it does not detect AI code or certify compliance.

**Status:** Phases 1–4 (detection, config, policy engine, audit report and its Markdown view) are complete. Phase 5 (GitHub adapter) is in progress: The Action runs end to end: it reads the PR and the base-branch policy, evaluates the gates, writes the job summary and uploads the JSON report (P5-M1 to P5-M3). The sticky PR comment comes next (P5-M4). See also [docs/threat-model.md](./docs/threat-model.md). See [docs/ROADMAP.md](./docs/ROADMAP.md), [docs/configuration.md](./docs/configuration.md) and [docs/report-format.md](./docs/report-format.md).

## Quick start (placeholder)

```yaml
- uses: ./ # or ksycz/ai-provenance-action@v1 once released
  with:
    pr-comment: "true"
```

## Inputs

| Input             | Default                     | Purpose                                                                                     |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `github-token`    | `${{ github.token }}`       | Token for the GitHub REST API. Needs `contents: read` and `pull-requests: read`.            |
| `config-path`     | `.github/ai-provenance.yml` | Where the policy file lives. It is always read from the PR's base branch.                   |
| `mutation-report` | _(empty)_                   | Path to a Stryker `mutation.json` written by an earlier step. Must be inside the workspace. |
| `report-path`     | `ai-provenance-report.json` | Where to write the JSON report, inside the workspace.                                       |
| `upload-artifact` | `true`                      | Upload the report as the artifact `ai-provenance-<pr>-<run_attempt>`.                       |
| `pr-comment`      | `false`                     | Create or update a sticky PR comment. Not implemented yet (P5-M4).                          |

## Outputs

| Output        | Example                     | Purpose                                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `ai_tagged`   | `true`                      | Whether any commit or PR label was declared AI-assisted.                       |
| `ai_files`    | `["src/a.ts"]`              | JSON array of files touched by AI-tagged commits.                              |
| `report_path` | `ai-provenance-report.json` | Path of the written JSON report.                                               |
| `verdict`     | `pass`                      | Overall policy result: `pass`, `warn` or `fail`. A `fail` also fails the step. |

## Development

```bash
nvm use
npm ci
npm run ci
```

## Tooling choices

Short rationale for libraries named in the roadmap—helpful when skimming the repo.

**nock** — HTTP mocking for Node test runs. Phase 5 adapter tests call the GitHub REST API through `@actions/github`; nock intercepts those requests in-process and returns fixtures, so CI never needs network access and cases like pagination or rate limits stay deterministic. [MSW](https://mswjs.io/) is the usual alternative if you want the same pattern in browser and Node tests; stubbing Octokit by hand is lighter but less faithful to real URLs and headers.

**Rollup** — Bundles `src/main.ts` into a single committed `dist/index.js` that the Action executes on the runner. GitHub Actions expect a self-contained entry file; Rollup tree-shakes and keeps the bundle explicit. Many Actions use `@vercel/ncc` or **esbuild** (often via **tsup**) instead for speed; Rollup was chosen here for a clear build graph and a committed artifact checked by the `check-dist` workflow.

**Ajv** — Validates YAML-backed config and the JSON audit report against checked-in JSON Schema files (`schema/*.schema.json`). Phase 2 can surface errors at the YAML path (e.g. `policy.gates[0].threshold`) for adopters. **Zod** or **Valibot** are strong when TypeScript types are the source of truth; Ajv fits when the schema files are the contract (editor completion, report versioning docs).

**ESLint and Prettier** — ESLint (with **typescript-eslint**) enforces style and rules such as “`src/core/` must not import `@actions/*` or adapters”; **dependency-cruiser** enforces the same boundary in CI. **Biome** can replace ESLint + Prettier in one fast tool; **Oxlint** is often added for speed, not as a full replacement. This repo keeps the widespread ESLint + Prettier split so custom architectural rules stay straightforward in a portfolio and on the Marketplace.
