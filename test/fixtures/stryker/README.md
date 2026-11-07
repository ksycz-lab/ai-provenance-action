# Stryker report fixtures

Hand-written, reduced copies of the [mutation-testing-report-schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) used by Stryker.

| File                  | Generator                                            | schemaVersion                |
| --------------------- | ---------------------------------------------------- | ---------------------------- |
| `stryker-js.json`     | StrykerJS-style (unix paths, `language: javascript`) | `2` (StrykerJS 8.x family)   |
| `stryker-dotnet.json` | Stryker.NET-style (Windows paths, extra `testFiles`) | `3` (Stryker.NET 4.x family) |

They are not dumps from a real run: they only contain the fields this gate reads (`files`, `mutants[].status`).
