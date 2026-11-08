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

## Someone fakes the Action's PR comment

**Threat.** Anyone who can comment on a PR writes a comment that starts with the hidden marker `<!-- ai-provenance-action -->` and a fake ✅ result, hoping the Action will update it (making it look official) or that reviewers will trust it.

**What the Action does.**

- A comment is treated as the Action's own only when it starts with the marker **and** was written by the token's identity: `github-actions[bot]` for the workflow token, or the login from `GET /user` for a personal token. A marked comment by anyone else is never edited, and the Action posts its own. Test: P5-M4-03.
- The comment is only a view. The verdict lives in the check status and the report artifact, which a commenter cannot change. Tests: P5-M4-04, P5-M3-02.

**What is left for the team.** Trust the required status check and the artifact, not a comment's text. A fake comment will not show as written by `github-actions[bot]`.

## Fork pull requests and the read-only token

**Threat.** A workflow that gives fork PRs a write token (the `pull_request_target` trigger) can leak secrets or let fork code modify the repository.

**What the Action does.** It works with the plain `pull_request` trigger and a read-only token: on a fork PR it still evaluates the policy, writes the job summary and uploads the report. Only the PR comment is skipped, with a notice. Fork PRs are recorded as `pullRequest.isFork` in the report. Tests: P5-M4-04, P5-M4-05.

**What is left for the team.** Do not switch to `pull_request_target`. The README explains the permissions to grant.
