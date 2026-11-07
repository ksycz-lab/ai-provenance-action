import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { load as loadYaml, YAMLException } from "js-yaml";
import { DEFAULT_DETECTION_RULES, type DetectionRules } from "./classify-commits.js";
import configSchema from "../../schema/config.v1.schema.json" with { type: "json" };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type ConfigError = {
  path: string;
  message: string;
  suggestion?: string;
};

export type PolicyMode = "enforce" | "warn";
export type TruncationMode = "fail" | "warn";
export type MissingReportMode = "fail" | "warn" | "skip";
export type GateType = "mutation-score" | "required-label" | "approvals";
export type MutationScope = "ai-files" | "all";

export type GateConfig = {
  id: string;
  type: GateType;
  mode?: PolicyMode;
  threshold?: number;
  scope?: MutationScope;
  onMissing?: MissingReportMode;
  label?: string;
  min?: number;
};

export type Config = {
  version: 1;
  source: "defaults" | "file";
  detection: DetectionRules;
  policy: {
    mode: PolicyMode;
    gates: GateConfig[];
  };
  limits: {
    maxCommits: number;
    maxFiles: number;
    onTruncated: TruncationMode;
  };
};

export { configSchema };

const MAX_REGEX_LENGTH = 200;

export const DEFAULT_CONFIG: Config = {
  version: 1,
  source: "defaults",
  detection: {
    trailers: DEFAULT_DETECTION_RULES.trailers.map((rule) => ({ ...rule })),
    labels: [...DEFAULT_DETECTION_RULES.labels],
  },
  policy: {
    mode: "enforce",
    gates: [],
  },
  limits: {
    maxCommits: 250,
    maxFiles: 3000,
    onTruncated: "fail",
  },
};

