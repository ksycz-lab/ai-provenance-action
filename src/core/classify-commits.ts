import { parseTrailers } from "./parse-trailers.js";

export type CommitInput = {
  sha: string;
  message: string;
};

export type TrailerRule = {
  key: string;
  /** Regex tested against the trailer value only, case-insensitive. */
  value?: string;
};

export type DetectionRules = {
  trailers: TrailerRule[];
  labels: string[];
};

export type MatchReason = {
  rule: string;
  matched: string;
};

export type ClassifiedCommit = {
  sha: string;
  aiTagged: boolean;
  reasons: MatchReason[];
};

export type Classification = {
  commits: ClassifiedCommit[];
};

/** Built-in rules until P2-M1 loads `.github/ai-provenance.yml`. */
export const DEFAULT_DETECTION_RULES: DetectionRules = {
  trailers: [
    {
      key: "Co-authored-by",
      value: String.raw`\b(claude|copilot|cursor|codex|gemini|devin)\b`,
    },
    { key: "Assisted-by" },
    { key: "Generated-by" },
  ],
  labels: ["ai-assisted"],
};

function keysMatch(actual: string, configured: string): boolean {
  return actual.toLowerCase() === configured.toLowerCase();
}

function formatTrailer(key: string, value: string): string {
  return value.length > 0 ? `${key}: ${value}` : `${key}:`;
}

function matchTrailerRule(
  key: string,
  value: string,
  rule: TrailerRule,
): MatchReason | undefined {
  if (!keysMatch(key, rule.key)) {
    return undefined;
  }
  if (rule.value !== undefined) {
    const pattern = new RegExp(rule.value, "i");
    if (!pattern.test(value)) {
      return undefined;
    }
  }
  return {
    rule: `trailer:${rule.key}`,
    matched: formatTrailer(key, value),
  };
}

function matchLabelReasons(prLabels: string[], configured: string[]): MatchReason[] {
  const reasons: MatchReason[] = [];
  for (const wanted of configured) {
    const hit = prLabels.find((label) => keysMatch(label, wanted));
    if (hit !== undefined) {
      reasons.push({ rule: `label:${wanted}`, matched: hit });
    }
  }
  return reasons;
}

export function classifyCommits(
  commits: CommitInput[],
  labels: string[],
  rules: DetectionRules,
): Classification {
  const labelReasons = matchLabelReasons(labels, rules.labels);

  const classified = commits.map((commit) => {
    const reasons: MatchReason[] = [];
    for (const trailer of parseTrailers(commit.message)) {
      for (const rule of rules.trailers) {
        const reason = matchTrailerRule(trailer.key, trailer.value, rule);
        if (reason) {
          reasons.push(reason);
        }
      }
    }
    reasons.push(...labelReasons);
    return {
      sha: commit.sha,
      aiTagged: reasons.length > 0,
      reasons,
    };
  });

  return { commits: classified };
}
