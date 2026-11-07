import * as core from "@actions/core";
import { info } from "./adapters/github-context.js";
import { ACTION_NAME, actionVersion } from "./core/version.js";

async function run(): Promise<void> {
  info(
    `${ACTION_NAME} v${actionVersion(process.env.ACTION_VERSION)} (scaffold — detection core not wired yet)`,
  );

  core.setOutput("ai_tagged", "false");
  core.setOutput("ai_files", "[]");
  core.setOutput(
    "report_path",
    core.getInput("report-path") || "ai-provenance-report.json",
  );
  core.setOutput("verdict", "pass");

  await core.summary
    .addHeading("AI Provenance Audit")
    .addRaw(
      "Scaffold run: produces evidence that supports an audit once detection and policy are implemented.",
    )
    .write();
}

run().catch((error: unknown) => {
  if (error instanceof Error) {
    core.setFailed(error.message);
  } else {
    core.setFailed(String(error));
  }
});
