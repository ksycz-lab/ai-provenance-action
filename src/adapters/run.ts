import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { buildReport, serializeReport, type Report } from "../core/build-report.js";
import { evaluatePolicy, type MutationReportInput } from "../core/evaluate-policy.js";
import { approvalsGate, requiredLabelGate } from "../core/label-approval-gates.js";
import { aggregateAiChanges, mapChanges } from "../core/map-changes.js";
import { mutationScoreGate } from "../core/mutation-score-gate.js";
import { escapeMarkdown, renderMarkdown } from "../core/render-markdown.js";
import { ACTION_NAME } from "../core/version.js";
import {
  fetchPullRequest,
  gatherPullRequestData,
  pullRequestRef,
  type EventContext,
  type GitHubClient,
} from "./fetch-pull-request.js";
import { loadBaseConfig } from "./load-base-config.js";

export type ActionInputs = {
  configPath: string;
  mutationReport: string;
  reportPath: string;
  uploadArtifact: boolean;
};

export type ActionDeps = {
  inputs: ActionInputs;
  core: {
    setOutput: (name: string, value: string) => void;
    setFailed: (message: string) => void;
    warning: (message: string) => void;
    info: (message: string) => void;
    writeSummary: (markdown: string) => Promise<void>;
  };
  uploadArtifact: (
    name: string,
    files: string[],
    rootDirectory: string,
  ) => Promise<void>;
  client: GitHubClient;
  context: EventContext & { workflow: string; runId: number; runAttempt: number };
  workspace: string;
  actionVersion: string;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

const GATES = [mutationScoreGate, requiredLabelGate, approvalsGate];

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolves a user-supplied path against the workspace and refuses anything that ends
 * up outside it, including through `..`, an absolute path or a symlink.
 */
async function workspacePath(
  workspace: string,
  input: string,
  name: string,
  mustExist: boolean,
): Promise<string | undefined> {
  const root = await realpath(workspace);
  const target = resolve(root, input);
  const refuse = () =>
    new Error(`${name} must be a file inside the workspace (got '${input}')`);
  if (!isInside(root, target)) {
    throw refuse();
  }
  try {
    const real = await realpath(target);
    if (!isInside(root, real)) {
      throw refuse();
    }
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !mustExist) {
      return target;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readMutationReport(
  workspace: string,
  input: string,
): Promise<MutationReportInput> {
  if (input.trim() === "") {
    return { kind: "missing" };
  }
  const path = await workspacePath(workspace, input, "mutation-report", true);
  if (path === undefined) {
    return { kind: "missing" };
  }
  try {
    return {
      kind: "present",
      value: JSON.parse(await readFile(path, "utf8")) as unknown,
    };
  } catch (error) {
    return {
      kind: "invalid",
      message: `could not parse ${input}: ${(error as Error).message}`,
    };
  }
}

async function produceReport(deps: ActionDeps): Promise<Report> {
  const { client, context, inputs, workspace, sleep } = deps;
  const ref = pullRequestRef(context);
  const mutationReport = await readMutationReport(workspace, inputs.mutationReport);

  const summary = await fetchPullRequest(client, ref, { sleep });
  const base = await loadBaseConfig(
    client,
    context.repo,
    { baseSha: summary.pullRequest.baseSha, headSha: summary.pullRequest.headSha },
    inputs.configPath,
    { sleep },
  );
  const data = await gatherPullRequestData(client, ref, base.config, {
    sleep,
    prefetched: summary,
  });

  const aiChanges = aggregateAiChanges(data.commitFiles.map(mapChanges));
  const aiTagged = data.classification.commits.some((c) => c.aiTagged);
  const policy = evaluatePolicy(
    {
      aiTagged,
      truncated: data.truncated.commits || data.truncated.files,
      prLabels: data.labels,
      prAuthorLogin: data.pullRequest.author ?? undefined,
      reviews: data.reviews,
      aiFiles: aiChanges.map((c) => c.path),
      mutationReport,
    },
    base.config,
    GATES,
  );

  return buildReport({
    generatedAt: deps.now(),
    action: { name: ACTION_NAME, version: deps.actionVersion, commitSha: null },
    run: {
      repository: `${context.repo.owner}/${context.repo.repo}`,
      workflow: context.workflow,
      runId: context.runId,
      runAttempt: context.runAttempt,
      event: context.eventName,
    },
    pullRequest: {
      number: data.pullRequest.number,
      url: data.pullRequest.url,
      baseSha: data.pullRequest.baseSha,
      headSha: data.pullRequest.headSha,
      author: data.pullRequest.author,
    },
    config: {
      source: base.source,
      path: base.path,
      sha256: base.sha256,
      changedInPr: base.changedInPr,
    },
    commits: data.commits,
    classification: data.classification,
    aiChanges,
    policy,
    truncated: data.truncated,
  });
}

/**
 * The whole Action: read the PR and the base-branch policy, build the report, then
 * publish it as outputs, a job summary, a file and an artifact, and set the job
 * status from the verdict. The summary is written in every outcome, errors included.
 */
export async function run(deps: ActionDeps): Promise<void> {
  const { core, inputs, workspace } = deps;
  let report: Report;
  try {
    report = await produceReport(deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await core.writeSummary(
      `❌ **AI provenance: error**: ${escapeMarkdown(message)}\n`,
    );
    core.setFailed(message);
    return;
  }

  try {
    const reportFile = await workspacePath(
      workspace,
      inputs.reportPath,
      "report-path",
      false,
    );
    await mkdir(dirname(reportFile!), { recursive: true });
    await writeFile(reportFile!, serializeReport(report));

    core.setOutput("ai_tagged", String(report.commits.some((c) => c.aiTagged)));
    core.setOutput("ai_files", JSON.stringify(report.aiChanges.map((c) => c.path)));
    core.setOutput("report_path", inputs.reportPath);
    core.setOutput("verdict", report.verdict);

    await core.writeSummary(renderMarkdown(report, { variant: "summary" }));

    if (inputs.uploadArtifact) {
      const name = `ai-provenance-${report.pullRequest.number}-${report.run.runAttempt}`;
      await deps.uploadArtifact(name, [reportFile!], await realpath(workspace));
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
    return;
  }

  if (report.verdict === "fail") {
    core.setFailed(
      "AI provenance verdict: fail. See the job summary for the gates that failed.",
    );
  } else if (report.verdict === "warn") {
    core.warning(
      "AI provenance verdict: warn. See the job summary for the gates that did not pass.",
    );
  }
}
