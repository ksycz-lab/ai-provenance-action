# AI Provenance Audit (`ai-provenance-action`)

Reusable GitHub Action that records **declared** AI-assisted pull-request changes, evaluates policy gates from other jobs, and publishes an audit report. It produces **evidence that supports an audit**; it does not detect AI code or certify compliance.

**Status:** Phase 2 (config). See [docs/ROADMAP.md](./docs/ROADMAP.md) and [docs/configuration.md](./docs/configuration.md).

## Quick start (placeholder)

```yaml
- uses: ./ # or ksycz/ai-provenance-action@v1 once released
  with:
    pr-comment: "true"
```

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
