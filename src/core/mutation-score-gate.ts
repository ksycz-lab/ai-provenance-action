import type { GateConfig, MissingReportMode, MutationScope } from "./load-config.js";
import type { Gate, GateEvaluation, PolicyContext } from "./evaluate-policy.js";

export type MutantCounts = {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  compileError: number;
  runtimeError: number;
  ignored: number;
  other: number;
};

export type MutationScoreDetails = {
  score: number | null;
  threshold: number;
  scope: MutationScope;
  filesInScope: string[];
  counts: MutantCounts;
  detected: number;
  valid: number;
};

function emptyCounts(): MutantCounts {
  return {
    killed: 0,
    timeout: 0,
    survived: 0,
    noCoverage: 0,
    compileError: 0,
    runtimeError: 0,
    ignored: 0,
    other: 0,
  };
}

function bump(counts: MutantCounts, status: string): void {
  switch (status) {
    case "killed":
      counts.killed += 1;
      break;
    case "timeout":
      counts.timeout += 1;
      break;
    case "survived":
      counts.survived += 1;
      break;
    case "nocoverage":
      counts.noCoverage += 1;
      break;
    case "compileerror":
      counts.compileError += 1;
      break;
    case "runtimeerror":
      counts.runtimeError += 1;
      break;
    case "ignored":
      counts.ignored += 1;
      break;
    default:
      counts.other += 1;
  }
}

/** Relative, forward slashes, no leading ./ */
export function normalizeReportPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/");
}

export function pathsMatch(reportPath: string, prPath: string): boolean {
  const report = normalizeReportPath(reportPath);
  const pr = normalizeReportPath(prPath);
  return report === pr || report.endsWith(`/${pr}`) || pr.endsWith(`/${report}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFiles(report: unknown): Record<string, unknown> {
  if (!isRecord(report)) {
    throw new Error("mutation report is not an object");
  }
  if (!isRecord(report.files)) {
    throw new Error("mutation report is missing a files object (wrong schema)");
  }
  return report.files;
}

function mutantsInFile(entry: unknown): unknown[] {
  if (!isRecord(entry) || !Array.isArray(entry.mutants)) {
    return [];
  }
  return entry.mutants;
}

function mutantStatus(mutant: unknown): string {
  if (!isRecord(mutant) || typeof mutant.status !== "string") {
    return "other";
  }
  return mutant.status.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

function scoreFromCounts(counts: MutantCounts): {
  detected: number;
  valid: number;
  score: number | null;
} {
  const detected = counts.killed + counts.timeout;
  const excluded = counts.compileError + counts.runtimeError + counts.ignored;
  const total =
    counts.killed +
    counts.timeout +
    counts.survived +
    counts.noCoverage +
    counts.compileError +
    counts.runtimeError +
    counts.ignored +
    counts.other;
  const valid = total - excluded;
  return {
    detected,
    valid,
    score: valid === 0 ? null : (detected / valid) * 100,
  };
}

function withDetails(
  result: GateEvaluation["result"],
  message: string,
  details: MutationScoreDetails,
): GateEvaluation {
  return { result, message, details };
}

export const mutationScoreGate: Gate = {
  type: "mutation-score",
  evaluate(ctx: PolicyContext, gate: GateConfig): GateEvaluation {
    const threshold = gate.threshold ?? 80;
    const scope: MutationScope = gate.scope ?? "ai-files";
    const onMissing: MissingReportMode = gate.onMissing ?? "fail";
    const input = ctx.mutationReport ?? { kind: "missing" };

    if (input.kind === "missing") {
      const message = "mutation report is missing";
      if (onMissing === "skip") {
        return { result: "skipped", message };
      }
      return { result: "fail", message };
    }
    if (input.kind === "invalid") {
      throw new Error(`malformed mutation report: ${input.message}`);
    }

    const files = parseFiles(input.value);

    const aiFiles = ctx.aiFiles ?? [];
    const filesInScope: string[] = [];
    const counts = emptyCounts();

    for (const [rawPath, entry] of Object.entries(files)) {
      const normalized = normalizeReportPath(rawPath);
      const inScope = scope === "all" || aiFiles.some((ai) => pathsMatch(rawPath, ai));
      if (!inScope) {
        continue;
      }
      filesInScope.push(normalized);
      for (const mutant of mutantsInFile(entry)) {
        bump(counts, mutantStatus(mutant));
      }
    }

    const { detected, valid, score } = scoreFromCounts(counts);
    const details: MutationScoreDetails = {
      score,
      threshold,
      scope,
      filesInScope: [...filesInScope].sort(),
      counts,
      detected,
      valid,
    };

    if (valid === 0) {
      return withDetails("skipped", "no mutants in scope", details);
    }

    if (score !== null && score >= threshold) {
      return withDetails(
        "pass",
        `mutation score ${score.toFixed(2)} >= ${threshold}`,
        details,
      );
    }
    return withDetails(
      "fail",
      `mutation score ${score?.toFixed(2)} < ${threshold}`,
      details,
    );
  },
};
