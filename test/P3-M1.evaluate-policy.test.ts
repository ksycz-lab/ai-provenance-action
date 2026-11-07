import { describe, expect, it } from "vitest";
import { evaluatePolicy, type Gate } from "../src/core/evaluate-policy.js";
import {
  DEFAULT_CONFIG,
  type Config,
  type GateConfig,
} from "../src/core/load-config.js";

function configWith(gates: GateConfig[], patch?: (config: Config) => void): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.policy.gates = gates;
  patch?.(config);
  return config;
}

function stub(type: string, evaluate: Gate["evaluate"]): Gate {
  return { type, evaluate };
}

const passing: Gate = stub("mutation-score", (_ctx, gate) => ({
  result: "pass",
  message: `${gate.id} passed`,
}));

const failing: Gate = stub("required-label", (_ctx, gate) => ({
  result: "fail",
  message: `${gate.id} failed`,
}));

const throwing: Gate = stub("approvals", () => {
  throw new Error("review API exploded");
});

describe("P3-M1 evaluation engine and enforce/warn", () => {
  it("P3-M1-01: no AI-tagged commits gives pass, every gate skipped, reason no-ai-changes", () => {
    const result = evaluatePolicy(
      { aiTagged: false, truncated: false },
      configWith([
        { id: "mutation", type: "mutation-score", threshold: 80 },
        { id: "reviewed", type: "required-label", label: "ai-reviewed" },
      ]),
      [passing, failing],
    );
    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("no-ai-changes");
    expect(result.gates.every((gate) => gate.result === "skipped")).toBe(true);
    expect(result.gates).toHaveLength(2);
  });

  it("P3-M1-02: all gates pass gives pass", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: false },
      configWith([
        { id: "mutation", type: "mutation-score", threshold: 80 },
        { id: "score-b", type: "mutation-score", threshold: 50 },
      ]),
      [passing],
    );
    expect(result.verdict).toBe("pass");
    expect(result.gates.map((gate) => gate.result)).toEqual(["pass", "pass"]);
  });

  it("P3-M1-03: one enforced gate fails gives fail", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: false },
      configWith([
        { id: "mutation", type: "mutation-score", threshold: 80 },
        { id: "reviewed", type: "required-label", label: "ai-reviewed" },
      ]),
      [passing, failing],
    );
    expect(result.verdict).toBe("fail");
    expect(result.gates.find((gate) => gate.id === "reviewed")?.result).toBe("fail");
  });

  it("P3-M1-04: one warn-mode gate fails and the others pass gives warn", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: false },
      configWith([
        { id: "mutation", type: "mutation-score", threshold: 80 },
        { id: "reviewed", type: "required-label", label: "ai-reviewed", mode: "warn" },
      ]),
      [passing, failing],
    );
    expect(result.verdict).toBe("warn");
  });

  it("P3-M1-05: global mode warn downgrades every failure unless a gate overrides with enforce", () => {
    const warnGlobal = configWith(
      [{ id: "reviewed", type: "required-label", label: "ai-reviewed" }],
      (config) => {
        config.policy.mode = "warn";
      },
    );
    expect(
      evaluatePolicy({ aiTagged: true, truncated: false }, warnGlobal, [failing])
        .verdict,
    ).toBe("warn");

    const enforcedOverride = configWith(
      [
        {
          id: "reviewed",
          type: "required-label",
          label: "ai-reviewed",
          mode: "enforce",
        },
      ],
      (config) => {
        config.policy.mode = "warn";
      },
    );
    expect(
      evaluatePolicy({ aiTagged: true, truncated: false }, enforcedOverride, [failing])
        .verdict,
    ).toBe("fail");
  });

  it("P3-M1-06: a gate that throws becomes error with the message, and other gates still run", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: false },
      configWith([
        { id: "human-approval", type: "approvals", min: 1 },
        { id: "mutation", type: "mutation-score", threshold: 80 },
      ]),
      [throwing, passing],
    );
    expect(result.gates).toEqual([
      {
        id: "human-approval",
        type: "approvals",
        mode: "enforce",
        result: "error",
        message: "review API exploded",
      },
      {
        id: "mutation",
        type: "mutation-score",
        mode: "enforce",
        result: "pass",
        message: "mutation passed",
      },
    ]);
    expect(result.verdict).toBe("fail");
  });

  it("P3-M1-07: truncated input with on-truncated fail gives fail with reason truncated", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: true },
      configWith([{ id: "mutation", type: "mutation-score", threshold: 80 }]),
      [passing],
    );
    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("truncated");
    expect(result.gates.every((gate) => gate.result === "skipped")).toBe(true);
  });

  it("unknown gate types become error without stopping later gates", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: false },
      configWith([
        { id: "mystery", type: "required-label", label: "x" },
        { id: "mutation", type: "mutation-score", threshold: 80 },
      ]),
      [passing],
    );
    expect(result.gates[0]).toMatchObject({
      id: "mystery",
      result: "error",
      message: "unknown gate type 'required-label'",
    });
    expect(result.gates[1]?.result).toBe("pass");
    expect(result.verdict).toBe("fail");
  });

  it("truncated data with on-truncated warn still evaluates gates", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: true },
      configWith(
        [{ id: "mutation", type: "mutation-score", threshold: 80 }],
        (config) => {
          config.limits.onTruncated = "warn";
        },
      ),
      [passing],
    );
    expect(result.verdict).toBe("warn");
    expect(result.gates[0]?.result).toBe("pass");
  });

  it("P3-M1-08: zero gates with AI changes present gives pass with note report-only", () => {
    const result = evaluatePolicy(
      { aiTagged: true, truncated: false },
      DEFAULT_CONFIG,
      [passing],
    );
    expect(result.verdict).toBe("pass");
    expect(result.note).toBe("report-only");
    expect(result.reason).toBe("report-only");
    expect(result.gates).toEqual([]);
  });
});
