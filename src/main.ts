import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { EventContext } from "./adapters/fetch-pull-request.js";
import { run } from "./adapters/run.js";
import { actionVersion } from "./core/version.js";

/** Entry point: build the real dependencies from the runner and hand them to run(). */
async function main(): Promise<void> {
  const context = github.context;
  await run({
    inputs: {
      configPath: core.getInput("config-path") || ".github/ai-provenance.yml",
      mutationReport: core.getInput("mutation-report"),
      reportPath: core.getInput("report-path") || "ai-provenance-report.json",
      uploadArtifact: core.getBooleanInput("upload-artifact"),
      prComment: core.getBooleanInput("pr-comment"),
    },
    core: {
      setOutput: (name, value) => core.setOutput(name, value),
      setFailed: (message) => core.setFailed(message),
      warning: (message) => core.warning(message),
      notice: (message) => core.notice(message),
      info: (message) => core.info(message),
      writeSummary: async (markdown) => {
        await core.summary.addRaw(markdown).write();
      },
    },
    uploadArtifact: async (name, files, rootDirectory) => {
      await new DefaultArtifactClient().uploadArtifact(name, files, rootDirectory);
    },
    client: github.getOctokit(core.getInput("github-token", { required: true })),
    context: {
      eventName: context.eventName,
      repo: context.repo,
      payload: context.payload as EventContext["payload"],
      workflow: context.workflow,
      runId: context.runId,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || 1,
    },
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    actionVersion: actionVersion(process.env.ACTION_VERSION),
    now: () => new Date(),
  });
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
