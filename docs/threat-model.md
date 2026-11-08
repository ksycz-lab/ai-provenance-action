# Threat model

What could go wrong with the evidence this Action produces, what the Action does about it, and what is left for the adopting team. Each entry links to the tests that cover it.

This page grows phase by phase; the full version is milestone P7-M2. The Action produces **evidence that supports an audit**. It does not certify compliance and does not detect AI-written code.

## A pull request weakens its own policy

**Threat.** The author of a pull request edits `.github/ai-provenance.yml` in that same PR, for example by switching `policy.mode` to `warn`, deleting a gate or lowering a mutation threshold, so that their own AI-assisted changes pass.

**What the Action does.**

- The config is read from the PR's **base commit** (`GET /contents/{path}?ref=<base sha>`), never from the head. A PR, including one from a fork, is always judged by the policy that is already on the target branch. Tests: P5-M2-01, P5-M2-03.
- The head version's content is never downloaded. To tell whether the PR changed the file, the Action compares Git blob SHAs from tree metadata (`GET /git/trees/...`), so the PR's version can never be parsed or used by mistake. Test: P5-M2-01.
- The report records `config.changedInPr: true`, and the PR comment says so, so a reviewer sees the attempt. Tests: P5-M2-03, P5-M2-06.
- The report records the SHA-256 of the exact config bytes used, so an auditor can match the policy afterwards. Test: P5-M2-05.
- A broken config on the base branch fails the job with the exact YAML path, instead of falling back to weaker defaults. Test: P5-M2-04.

**What is left for the team.**

- Once the PR is merged, its config change applies to later PRs. Protect the config with a `CODEOWNERS` entry for `.github/` and a required review.
- With the `pull_request` event, the workflow file itself comes from the PR's head, so a PR could remove the provenance job. Make the job a **required status check** in a branch ruleset: if the job does not run, the PR cannot be merged.
- Anyone who can push directly to the base branch can change the policy. Protect the branch with a ruleset that requires pull requests.
