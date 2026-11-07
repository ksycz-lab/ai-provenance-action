import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyContext } from "../src/core/evaluate-policy.js";
import { DEFAULT_CONFIG, type GateConfig } from "../src/core/load-config.js";
import {
  mutationScoreGate,
  type MutationScoreDetails,
} from "../src/core/mutation-score-gate.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/stryker");

const gateConfig: GateConfig = {
  id: "mutation",
  type: "mutation-score",
  threshold: 80,
  scope: "ai-files",
  onMissing: "fail",
};

function mutant(status: string): { status: string } {
  return { status };
}

function report(files: Record<string, { mutants: { status: string }[] }>): unknown {
  return { schemaVersion: "2", files };
}

function ctx(
  files: Record<string, { mutants: { status: string }[] }>,
  aiFiles: string[],
): PolicyContext {
  return {
    aiTagged: true,
    truncated: false,
    aiFiles,
    mutationReport: { kind: "present", value: report(files) },
  };
}

function detailsOf(evaluation: { details?: unknown }): MutationScoreDetails {
  return evaluation.details as MutationScoreDetails;
}

describe("P3-M2 mutation-score gate", () => {
  it("P3-M2-01: score = detected / valid × 100 (Stryker definition)", () => {
    const evaluation = mutationScoreGate.evaluate(
      ctx(
        {
          "src/cart.ts": {
            mutants: [
              mutant("Killed"),
              mutant("Killed"),
              mutant("Timeout"),
              mutant("Survived"),
              mutant("NoCoverage"),
              mutant("CompileError"),
              mutant("RuntimeError"),
              mutant("Ignored"),
              {} as { status: string },
            ],
          },
        },
        ["src/cart.ts"],
      ),
      { ...gateConfig, threshold: 0 },
      DEFAULT_CONFIG,
    );
    const details = detailsOf(evaluation);
    expect(details.detected).toBe(3);
    expect(details.valid).toBe(6);
    expect(details.score).toBe(50);
    expect(details.counts).toMatchObject({
      killed: 2,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
      compileError: 1,
      runtimeError: 1,
      ignored: 1,
      other: 1,
    });
  });

  it("P3-M2-02: scope ai-files counts only mutants in ai_files", () => {
    const evaluation = mutationScoreGate.evaluate(
      ctx(
        {
          "src/cart.ts": { mutants: [mutant("Killed")] },
          "src/other.ts": { mutants: [mutant("Survived"), mutant("Survived")] },
        },
        ["src/cart.ts"],
      ),
      gateConfig,
      DEFAULT_CONFIG,
    );
    const details = detailsOf(evaluation);
    expect(details.filesInScope).toEqual(["src/cart.ts"]);
    expect(details.score).toBe(100);
    expect(evaluation.result).toBe("pass");

    const allScope = mutationScoreGate.evaluate(
      ctx(
        {
          "src/cart.ts": { mutants: [mutant("Killed")] },
          "src/other.ts": { mutants: [mutant("Survived")] },
        },
        ["src/cart.ts"],
      ),
      { ...gateConfig, scope: "all", threshold: 0 },
      DEFAULT_CONFIG,
    );
    expect(detailsOf(allScope).filesInScope).toEqual(["src/cart.ts", "src/other.ts"]);
  });

  it("P3-M2-03: report paths are normalised before matching PR paths", () => {
    const evaluation = mutationScoreGate.evaluate(
      {
        aiTagged: true,
        truncated: false,
        aiFiles: ["src/cart.ts"],
        mutationReport: {
          kind: "present",
          value: report({
            ".\\src\\cart.ts": { mutants: [mutant("Killed")] },
          }),
        },
      },
      gateConfig,
      DEFAULT_CONFIG,
    );
    expect(evaluation.result).toBe("pass");
    expect(detailsOf(evaluation).filesInScope).toEqual(["src/cart.ts"]);
  });

  it("P3-M2-04: score exactly equal to the threshold passes", () => {
    const evaluation = mutationScoreGate.evaluate(
      ctx(
        {
          "src/cart.ts": {
            mutants: [
              mutant("Killed"),
              mutant("Killed"),
              mutant("Killed"),
              mutant("Killed"),
              mutant("Survived"),
            ],
          },
        },
        ["src/cart.ts"],
      ),
      { ...gateConfig, threshold: 80 },
      DEFAULT_CONFIG,
    );
    expect(detailsOf(evaluation).score).toBe(80);
    expect(evaluation.result).toBe("pass");

    const below = mutationScoreGate.evaluate(
      ctx({ "src/cart.ts": { mutants: [mutant("Survived")] } }, ["src/cart.ts"]),
      gateConfig,
      DEFAULT_CONFIG,
    );
    expect(below.result).toBe("fail");
    expect(below.message).toMatch(/</);
  });

  it("P3-M2-05: AI files with no mutants gives skipped, not pass", () => {
    const evaluation = mutationScoreGate.evaluate(
      ctx({ "README.md": { mutants: [] } }, ["README.md"]),
      gateConfig,
      DEFAULT_CONFIG,
    );
    expect(evaluation.result).toBe("skipped");
    expect(evaluation.message).toMatch(/no mutants in scope/i);
    expect(detailsOf(evaluation).score).toBeNull();
  });

  it("P3-M2-06: missing report fail vs skip", () => {
    const missing: PolicyContext = {
      aiTagged: true,
      truncated: false,
      mutationReport: { kind: "missing" },
    };
    expect(
      mutationScoreGate.evaluate(
        missing,
        { ...gateConfig, onMissing: "fail" },
        DEFAULT_CONFIG,
      ).result,
    ).toBe("fail");
    expect(
      mutationScoreGate.evaluate(
        missing,
        { ...gateConfig, onMissing: "skip" },
        DEFAULT_CONFIG,
      ).result,
    ).toBe("skipped");
  });

  it("P3-M2-07: malformed JSON or wrong schema gives error with a clear message", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.policy.gates = [gateConfig];

    const malformed = evaluatePolicy(
      {
        aiTagged: true,
        truncated: false,
        mutationReport: { kind: "invalid", message: "Unexpected token" },
      },
      config,
      [mutationScoreGate],
    );
    expect(malformed.gates[0]?.result).toBe("error");
    expect(malformed.gates[0]?.message).toMatch(/malformed mutation report/i);

    const wrongSchema = evaluatePolicy(
      {
        aiTagged: true,
        truncated: false,
        mutationReport: { kind: "present", value: { schemaVersion: "2" } },
      },
      config,
      [mutationScoreGate],
    );
    expect(wrongSchema.gates[0]?.result).toBe("error");
    expect(wrongSchema.gates[0]?.message).toMatch(/files object/i);
  });

  it("P3-M2-08: Stryker JS and Stryker.NET fixtures both parse", () => {
    const js = JSON.parse(
      readFileSync(join(fixtures, "stryker-js.json"), "utf8"),
    ) as unknown;
    const dotnet = JSON.parse(
      readFileSync(join(fixtures, "stryker-dotnet.json"), "utf8"),
    ) as unknown;

    const fromJs = mutationScoreGate.evaluate(
      {
        aiTagged: true,
        truncated: false,
        aiFiles: ["src/cart.ts"],
        mutationReport: { kind: "present", value: js },
      },
      { ...gateConfig, threshold: 0 },
      DEFAULT_CONFIG,
    );
    expect(fromJs.result).toBe("pass");
    expect(detailsOf(fromJs).valid).toBeGreaterThan(0);

    const fromDotnet = mutationScoreGate.evaluate(
      {
        aiTagged: true,
        truncated: false,
        aiFiles: ["src/Shop/Cart.cs"],
        mutationReport: { kind: "present", value: dotnet },
      },
      { ...gateConfig, threshold: 0, scope: "ai-files" },
      DEFAULT_CONFIG,
    );
    expect(fromDotnet.result).toBe("pass");
    expect(detailsOf(fromDotnet).detected).toBe(1);
    expect(detailsOf(fromDotnet).valid).toBe(2);
  });
});
