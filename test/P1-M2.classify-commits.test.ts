import { describe, expect, it } from "vitest";
import {
  classifyCommits,
  DEFAULT_DETECTION_RULES,
} from "../src/core/classify-commits.js";

function commit(sha: string, message: string) {
  return { sha, message };
}

function withTrailers(subject: string, ...trailers: string[]): string {
  return `${subject}\n\n${trailers.join("\n")}\n`;
}

describe("P1-M2 rule matching", () => {
  it("P1-M2-01: Co-Authored-By: Claude matches the default rule (case-insensitive key and value)", () => {
    const result = classifyCommits(
      [
        commit(
          "aaa",
          withTrailers(
            "Fix cart",
            "Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>",
          ),
        ),
      ],
      [],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits[0]?.aiTagged).toBe(true);
    expect(result.commits[0]?.reasons).toEqual([
      {
        rule: "trailer:Co-authored-by",
        matched: "Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>",
      },
    ]);
  });

  it("P1-M2-02: Co-authored-by: GitHub Copilot matches the default rule", () => {
    const result = classifyCommits(
      [
        commit(
          "bbb",
          withTrailers(
            "Fix cart",
            "Co-authored-by: GitHub Copilot <copilot@github.com>",
          ),
        ),
      ],
      [],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits[0]?.aiTagged).toBe(true);
    expect(result.commits[0]?.reasons[0]?.matched).toContain("GitHub Copilot");
  });

  it("P1-M2-03: Co-authored-by: Jana Nováková (a human) does not match", () => {
    const result = classifyCommits(
      [
        commit(
          "ccc",
          withTrailers("Fix cart", "Co-authored-by: Jana Nováková <jana@example.com>"),
        ),
      ],
      [],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits[0]).toMatchObject({ aiTagged: false, reasons: [] });
  });

  it("P1-M2-04: Assisted-by and Generated-by match on key alone when no value regex is configured", () => {
    const result = classifyCommits(
      [
        commit("d1", withTrailers("Fix", "Assisted-by: Cursor")),
        commit("d2", withTrailers("Fix", "Generated-by:")),
      ],
      [],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits.map((c) => c.aiTagged)).toEqual([true, true]);
    expect(result.commits[0]?.reasons[0]?.rule).toBe("trailer:Assisted-by");
    expect(result.commits[1]?.reasons[0]?.rule).toBe("trailer:Generated-by");
  });

  it("P1-M2-05: a key-only rule does not match a different key that contains it", () => {
    const result = classifyCommits(
      [commit("eee", withTrailers("Fix", "Not-Assisted-by: Cursor"))],
      [],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits[0]?.aiTagged).toBe(false);
  });

  it("P1-M2-06: a commit matching two rules records both reasons", () => {
    const result = classifyCommits(
      [
        commit(
          "fff",
          withTrailers(
            "Fix",
            "Co-authored-by: Claude <noreply@anthropic.com>",
            "Assisted-by: Cursor",
          ),
        ),
      ],
      [],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits[0]?.reasons.map((r) => r.rule)).toEqual([
      "trailer:Co-authored-by",
      "trailer:Assisted-by",
    ]);
  });

  it("P1-M2-07: a configured PR label tags every commit with reason label:<name>; match is case-insensitive", () => {
    const result = classifyCommits(
      [
        commit("g1", "Human only subject."),
        commit("g2", withTrailers("Fix", "Signed-off-by: Ada <ada@example.com>")),
      ],
      ["bug", "AI-Assisted"],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits).toHaveLength(2);
    for (const classified of result.commits) {
      expect(classified.aiTagged).toBe(true);
      expect(classified.reasons).toContainEqual({
        rule: "label:ai-assisted",
        matched: "AI-Assisted",
      });
    }
  });

  it("P1-M2-08: no trailers and no label gives aiTagged false for every commit", () => {
    const result = classifyCommits(
      [
        commit("h1", "Fix the cart."),
        commit("h2", withTrailers("Fix", "Signed-off-by: Ada")),
      ],
      ["needs-review"],
      DEFAULT_DETECTION_RULES,
    );
    expect(
      result.commits.every((c) => c.aiTagged === false && c.reasons.length === 0),
    ).toBe(true);
  });

  it("P1-M2-09: a custom rule from config (X-AI-Tool) is honoured", () => {
    const result = classifyCommits(
      [commit("iii", withTrailers("Fix", "X-AI-Tool: internal-bot"))],
      [],
      {
        trailers: [{ key: "X-AI-Tool", value: ".*" }],
        labels: [],
      },
    );
    expect(result.commits[0]?.aiTagged).toBe(true);
    expect(result.commits[0]?.reasons[0]).toEqual({
      rule: "trailer:X-AI-Tool",
      matched: "X-AI-Tool: internal-bot",
    });
  });

  it("P1-M2-10: matching uses value only; a regex is never tested against the whole message", () => {
    const result = classifyCommits(
      [
        commit(
          "jjj",
          [
            "Discussed with claude and copilot in the body.",
            "",
            "Co-authored-by: Jana Nováková <jana@example.com>",
          ].join("\n"),
        ),
      ],
      [],
      DEFAULT_DETECTION_RULES,
    );
    expect(result.commits[0]?.aiTagged).toBe(false);
  });
});
