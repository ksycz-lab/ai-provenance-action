import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { configSchema, DEFAULT_CONFIG, loadConfig } from "../src/core/load-config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("P2-M1 config schema, defaults and validation", () => {
  it("P2-M1-01: undefined input returns the built-in defaults", () => {
    const result = loadConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(DEFAULT_CONFIG);
      expect(result.value.source).toBe("defaults");
      expect(result.value.policy.gates).toEqual([]);
    }
  });

  it("P2-M1-02: a minimal valid config merges with defaults (labels replace, not append)", () => {
    const result = loadConfig("version: 1\ndetection:\n  labels: [team-ai]\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe("file");
      expect(result.value.detection.labels).toEqual(["team-ai"]);
      expect(result.value.detection.trailers).toEqual(
        DEFAULT_CONFIG.detection.trailers,
      );
      expect(result.value.policy.mode).toBe("enforce");
      expect(result.value.limits.maxCommits).toBe(250);
    }
  });

  it("P2-M1-03: an unknown key fails with its YAML path", () => {
    const result = loadConfig(`
version: 1
policy:
  gates:
    - id: mutation
      type: mutation-score
      treshold: 80
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.path).toBe("policy.gates[0].treshold");
      expect(result.error[0]?.message).toContain("unknown key");
      expect(result.error[0]?.suggestion).toBe("threshold");
    }
  });

  it("P2-M1-04: version 2 fails with unsupported config version", () => {
    const result = loadConfig("version: 2\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]).toEqual({
        path: "version",
        message: "unsupported config version",
      });
    }
  });

  it("P2-M1-05: an invalid regex fails with the rule index and the regex error message", () => {
    const result = loadConfig(`
version: 1
detection:
  trailers:
    - key: X-AI-Tool
      value: "("
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.path).toBe("detection.trailers[0].value");
      expect(result.error[0]?.message).toMatch(/invalid regex/i);
    }
  });

  it("P2-M1-06: a regex longer than 200 characters is rejected", () => {
    const result = loadConfig(`
version: 1
detection:
  trailers:
    - key: X-AI-Tool
      value: ${"a".repeat(201)}
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.path).toBe("detection.trailers[0].value");
      expect(result.error[0]?.message).toContain("200");
    }
  });

  it("P2-M1-07: threshold outside 0-100 fails", () => {
    const result = loadConfig(`
version: 1
policy:
  gates:
    - id: mutation
      type: mutation-score
      threshold: 101
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.path).toBe("policy.gates[0].threshold");
    }
  });

  it("P2-M1-08: duplicate gate ids fail", () => {
    const result = loadConfig(`
version: 1
policy:
  gates:
    - id: mutation
      type: mutation-score
      threshold: 80
    - id: mutation
      type: required-label
      label: ai-reviewed
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.path).toBe("policy.gates[1].id");
      expect(result.error[0]?.message).toMatch(/duplicate gate id/i);
    }
  });

  it("P2-M1-09: malformed YAML fails with line and column", () => {
    const result = loadConfig("version: 1\n  detection: [unterminated\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.path).toMatch(/line \d+, column \d+/);
    }
  });

  it("empty or non-mapping YAML fails clearly", () => {
    expect(loadConfig("").ok).toBe(false);
    const list = loadConfig("- just a list\n");
    expect(list.ok).toBe(false);
    if (!list.ok) {
      expect(list.error[0]?.message).toMatch(/mapping/);
    }
  });

  it("merges policy, gates and limits from a full file", () => {
    const result = loadConfig(`
version: 1
detection:
  trailers:
    - key: X-AI-Tool
      value: ".*"
  labels: [ai-assisted]
policy:
  mode: warn
  gates:
    - id: mutation
      type: mutation-score
      threshold: 80
      scope: ai-files
      on-missing: skip
      mode: enforce
    - id: reviewed
      type: required-label
      label: ai-reviewed
    - id: approvals
      type: approvals
      min: 2
limits:
  max-commits: 10
  max-files: 20
  on-truncated: warn
`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.policy.mode).toBe("warn");
      expect(result.value.policy.gates).toHaveLength(3);
      expect(result.value.policy.gates[0]?.onMissing).toBe("skip");
      expect(result.value.limits).toEqual({
        maxCommits: 10,
        maxFiles: 20,
        onTruncated: "warn",
      });
    }
  });

  it("P2-M1-10: the JSON Schema file itself is valid and is exported for editor autocompletion", () => {
    const ajv = new Ajv2020({ strict: true });
    expect(() => ajv.compile(configSchema)).not.toThrow();
    expect(configSchema.$id).toContain("config.v1.schema.json");
    expect(configSchema.$schema).toContain("2020-12");

    const docs = readFileSync(join(repoRoot, "docs/configuration.md"), "utf8");
    const names = collectPropertyNames(configSchema);
    for (const name of names) {
      expect(docs, `docs/configuration.md should mention '${name}'`).toContain(name);
    }
  });
});

function collectPropertyNames(node: unknown, into = new Set<string>()): string[] {
  if (!node || typeof node !== "object") {
    return [...into];
  }
  const record = node as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object") {
    for (const key of Object.keys(record.properties as object)) {
      into.add(key);
      collectPropertyNames((record.properties as Record<string, unknown>)[key], into);
    }
  }
  if (record.$defs && typeof record.$defs === "object") {
    collectPropertyNames(record.$defs, into);
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      collectPropertyNames(value, into);
    }
  }
  return [...into];
}
