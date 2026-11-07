import type { GateConfig } from "./load-config.js";
import type {
  Gate,
  GateEvaluation,
  PolicyContext,
  ReviewInput,
} from "./evaluate-policy.js";

function keysMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const DECISIVE = new Set(["APPROVED", "CHANGES_REQUESTED"]);

function latestDecisiveByReviewer(
  reviews: ReviewInput[],
): Map<string, "APPROVED" | "CHANGES_REQUESTED"> {
  const sorted = [...reviews].sort((a, b) => {
    const byTime = a.submittedAt.localeCompare(b.submittedAt);
    return byTime !== 0 ? byTime : 0;
  });
  const latest = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  for (const review of sorted) {
    const login = review.user?.login;
    if (!login) {
      continue;
    }
    if ((review.user?.type ?? "").toLowerCase() === "bot") {
      continue;
    }
    const state = review.state.toUpperCase();
    if (state === "DISMISSED" || state === "COMMENTED" || state === "PENDING") {
      continue;
    }
    if (DECISIVE.has(state)) {
      latest.set(login.toLowerCase(), state as "APPROVED" | "CHANGES_REQUESTED");
    }
  }
  return latest;
}

export const requiredLabelGate: Gate = {
  type: "required-label",
  evaluate(ctx: PolicyContext, gate: GateConfig): GateEvaluation {
    const wanted = gate.label;
    if (!wanted) {
      throw new Error("required-label gate is missing label");
    }
    const labels = ctx.prLabels ?? [];
    const hit = labels.find((label) => keysMatch(label, wanted));
    if (hit) {
      return {
        result: "pass",
        message: `label '${hit}' is present`,
        details: { label: wanted, matched: hit },
      };
    }
    return {
      result: "fail",
      message: `required label '${wanted}' is not present`,
      details: { label: wanted, matched: null },
    };
  },
};

export const approvalsGate: Gate = {
  type: "approvals",
  evaluate(ctx: PolicyContext, gate: GateConfig): GateEvaluation {
    const min = gate.min ?? 1;
    const author = (ctx.prAuthorLogin ?? "").toLowerCase();
    const latest = latestDecisiveByReviewer(ctx.reviews ?? []);
    const approvers = [...latest.entries()]
      .filter(([, state]) => state === "APPROVED")
      .map(([login]) => login)
      .filter((login) => login !== author);
    const details = { min, approvers, author: ctx.prAuthorLogin ?? "" };
    if (approvers.length >= min) {
      return {
        result: "pass",
        message: `${approvers.length} non-author approval(s) (min ${min})`,
        details,
      };
    }
    return {
      result: "fail",
      message: `${approvers.length} non-author approval(s), need ${min}`,
      details,
    };
  },
};
