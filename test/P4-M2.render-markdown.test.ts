import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Report } from "../src/core/build-report.js";
import {
  COMMENT_MARKER,
  MAX_COMMENT_LENGTH,
  renderMarkdown,
} from "../src/core/render-markdown.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The reviewed P4-M1 snapshot is the "pass" report; the others are derived from it. */
function passReport(): Report {
  return JSON.parse(
    readFileSync(join(repoRoot, "test/__snapshots__/P4-M1.full-report.json"), "utf8"),
  ) as Report;
}

function warnReport(): Report {
  const report = passReport();
  report.gates = [
    ...report.gates,
    {
      id: "human-approval",
      type: "approvals",
      mode: "warn",
      result: "fail",
      message: "0 of 1 required approvals from someone other than the author",
    },
  ];
  report.verdict = "warn";
  return report;
}

function failReport(): Report {
  const report = passReport();
  report.gates = [
    {
      id: "mutation",
      type: "mutation-score",
      mode: "enforce",
      result: "fail",
      message: "Mutation score 62.5% is below the threshold of 80%",
      details: { score: 62.5, threshold: 80 },
    },
    ...report.gates,
  ];
  report.verdict = "fail";
  return report;
}

function noAiReport(): Report {
  const report = passReport();
  report.commits = report.commits.map((c) => ({ ...c, aiTagged: false, reasons: [] }));
  report.aiChanges = [];
  report.gates = [];
  report.verdict = "pass";
  report.verdictReason = "no-ai-changes";
  report.limitations = report.limitations.filter((l) => l.code === "declarations-only");
  return report;
}

const ALL = {
  pass: passReport,
  warn: warnReport,
  fail: failReport,
  "no-ai": noAiReport,
};

/** Each Markdown table as rows of cells, split on raw pipes (escaped pipes are entities). */
function tables(markdown: string): string[][][] {
  const found: string[][][] = [];
  let current: string[][] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("|")) {
      current.push(line.split("|").slice(1, -1));
    } else if (current.length > 0) {
      found.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    found.push(current);
  }
  return found;
}

