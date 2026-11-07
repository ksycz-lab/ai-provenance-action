import { describe, expect, it } from "vitest";
import { approvalsGate, requiredLabelGate } from "../src/core/label-approval-gates.js";
import { DEFAULT_CONFIG } from "../src/core/load-config.js";
import type { PolicyContext, ReviewInput } from "../src/core/evaluate-policy.js";

function ctx(partial: Partial<PolicyContext>): PolicyContext {
  return { aiTagged: true, truncated: false, ...partial };
}

function review(
  login: string,
  state: string,
  extra?: Partial<ReviewInput> & { type?: string },
): ReviewInput {
  return {
    state,
    submittedAt: extra?.submittedAt ?? "2026-11-07T10:00:00Z",
    user: { login, type: extra?.type ?? "User" },
  };
}

describe("P3-M3 required-label and approvals gates", () => {
  it("P3-M3-01: label present passes; absent fails; matching is case-insensitive", () => {
    const gate = {
      id: "reviewed",
      type: "required-label" as const,
      label: "ai-reviewed",
    };
    expect(
      requiredLabelGate.evaluate(
        ctx({ prLabels: ["bug", "AI-Reviewed"] }),
        gate,
        DEFAULT_CONFIG,
      ).result,
    ).toBe("pass");
    expect(
      requiredLabelGate.evaluate(ctx({ prLabels: ["bug"] }), gate, DEFAULT_CONFIG)
        .result,
    ).toBe("fail");
  });

  it("P3-M3-02: one approval from a non-author with min 1 passes", () => {
    const gate = { id: "human-approval", type: "approvals" as const, min: 1 };
    expect(
      approvalsGate.evaluate(
        ctx({
          prAuthorLogin: "author",
          reviews: [review("reviewer", "APPROVED")],
        }),
        gate,
        DEFAULT_CONFIG,
      ).result,
    ).toBe("pass");
  });

  it("P3-M3-03: an approval from the PR author does not count", () => {
    const gate = { id: "human-approval", type: "approvals" as const, min: 1 };
    expect(
      approvalsGate.evaluate(
        ctx({
          prAuthorLogin: "Author",
          reviews: [review("author", "APPROVED")],
        }),
        gate,
        DEFAULT_CONFIG,
      ).result,
    ).toBe("fail");
  });

  it("P3-M3-04: a reviewer who approved and later requested changes counts as not approved", () => {
    const gate = { id: "human-approval", type: "approvals" as const, min: 1 };
    expect(
      approvalsGate.evaluate(
        ctx({
          prAuthorLogin: "author",
          reviews: [
            review("reviewer", "APPROVED", { submittedAt: "2026-11-07T10:00:00Z" }),
            review("reviewer", "CHANGES_REQUESTED", {
              submittedAt: "2026-11-07T11:00:00Z",
            }),
          ],
        }),
        gate,
        DEFAULT_CONFIG,
      ).result,
    ).toBe("fail");
  });

  it("P3-M3-05: COMMENTED reviews do not change a reviewer's latest decisive state", () => {
    const gate = { id: "human-approval", type: "approvals" as const, min: 1 };
    expect(
      approvalsGate.evaluate(
        ctx({
          prAuthorLogin: "author",
          reviews: [
            review("reviewer", "APPROVED", { submittedAt: "2026-11-07T10:00:00Z" }),
            review("reviewer", "COMMENTED", { submittedAt: "2026-11-07T12:00:00Z" }),
          ],
        }),
        gate,
        DEFAULT_CONFIG,
      ).result,
    ).toBe("pass");
  });

  it("P3-M3-06: dismissed reviews do not count", () => {
    const gate = { id: "human-approval", type: "approvals" as const, min: 1 };
    expect(
      approvalsGate.evaluate(
        ctx({
          prAuthorLogin: "author",
          reviews: [review("reviewer", "DISMISSED")],
        }),
        gate,
        DEFAULT_CONFIG,
      ).result,
    ).toBe("fail");
  });

  it("P3-M3-07: bot reviewers do not count", () => {
    const gate = { id: "human-approval", type: "approvals" as const, min: 1 };
    expect(
      approvalsGate.evaluate(
        ctx({
          prAuthorLogin: "author",
          reviews: [review("dependabot[bot]", "APPROVED", { type: "Bot" })],
        }),
        gate,
        DEFAULT_CONFIG,
      ).result,
    ).toBe("fail");
  });
});
