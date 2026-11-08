import type { Report, ReportCommit } from "./build-report.js";
import type { EvaluatedGate, PolicyVerdict } from "./evaluate-policy.js";
import type { FileChange } from "./map-changes.js";

export const COMMENT_MARKER = "<!-- ai-provenance-action -->";

/** GitHub rejects issue and PR comments longer than this many characters. */
export const MAX_COMMENT_LENGTH = 65_536;

/** Leave headroom under GitHub's limit for anything the adapter appends. */
const LENGTH_BUDGET = 60_000;
const DEFAULT_LIST_CAP = 50;

export type RenderOptions = { variant: "summary" | "comment" };

const WORD_JOINER = "⁠";

/** Markdown and HTML specials become entities, so they render as the literal character. */
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "|": "&#124;",
  "`": "&#96;",
  "*": "&#42;",
  _: "&#95;",
  "[": "&#91;",
  "]": "&#93;",
  "(": "&#40;",
  ")": "&#41;",
  "~": "&#126;",
  "\\": "&#92;",
  "!": "&#33;",
  ":": "&#58;",
};

/**
 * Makes untrusted text (commit subjects, trailer values, paths, logins) safe inside a
 * table cell or list item: one line, no HTML, no Markdown syntax. `@` and `#` get an
 * invisible word joiner, because GitHub links mentions and issue numbers after it
 * decodes entities, so an entity alone would still ping people.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[@#]/g, (c) => `${c}${WORD_JOINER}`) // before entities: they contain `#`
    .replace(/[&<>"|`*_[\]()~\\!:]/g, (c) => ENTITIES[c]!);
}

const VERDICT_ICON: Record<PolicyVerdict, string> = {
  pass: "✅",
  warn: "⚠️",
  fail: "❌",
};
const VERDICT_WORD: Record<PolicyVerdict, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
};

const RESULT_LABEL: Record<EvaluatedGate["result"], string> = {
  pass: "✅ pass",
  fail: "❌ fail",
  skipped: "⏭️ skipped",
  error: "⚠️ error",
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function verdictLine(report: Report): string {
  const head = `${VERDICT_ICON[report.verdict]} **AI provenance: ${VERDICT_WORD[report.verdict]}**`;
  if (report.verdictReason === "no-ai-changes") {
    return `${head}: no AI-assisted commits were declared in this pull request.`;
  }
  const tagged = report.commits.filter((c) => c.aiTagged).length;
  const facts = `${tagged} of ${plural(report.commits.length, "commit")} declared AI-assisted, ${plural(report.aiChanges.length, "file")} touched`;
  if (report.verdictReason === "truncated") {
    return `${head}: the pull request could not be read completely, so the gates were not run (${facts}).`;
  }
  if (report.verdictReason === "report-only") {
    return `${head}: ${facts}. No policy gates are configured, so this is a report only.`;
  }
  return `${head}: ${facts}.`;
}

function gatesTable(gates: EvaluatedGate[]): string[] {
  if (gates.length === 0) {
    return [];
  }
  return [
    "| Gate | Type | Mode | Result | Details |",
    "| --- | --- | --- | --- | --- |",
    ...gates.map(
      (g) =>
        `| ${escapeMarkdown(g.id)} | ${escapeMarkdown(g.type)} | ${g.mode} | ${RESULT_LABEL[g.result]} | ${escapeMarkdown(g.message)} |`,
    ),
    "",
  ];
}

function moreLine(total: number, shown: number): string[] {
  return total > shown ? [`…and ${total - shown} more, see the JSON report.`, ""] : [];
}

function commitsSection(commits: ReportCommit[], cap: number): string[] {
  const tagged = commits.filter((c) => c.aiTagged);
  if (tagged.length === 0) {
    return [];
  }
  const shown = tagged.slice(0, cap);
  return [
    `<details><summary>AI-tagged commits (${tagged.length})</summary>`,
    "",
    "| Commit | Subject | Declared by |",
    "| --- | --- | --- |",
    ...shown.map(
      (c) =>
        `| ${escapeMarkdown(c.sha.slice(0, 7))} | ${escapeMarkdown(c.subject)} | ${c.reasons.map((r) => escapeMarkdown(r.matched)).join("<br>")} |`,
    ),
    "",
    ...moreLine(tagged.length, shown.length),
    "</details>",
    "",
  ];
}

function linesText(change: FileChange): string {
  if (change.lines === "unknown") {
    return "lines unknown";
  }
  if (change.lines.length === 0) {
    return "no added lines";
  }
  return `lines ${change.lines.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(", ")}`;
}

function filesSection(changes: FileChange[], cap: number): string[] {
  if (changes.length === 0) {
    return [];
  }
  const shown = changes.slice(0, cap);
  return [
    `<details><summary>Files touched by AI-tagged commits (${changes.length})</summary>`,
    "",
    ...shown.map((c) => {
      const renamed =
        c.previousFilename !== undefined
          ? ` (renamed from ${escapeMarkdown(c.previousFilename)})`
          : "";
      return `- ${escapeMarkdown(c.path)}${renamed}: ${c.status}, ${linesText(c)}`;
    }),
    "",
    ...moreLine(changes.length, shown.length),
    "</details>",
    "",
  ];
}

function configNote(report: Report): string[] {
  return report.config.changedInPr
    ? [
        `> ℹ️ This pull request changes the config file ${escapeMarkdown(report.config.path)}. It was judged by the version on the base branch.`,
        "",
      ]
    : [];
}

function limitationsSection(report: Report): string[] {
  const notable = report.limitations.filter(
    (l) => l.code === "truncated-commits" || l.code === "truncated-files",
  );
  return notable.length === 0
    ? []
    : [...notable.map((l) => `> ⚠️ ${escapeMarkdown(l.message)}`), ""];
}

const FOOTER =
  "_Produces evidence that supports an audit. AI assistance is self-declared through commit trailers and PR labels; the JSON report lists all limitations._";

function renderBody(report: Report, cap: number): string {
  if (report.verdictReason === "no-ai-changes") {
    return `${verdictLine(report)}\n`;
  }
  const lines = [
    verdictLine(report),
    "",
    ...configNote(report),
    ...limitationsSection(report),
    ...gatesTable(report.gates),
    ...(cap > 0 ? commitsSection(report.commits, cap) : []),
    ...(cap > 0 ? filesSection(report.aiChanges, cap) : []),
    ...(cap > 0
      ? []
      : [
          "The commit and file lists are too long to show here, see the JSON report.",
          "",
        ]),
    FOOTER,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Renders the job summary or the sticky PR comment from the report alone, never from
 * raw API data. Lists are capped at 50 entries; if the result is still too long for a
 * comment (very long paths), the cap shrinks until it fits, down to no lists at all.
 */
export function renderMarkdown(report: Report, options: RenderOptions): string {
  const prefix = options.variant === "comment" ? `${COMMENT_MARKER}\n` : "";
  let cap = DEFAULT_LIST_CAP;
  let markdown = prefix + renderBody(report, cap);
  while (markdown.length > LENGTH_BUDGET && cap > 0) {
    cap = Math.floor(cap / 2);
    markdown = prefix + renderBody(report, cap);
  }
  return markdown;
}