describe("P4-M2 Markdown rendering and escaping", () => {
  it("P4-M2-01: the verdict line uses ✅ / ⚠️ / ❌ and plain text, not colour only", () => {
    const first = (report: Report) =>
      renderMarkdown(report, { variant: "summary" }).split("\n")[0]!;

    expect(first(passReport())).toMatch(/^✅ .*\bPass\b/);
    expect(first(warnReport())).toMatch(/^⚠️ .*\bWarn\b/);
    expect(first(failReport())).toMatch(/^❌ .*\bFail\b/);
  });

  it("P4-M2-02: hostile trailer values are escaped: no HTML, no broken table, no @mention", () => {
    const report = passReport();
    const hostile = "Evil <script>alert(1)</script> | `code` @octocat #12";
    report.commits[0]!.reasons = [{ rule: "trailer:Co-authored-by", matched: hostile }];
    report.commits[0]!.subject = "Fix | split `cells` for @maintainers and #34";

    const md = renderMarkdown(report, { variant: "comment" });

    expect(md).not.toContain("<script>");
    expect(md).not.toMatch(/@[A-Za-z0-9]/);
    expect(md).not.toMatch(/(?<!&)#\d/); // an issue reference; `&#42;` entities are fine
    expect(md).not.toContain("`code`");
    expect(tables(md).length).toBeGreaterThanOrEqual(2); // gates + commits
    for (const table of tables(md)) {
      const width = table[0]!.length;
      for (const row of table) {
        expect(row, `row has ${row.length} cells, header has ${width}`).toHaveLength(
          width,
        );
      }
    }
  });

  it("P4-M2-03: a file path with Markdown characters renders literally", () => {
    const report = passReport();
    report.aiChanges = [
      { path: "src/**/[id]_page*.ts", status: "added", lines: [{ start: 1, end: 3 }] },
    ];

    const md = renderMarkdown(report, { variant: "summary" });

    expect(md).not.toContain("src/**/[id]_page*.ts");
    expect(md).toContain("src/&#42;&#42;/&#91;id&#93;&#95;page&#42;.ts");
  });

  it("P4-M2-04: long lists are capped at 50 with '…and N more, see the JSON report'", () => {
    const report = passReport();
    report.aiChanges = Array.from({ length: 120 }, (_, i) => ({
      path: `src/file-${String(i).padStart(3, "0")}.ts`,
      status: "modified" as const,
      lines: [{ start: 1, end: 2 }],
    }));

    const md = renderMarkdown(report, { variant: "summary" });

    expect(md).toContain("src/file-049.ts");
    expect(md).not.toContain("src/file-050.ts");
    expect(md).toContain("…and 70 more, see the JSON report");
  });

  it("P4-M2-05: comment output starts with the hidden marker", () => {
    const md = renderMarkdown(passReport(), { variant: "comment" });

    expect(COMMENT_MARKER).toBe("<!-- ai-provenance-action -->");
    expect(md.startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
    expect(renderMarkdown(passReport(), { variant: "summary" })).not.toContain(
      COMMENT_MARKER,
    );
  });

  it("P4-M2-06: comment output stays under GitHub's 65 536-character limit for 3000 files", () => {
    const report = passReport();
    const longDir = "deeply/nested/[module]_name/".repeat(40);
    report.aiChanges = Array.from({ length: 3000 }, (_, i) => ({
      path: `${longDir}file_${i}.ts`,
      status: "added" as const,
      lines: [{ start: 1, end: 400 }],
    }));

    const md = renderMarkdown(report, { variant: "comment" });

    expect(MAX_COMMENT_LENGTH).toBe(65_536);
    expect(md.length).toBeLessThan(MAX_COMMENT_LENGTH);
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("see the JSON report");
  });

  it("P4-M2-07: the no-AI case renders a single line", () => {
    const summary = renderMarkdown(noAiReport(), { variant: "summary" });
    const comment = renderMarkdown(noAiReport(), { variant: "comment" });

    expect(summary.trimEnd().split("\n")).toHaveLength(1);
    expect(summary).toMatch(/^✅ .*no AI-assisted commits/);
    expect(comment).toBe(`${COMMENT_MARKER}\n${summary}`);
  });

  it.each(Object.keys(ALL))("P4-M2-08: snapshot of the %s comment", async (name) => {
    const report = ALL[name as keyof typeof ALL]();
    await expect(renderMarkdown(report, { variant: "comment" })).toMatchFileSnapshot(
      `./__snapshots__/P4-M2.${name}.md`,
    );
  });

  it("P4-M2-10: truncated input says the gates were not run and shows the truncation warning", () => {
    const report = failReport();
    report.verdictReason = "truncated";
    report.limitations.splice(1, 0, {
      code: "truncated-commits",
      message: "Not every commit in the pull request could be read.",
    });

    const md = renderMarkdown(report, { variant: "summary" });

    expect(md.split("\n")[0]).toMatch(/^❌ .*could not be read completely.*not run/);
    expect(md).toContain("> ⚠️ Not every commit in the pull request could be read.");
  });

  it("P4-M2-11: with no gates configured the verdict line says it is a report only", () => {
    const report = passReport();
    report.gates = [];
    report.verdictReason = "report-only";

    const first = renderMarkdown(report, { variant: "summary" }).split("\n")[0]!;

    expect(first).toMatch(
      /^✅ .*No policy gates are configured, so this is a report only\.$/,
    );
  });

  it("P4-M2-12: a removed file is listed with 'no added lines', a single line without a range", () => {
    const report = passReport();
    report.aiChanges = [
      { path: "old.ts", status: "removed", lines: [] },
      { path: "one.ts", status: "modified", lines: [{ start: 7, end: 7 }] },
    ];

    const md = renderMarkdown(report, { variant: "summary" });

    expect(md).toContain("- old.ts: removed, no added lines");
    expect(md).toContain("- one.ts: modified, lines 7\n");
  });

  it("P4-M2-09: rendered output never claims compliance, certification or AI detection", () => {
    const banned = /\bcomplian(t|ce)\b|\bcertif(y|ied|ies|ication)\b|\bdetects? AI\b/i;
    for (const make of Object.values(ALL)) {
      for (const variant of ["summary", "comment"] as const) {
        expect(renderMarkdown(make(), { variant })).not.toMatch(banned);
      }
    }
  });
});