const KEYS_BY_PARENT: Record<string, string[]> = {
  "": ["version", "detection", "policy", "limits"],
  detection: ["trailers", "labels"],
  "detection.trailers": ["key", "value"],
  policy: ["mode", "gates"],
  "policy.gates": [
    "id",
    "type",
    "mode",
    "threshold",
    "scope",
    "on-missing",
    "label",
    "min",
  ],
  limits: ["max-commits", "max-files", "on-truncated"],
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
const validateConfig = ajv.compile(configSchema);

function cloneDefaults(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dist[i]![0] = i;
  for (let j = 0; j < cols; j += 1) dist[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(
        dist[i - 1]![j]! + 1,
        dist[i]![j - 1]! + 1,
        dist[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dist[a.length]![b.length]!;
}

function suggestKey(actual: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const candidate of candidates) {
    const d = levenshtein(actual, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

function jsonPointerToPath(pointer: string): string {
  if (!pointer) {
    return "";
  }
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let path = "";
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      path += `[${part}]`;
    } else {
      path += path ? `.${part}` : part;
    }
  }
  return path;
}

function parentKeyList(path: string): string[] {
  const parent = path.replace(/\[\d+]$/, "").replace(/\.[^.]+$/, "");
  if (path.includes(".trailers[")) {
    return KEYS_BY_PARENT["detection.trailers"] ?? [];
  }
  if (path.includes(".gates[")) {
    return KEYS_BY_PARENT["policy.gates"] ?? [];
  }
  return KEYS_BY_PARENT[parent] ?? KEYS_BY_PARENT[""] ?? [];
}

function fail(errors: ConfigError[]): Result<Config, ConfigError[]> {
  return { ok: false, error: errors };
}

function fromAjv(errors: ErrorObject[] | null | undefined): ConfigError[] {
  return (errors ?? []).map((error) => {
    const path = jsonPointerToPath(error.instancePath);
    if (error.keyword === "additionalProperties") {
      const extra = String(error.params.additionalProperty);
      const fullPath = path ? `${path}.${extra}` : extra;
      const suggestion = suggestKey(extra, parentKeyList(fullPath));
      return {
        path: fullPath,
        message: `unknown key '${extra}'`,
        ...(suggestion ? { suggestion } : {}),
      };
    }
    return {
      path: path || "(root)",
      message: error.message ?? "invalid config",
    };
  });
}

type RawTrailer = { key: string; value?: string };
type RawGate = {
  id: string;
  type: GateType;
  mode?: PolicyMode;
  threshold?: number;
  scope?: MutationScope;
  "on-missing"?: MissingReportMode;
  label?: string;
  min?: number;
};
type RawConfig = {
  version?: unknown;
  detection?: { trailers?: RawTrailer[]; labels?: string[] };
  policy?: { mode?: PolicyMode; gates?: RawGate[] };
  limits?: {
    "max-commits"?: number;
    "max-files"?: number;
    "on-truncated"?: TruncationMode;
  };
};

function mapGate(gate: RawGate): GateConfig {
  return {
    id: gate.id,
    type: gate.type,
    ...(gate.mode ? { mode: gate.mode } : {}),
    ...(gate.threshold !== undefined ? { threshold: gate.threshold } : {}),
    ...(gate.scope ? { scope: gate.scope } : {}),
    ...(gate["on-missing"] ? { onMissing: gate["on-missing"] } : {}),
    ...(gate.label ? { label: gate.label } : {}),
    ...(gate.min !== undefined ? { min: gate.min } : {}),
  };
}

function mergeWithDefaults(raw: RawConfig): Config {
  const base = cloneDefaults();
  base.source = "file";
  if (raw.detection?.trailers) {
    base.detection.trailers = raw.detection.trailers.map((rule) => ({ ...rule }));
  }
  if (raw.detection?.labels) {
    base.detection.labels = [...raw.detection.labels];
  }
  if (raw.policy?.mode) {
    base.policy.mode = raw.policy.mode;
  }
  if (raw.policy?.gates) {
    base.policy.gates = raw.policy.gates.map(mapGate);
  }
  if (raw.limits?.["max-commits"] !== undefined) {
    base.limits.maxCommits = raw.limits["max-commits"];
  }
  if (raw.limits?.["max-files"] !== undefined) {
    base.limits.maxFiles = raw.limits["max-files"];
  }
  if (raw.limits?.["on-truncated"]) {
    base.limits.onTruncated = raw.limits["on-truncated"];
  }
  return base;
}

function regexErrors(trailers: RawTrailer[] | undefined): ConfigError[] {
  if (!trailers) {
    return [];
  }
  const errors: ConfigError[] = [];
  trailers.forEach((rule, index) => {
    if (rule.value === undefined) {
      return;
    }
    const path = `detection.trailers[${index}].value`;
    if (rule.value.length > MAX_REGEX_LENGTH) {
      errors.push({
        path,
        message: `regex longer than ${MAX_REGEX_LENGTH} characters`,
      });
      return;
    }
    try {
      new RegExp(rule.value, "i");
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      errors.push({
        path,
        message: `invalid regex: ${detail}`,
      });
    }
  });
  return errors;
}

function duplicateGateErrors(gates: RawGate[] | undefined): ConfigError[] {
  if (!gates) {
    return [];
  }
  const seen = new Map<string, number>();
  const errors: ConfigError[] = [];
  gates.forEach((gate, index) => {
    const previous = seen.get(gate.id);
    if (previous !== undefined) {
      errors.push({
        path: `policy.gates[${index}].id`,
        message: `duplicate gate id '${gate.id}' (already used at policy.gates[${previous}].id)`,
      });
    } else {
      seen.set(gate.id, index);
    }
  });
  return errors;
}

export function loadConfig(
  yamlText: string | undefined,
): Result<Config, ConfigError[]> {
  if (yamlText === undefined) {
    return { ok: true, value: cloneDefaults() };
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText);
  } catch (caught) {
    if (caught instanceof YAMLException) {
      const line = (caught.mark?.line ?? 0) + 1;
      const column = (caught.mark?.column ?? 0) + 1;
      return fail([
        {
          path: `line ${line}, column ${column}`,
          message: caught.reason,
        },
      ]);
    }
    return fail([{ path: "(root)", message: String(caught) }]);
  }

  if (parsed === null || parsed === undefined) {
    return fail([{ path: "(root)", message: "config is empty" }]);
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail([{ path: "(root)", message: "config must be a mapping" }]);
  }

  const raw = parsed as RawConfig;
  if (typeof raw.version === "number" && raw.version !== 1) {
    return fail([
      {
        path: "version",
        message: "unsupported config version",
      },
    ]);
  }

  if (!validateConfig(parsed)) {
    return fail(fromAjv(validateConfig.errors));
  }

  const extras = [
    ...regexErrors(raw.detection?.trailers),
    ...duplicateGateErrors(raw.policy?.gates),
  ];
  if (extras.length > 0) {
    return fail(extras);
  }

  return { ok: true, value: mergeWithDefaults(raw) };
}
