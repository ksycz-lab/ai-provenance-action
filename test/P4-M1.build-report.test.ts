import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  classifyCommits,
  DEFAULT_DETECTION_RULES,
} from "../src/core/classify-commits.js";
import { evaluatePolicy, type Gate } from "../src/core/evaluate-policy.js";
import { DEFAULT_CONFIG, type Config } from "../src/core/load-config.js";
import { aggregateAiChanges, mapChanges } from "../src/core/map-changes.js";
import {
  buildReport,
  REPORT_SCHEMA_VERSION,
  reportSchema,
  serializeReport,
  type ReportInput,
} from "../src/core/build-report.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (path: string): string =>
  readFileSync(join(repoRoot, "test/fixtures", path), "utf8");

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(reportSchema);

function expectValid(report: unknown): void {
  const ok = validate(report);
  expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
  expect(ok).toBe(true);
}

const CLOCK = new Date("2026-11-08T10:00:00.000Z");

const passingLabelGate: Gate = {
  type: "required-label",
  evaluate: (_ctx, gate) => ({ result: "pass", message: `${gate.id} passed` }),
};

/** A realistic input built with the real core functions and the shared fixtures. */
function fullInput(): ReportInput {
  const commits = [
    {
      sha: "a".repeat(40),
      author: "ksycz",
      message: fixture("commits/claude-code.txt"),
    },
    { sha: "b".repeat(40), author: "jana-n", message: "Fix typo in README\n" },
    { sha: "c".repeat(40), author: "ksycz", message: fixture("commits/copilot.txt") },
  ];
  const classification = classifyCommits(commits, [], DEFAULT_DETECTION_RULES);
  const files = JSON.parse(fixture("patches/commit-files.rest.json"));
  const aiChanges = aggregateAiChanges([
    mapChanges(files),
    mapChanges([{ filename: "assets/logo.png", status: "added" }]),
  ]);
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.policy.gates = [
    { id: "reviewed", type: "required-label", label: "ai-reviewed" },
  ];
  const policy = evaluatePolicy({ aiTagged: true, truncated: false }, config, [
    passingLabelGate,
  ]);

  return {
    generatedAt: CLOCK,
    action: {
      name: "ai-provenance-action",
      version: "0.1.0",
      commitSha: "d".repeat(40),
    },
    run: {
      repository: "ksycz/demo-shop",
      workflow: "ci",
      runId: 123456789,
      runAttempt: 1,
      event: "pull_request",
    },
    pullRequest: {
      number: 42,
      url: "https://github.com/ksycz/demo-shop/pull/42",
      baseSha: "e".repeat(40),
      headSha: "c".repeat(40),
      author: "ksycz",
    },
    config: {
      source: "base-branch",
      path: ".github/ai-provenance.yml",
      sha256: "f".repeat(64),
      changedInPr: false,
    },
    commits,
    classification,
    aiChanges,
    policy,
    truncated: { commits: false, files: false },
  };
}

function noAiInput(): ReportInput {
  const base = fullInput();
  const commits = [base.commits[1]!];
  return {
    ...base,
    config: {
      source: "defaults",
      path: ".github/ai-provenance.yml",
      sha256: null,
      changedInPr: false,
    },
    commits,
    classification: classifyCommits(commits, [], DEFAULT_DETECTION_RULES),
    aiChanges: [],
    policy: evaluatePolicy({ aiTagged: false, truncated: false }, DEFAULT_CONFIG, []),
  };
}

