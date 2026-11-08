import type { Classification } from "./classify-commits.js";
import type { EvaluatedGate, PolicyResult, PolicyVerdict } from "./evaluate-policy.js";
import type { FileChange } from "./map-changes.js";
import reportSchema from "../../schema/report.v1.schema.json" with { type: "json" };

export { reportSchema };

export const REPORT_SCHEMA_VERSION = "1.0.0";

export type ReportInput = {
  generatedAt: Date;
  action: { name: string; version: string; commitSha: string | null };
  run: {
    repository: string;
    workflow: string;
    runId: number;
    runAttempt: number;
    event: string;
  };
  pullRequest: {
    number: number;
    url: string;
    baseSha: string;
    headSha: string;
    author: string | null;
  };
  config: { source: "base-branch" | "defaults"; path: string; sha256: string | null };
  commits: { sha: string; author: string | null; message: string }[];
  classification: Classification;
  aiChanges: FileChange[];
  policy: PolicyResult;
  truncated: { commits: boolean; files: boolean };
};

export type ReportCommit = {
  sha: string;
  author: string | null;
  subject: string;
  aiTagged: boolean;
  reasons: { rule: string; matched: string }[];
};

export type ReportLimitation = { code: string; message: string; files?: string[] };

export type Report = {
  schemaVersion: string;
  action: ReportInput["action"];
  generatedAt: string;
  run: ReportInput["run"];
  pullRequest: ReportInput["pullRequest"];
  config: ReportInput["config"];
  commits: ReportCommit[];
  aiChanges: FileChange[];
  gates: EvaluatedGate[];
  verdict: PolicyVerdict;
  verdictReason?: PolicyResult["reason"];
  limitations: ReportLimitation[];
};

const MAX_SUBJECT_LENGTH = 200;

const LIMITATION_MESSAGES = {
  "declarations-only":
    "AI assistance is recorded from self-declared commit trailers and pull request labels. A commit without them is not evidence of human authorship.",
  "truncated-commits":
    "Not every commit in the pull request could be read, so some AI-tagged commits may be missing from this report.",
  "truncated-files":
    "Not every changed file could be read, so some AI-touched files may be missing from this report.",
  "unknown-lines":
    "No diff was available for these files (binary or too large), so their changed lines are unknown.",
  "lines-as-of-commit":
    "Line ranges are the lines added by each AI-tagged commit at that commit. Later commits in the pull request may have moved or changed them.",
} as const;

type LimitationCode = keyof typeof LIMITATION_MESSAGES;

/** First line of the message, cut to 200 code points so long or multi-byte subjects stay bounded. */
function subjectOf(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const chars = Array.from(firstLine);
  if (chars.length <= MAX_SUBJECT_LENGTH) {
    return firstLine;
  }
  return `${chars.slice(0, MAX_SUBJECT_LENGTH - 1).join("")}…`;
}

function limitation(code: LimitationCode, files?: string[]): ReportLimitation {
  return files === undefined
    ? { code, message: LIMITATION_MESSAGES[code] }
    : { code, message: LIMITATION_MESSAGES[code], files };
}

function buildCommits(input: ReportInput): ReportCommit[] {
  const bySha = new Map(input.classification.commits.map((c) => [c.sha, c]));
  return input.commits.map((commit) => {
    const classified = bySha.get(commit.sha);
    return {
      sha: commit.sha,
      author: commit.author,
      subject: subjectOf(commit.message),
      aiTagged: classified?.aiTagged ?? false,
      reasons: (classified?.reasons ?? []).map(({ rule, matched }) => ({
        rule,
        matched,
      })),
    };
  });
}

function buildAiChanges(changes: FileChange[]): FileChange[] {
  return [...changes]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((change) => ({
      path: change.path,
      status: change.status,
      ...(change.previousFilename !== undefined
        ? { previousFilename: change.previousFilename }
        : {}),
      lines:
        change.lines === "unknown"
          ? "unknown"
          : change.lines.map(({ start, end }) => ({ start, end })),
    }));
}

function buildGates(gates: EvaluatedGate[]): EvaluatedGate[] {
  return gates.map((gate) => ({
    id: gate.id,
    type: gate.type,
    mode: gate.mode,
    result: gate.result,
    message: gate.message,
    ...(gate.details !== undefined ? { details: gate.details } : {}),
  }));
}

function buildLimitations(
  input: ReportInput,
  aiChanges: FileChange[],
): ReportLimitation[] {
  const limitations = [limitation("declarations-only")];
  if (input.truncated.commits) {
    limitations.push(limitation("truncated-commits"));
  }
  if (input.truncated.files) {
    limitations.push(limitation("truncated-files"));
  }
  const unknownFiles = aiChanges
    .filter((c) => c.lines === "unknown")
    .map((c) => c.path);
  if (unknownFiles.length > 0) {
    limitations.push(limitation("unknown-lines", unknownFiles));
  }
  if (aiChanges.some((c) => c.lines !== "unknown" && c.lines.length > 0)) {
    limitations.push(limitation("lines-as-of-commit"));
  }
  return limitations;
}

/**
 * Builds the versioned audit report. Pure: the clock and the config hash come in
 * through `input`, and every object is rebuilt with a fixed key order so the same
 * input always serialises to the same bytes.
 */
export function buildReport(input: ReportInput): Report {
  const aiChanges = buildAiChanges(input.aiChanges);
  const { action, run, pullRequest, config } = input;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    action: { name: action.name, version: action.version, commitSha: action.commitSha },
    generatedAt: input.generatedAt.toISOString(),
    run: {
      repository: run.repository,
      workflow: run.workflow,
      runId: run.runId,
      runAttempt: run.runAttempt,
      event: run.event,
    },
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      author: pullRequest.author,
    },
    config: { source: config.source, path: config.path, sha256: config.sha256 },
    commits: buildCommits(input),
    aiChanges,
    gates: buildGates(input.policy.gates),
    verdict: input.policy.verdict,
    ...(input.policy.reason !== undefined
      ? { verdictReason: input.policy.reason }
      : {}),
    limitations: buildLimitations(input, aiChanges),
  };
}

/** Pretty-printed JSON with a trailing newline, as written to the artifact. */
export function serializeReport(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
