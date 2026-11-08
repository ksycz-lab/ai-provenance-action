# End-to-end scenarios

The `e2e` workflow (`.github/workflows/e2e.yml`) runs the bundled Action (`uses: ./`) on every pull request to `main`, with this repository's own policy (`.github/ai-provenance.yml`, mutation gate at 80 % on AI-touched files). Each scenario below is a long-lived pull request that shows one outcome. Links and screenshots are added once the runs exist.

| ID       | Scenario                                        | Pull request                             | Expected                                                                                      |
| -------- | ----------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| P6-M1-01 | No AI trailers                                  | _pending_                                | `pass`, one-line summary, `ai_tagged=false`, `ai-only` job skipped                            |
| P6-M1-02 | Claude trailer, mutation report at 80 % or more | _pending_                                | `pass` with the full report                                                                   |
| P6-M1-03 | Copilot trailer, mutation report below 80 %     | _pending_                                | `provenance` job fails with verdict `fail`                                                    |
| P6-M1-04 | Same PR as P6-M1-03, warn-mode policy           | same as P6-M1-03                         | `provenance-warn` job green with a warning annotation                                         |
| P6-M1-05 | Downstream job                                  | every AI-tagged PR                       | `ai-only` runs only when `ai_tagged == 'true'`                                                |
| P6-M1-06 | Squash merge of a tagged PR                     | _pending_                                | the PR run's artifact still lists the original trailers                                       |
| P6-M1-07 | PR from a test fork                             | _pending, needs a second GitHub account_ | comment skipped with a notice; summary and artifact present                                   |
| P6-M1-08 | Artifact validation                             | every PR                                 | `validate-report` downloads the artifact and checks it against `schema/report.v1.schema.json` |

Each scenario PR carries its own Stryker-format report at `e2e/mutation.json`, covering only the file its AI-tagged commit adds. Ordinary PRs have no such file, so the mutation gate is skipped there (`on-missing: skip`).
