# Contributing

See [docs/ROADMAP.md](./docs/ROADMAP.md) for milestone order and test-case IDs.

- Run `npm ci` and `npm run ci` before opening a PR.
- Name tests with milestone IDs (e.g. `P1-M1-01`).
- Core logic in `src/core/` stays free of I/O; adapters live in `src/adapters/`.
- Rebuild `dist/` with `npm run build` when `src/` changes — CI `check-dist` enforces this.
