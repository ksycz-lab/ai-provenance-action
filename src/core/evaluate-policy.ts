import type { Config, GateConfig, PolicyMode } from "./load-config.js";

export type ReviewInput = {
  state: string;
  submittedAt: string;
  user: { login: string; type?: string } | null;
};

export type MutationReportInput =
  | { kind: "missing" }
  | { kind: "invalid"; message: string }
  | { kind: "present"; value: unknown };

export type PolicyContext = {
  aiTagged: boolean;
  truncated: boolean;
  prLabels?: string[];
  prAuthorLogin?: string;
  reviews?: ReviewInput[];
  aiFiles?: string[];
  mutationReport?: MutationReportInput;
};

export type GateOutcome = "pass" | "fail" | "skipped" | "error";

export type GateEvaluation = {
  result: Exclude<GateOutcome, "error">;
  message: string;
  details?: unknown;
};

/** One handler per gate `type`. The engine never switches on type itself. */
export type Gate = {
  type: string;
  evaluate: (ctx: PolicyContext, gate: GateConfig, config: Config) => GateEvaluation;
};

export type EvaluatedGate = {
  id: string;
  type: string;
  mode: PolicyMode;
  result: GateOutcome;
  message: string;
  details?: unknown;
};

export type PolicyVerdict = "pass" | "warn" | "fail";

export type PolicyResult = {
  verdict: PolicyVerdict;
  reason?: "no-ai-changes" | "truncated" | "report-only";
  note?: "report-only";
  gates: EvaluatedGate[];
};

const VERDICT_RANK: Record<PolicyVerdict, number> = {
  pass: 0,
  warn: 1,
  fail: 2,
};

function worse(a: PolicyVerdict, b: PolicyVerdict): PolicyVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

function gateMode(gate: GateConfig, config: Config): PolicyMode {
  return gate.mode ?? config.policy.mode;
}

function skipAll(
  config: Config,
  message: string,
  verdict: PolicyVerdict,
  reason: PolicyResult["reason"],
  extra?: Pick<PolicyResult, "note">,
): PolicyResult {
  return {
    verdict,
    reason,
    ...extra,
    gates: config.policy.gates.map((gate) => ({
      id: gate.id,
      type: gate.type,
      mode: gateMode(gate, config),
      result: "skipped",
      message,
    })),
  };
}

function handlerFor(type: string, gates: readonly Gate[]): Gate | undefined {
  return gates.find((gate) => gate.type === type);
}

function runGate(
  ctx: PolicyContext,
  gate: GateConfig,
  config: Config,
  handlers: readonly Gate[],
): EvaluatedGate {
  const mode = gateMode(gate, config);
  const handler = handlerFor(gate.type, handlers);
  if (!handler) {
    return {
      id: gate.id,
      type: gate.type,
      mode,
      result: "error",
      message: `unknown gate type '${gate.type}'`,
    };
  }
  try {
    const evaluation = handler.evaluate(ctx, gate, config);
    return {
      id: gate.id,
      type: gate.type,
      mode,
      result: evaluation.result,
      message: evaluation.message,
      ...(evaluation.details !== undefined ? { details: evaluation.details } : {}),
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return {
      id: gate.id,
      type: gate.type,
      mode,
      result: "error",
      message,
    };
  }
}

function verdictFromGate(evaluated: EvaluatedGate): PolicyVerdict {
  if (evaluated.result === "pass" || evaluated.result === "skipped") {
    return "pass";
  }
  return evaluated.mode === "enforce" ? "fail" : "warn";
}

export function evaluatePolicy(
  ctx: PolicyContext,
  config: Config,
  handlers: readonly Gate[] = [],
): PolicyResult {
  if (ctx.truncated && config.limits.onTruncated === "fail") {
    return skipAll(config, "input data truncated", "fail", "truncated");
  }

  if (!ctx.aiTagged) {
    return skipAll(config, "no AI-tagged commits", "pass", "no-ai-changes");
  }

  if (config.policy.gates.length === 0) {
    return {
      verdict: "pass",
      reason: "report-only",
      note: "report-only",
      gates: [],
    };
  }

  let verdict: PolicyVerdict =
    ctx.truncated && config.limits.onTruncated === "warn" ? "warn" : "pass";
  const gates = config.policy.gates.map((gate) => runGate(ctx, gate, config, handlers));
  for (const evaluated of gates) {
    verdict = worse(verdict, verdictFromGate(evaluated));
  }
  return { verdict, gates };
}