describe("P4-M1 JSON report and schema", () => {
  it("P4-M1-01: a full fixture input produces a report that validates against the schema", () => {
    const report = buildReport(fullInput());

    expectValid(report);
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.generatedAt).toBe("2026-11-08T10:00:00.000Z");
    expect(report.commits.filter((c) => c.aiTagged).map((c) => c.sha)).toEqual([
      "a".repeat(40),
      "c".repeat(40),
    ]);
    expect(report.aiChanges.map((c) => c.path)).toEqual([
      "assets/logo.png",
      "docs/README.md",
      "src/cart.ts",
    ]);
    expect(report.gates).toEqual([
      expect.objectContaining({ id: "reviewed", result: "pass", mode: "enforce" }),
    ]);
    expect(report.verdict).toBe("pass");
  });

  it("P4-M1-02: the no-AI case produces a short valid report (empty aiChanges, verdict pass)", () => {
    const report = buildReport(noAiInput());

    expectValid(report);
    expect(report.aiChanges).toEqual([]);
    expect(report.gates).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.verdictReason).toBe("no-ai-changes");
    expect(report.config).toEqual({
      source: "defaults",
      path: ".github/ai-provenance.yml",
      sha256: null,
      changedInPr: false,
    });
  });

  it("P4-M1-03: same input with an injected clock gives byte-identical output (stable key order)", () => {
    const first = serializeReport(buildReport(fullInput()));

    // Same data, but every input object built with its keys in a different order.
    const shuffled = fullInput();
    const reordered: ReportInput = {
      truncated: shuffled.truncated,
      policy: shuffled.policy,
      // Reversed order as well: the report sorts files by path itself.
      aiChanges: [...shuffled.aiChanges]
        .reverse()
        .map(({ path, status, previousFilename, lines }) => ({
          lines,
          ...(previousFilename !== undefined ? { previousFilename } : {}),
          status,
          path,
        })),
      classification: shuffled.classification,
      commits: shuffled.commits.map(({ sha, author, message }) => ({
        message,
        author,
        sha,
      })),
      config: {
        sha256: shuffled.config.sha256,
        path: shuffled.config.path,
        source: shuffled.config.source,
        changedInPr: shuffled.config.changedInPr,
      },
      pullRequest: shuffled.pullRequest,
      run: shuffled.run,
      action: shuffled.action,
      generatedAt: new Date(CLOCK.getTime()),
    };
    const second = serializeReport(buildReport(reordered));

    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(first))).toEqual([
      "schemaVersion",
      "action",
      "generatedAt",
      "run",
      "pullRequest",
      "config",
      "commits",
      "aiChanges",
      "gates",
      "verdict",
      "limitations",
    ]);
  });

  it("P4-M1-04: truncation and unknown-lines limitations are listed when present", () => {
    const report = buildReport({
      ...fullInput(),
      truncated: { commits: true, files: true },
    });

    expectValid(report);
    const codes = report.limitations.map((l) => l.code);
    expect(codes).toEqual([
      "declarations-only",
      "truncated-commits",
      "truncated-files",
      "unknown-lines",
      "lines-as-of-commit",
    ]);
    const unknown = report.limitations.find((l) => l.code === "unknown-lines");
    expect(unknown?.files).toEqual(["assets/logo.png"]);

    const quiet = buildReport(noAiInput());
    expect(quiet.limitations.map((l) => l.code)).toEqual(["declarations-only"]);
  });

  it("P4-M1-05: commits carry only SHA, subject (max 200 characters) and matched trailers", () => {
    const longSubject = "Ž".repeat(250);
    const body = "Secret internal detail that must not reach the artifact.";
    const input = fullInput();
    input.commits[0] = {
      ...input.commits[0]!,
      message: `${longSubject}\n\n${body}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`,
    };
    input.classification = classifyCommits(input.commits, [], DEFAULT_DETECTION_RULES);

    const report = buildReport(input);
    const commit = report.commits[0]!;

    expectValid(report);
    expect(Object.keys(commit)).toEqual([
      "sha",
      "author",
      "subject",
      "aiTagged",
      "reasons",
    ]);
    expect(Array.from(commit.subject)).toHaveLength(200);
    expect(commit.subject.endsWith("…")).toBe(true);
    expect(serializeReport(report)).not.toContain(body);
    expect(commit.reasons).toEqual([
      {
        rule: "trailer:Co-authored-by",
        matched: "Co-Authored-By: Claude <noreply@anthropic.com>",
      },
    ]);
  });

  it("P4-M1-06: snapshot of the full fixture report (reviewed in PR diffs)", async () => {
    await expect(serializeReport(buildReport(fullInput()))).toMatchFileSnapshot(
      "./__snapshots__/P4-M1.full-report.json",
    );
  });

  it("P4-M1-07: docs/report-format.md documents every field in the report schema", () => {
    const docs = readFileSync(join(repoRoot, "docs/report-format.md"), "utf8");
    for (const name of collectPropertyNames(reportSchema)) {
      expect(docs, `docs/report-format.md should mention '${name}'`).toContain(
        `\`${name}\``,
      );
    }
  });
});

function collectPropertyNames(node: unknown, into = new Set<string>()): string[] {
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const key of Object.keys(record.properties)) {
        into.add(key);
      }
    }
    for (const value of Object.values(record)) {
      collectPropertyNames(value, into);
    }
  }
  return [...into];
}
