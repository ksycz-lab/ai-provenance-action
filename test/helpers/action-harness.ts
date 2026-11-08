import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOctokit } from "@actions/github";
import nock from "nock";
import type { GitHubClient } from "../../src/adapters/fetch-pull-request.js";
import type { ActionDeps, ActionInputs } from "../../src/adapters/run.js";

/** Shared harness for the run() tests: nock-served GitHub replies and recording fakes. */

export const API = "https://api.github.com";
export const BASE = "/repos/ksycz/demo-shop";
export const BASE_SHA = "b".repeat(40);
export const HEAD_SHA = "c".repeat(40);
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const sha = (i: number) => i.toString(16).padStart(40, "0");

export function client(): GitHubClient {
  return getOctokit("test-token", { request: { fetch: globalThis.fetch } });
}

/** No config on the base branch, none at the head either. */
export function serveNoConfig(): void {
  nock(API)
    .get(/\/contents\/\.github(\/|%2F)ai-provenance\.yml\?ref=b+$/)
    .reply(404, { message: "Not Found" });
  nock(API)
    .get(`${BASE}/git/trees/${HEAD_SHA}`)
    .reply(200, { sha: "d".repeat(40), tree: [] });
}

/** A config on the base branch, unchanged at the head. */
export function serveConfig(yaml: string): void {
  nock(API)
    .get(/\/contents\/\.github(\/|%2F)ai-provenance\.yml\?ref=b+$/)
    .reply(200, {
      type: "file",
      sha: "a".repeat(40),
      encoding: "base64",
      content: Buffer.from(yaml).toString("base64"),
    });
  nock(API)
    .get(`${BASE}/git/trees/${HEAD_SHA}`)
    .reply(200, { tree: [{ path: ".github", type: "tree", sha: "e".repeat(40) }] });
  nock(API)
    .get(`${BASE}/git/trees/${"e".repeat(40)}`)
    .reply(200, {
      tree: [{ path: "ai-provenance.yml", type: "blob", sha: "a".repeat(40) }],
    });
}

/** PR #42 with one human commit and, optionally, one AI-tagged commit touching src/cart.ts. */
export function servePr(options: {
  ai: boolean;
  labels?: string[];
  fork?: boolean;
}): void {
  const commits = [
    {
      sha: sha(1),
      commit: { message: "Fix typo\n", author: { name: "Jana" } },
      author: { login: "jana" },
    },
    ...(options.ai
      ? [
          {
            sha: sha(2),
            commit: {
              message: "Add totals\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
              author: { name: "K" },
            },
            author: { login: "ksycz" },
          },
        ]
      : []),
  ];
  nock(API)
    .get(`${BASE}/pulls/42`)
    .reply(200, {
      number: 42,
      html_url: "https://github.com/ksycz/demo-shop/pull/42",
      commits: commits.length,
      user: { login: "ksycz" },
      labels: (options.labels ?? []).map((name) => ({ name })),
      base: { sha: BASE_SHA, repo: { full_name: "ksycz/demo-shop" } },
      head: {
        sha: HEAD_SHA,
        repo: { full_name: options.fork ? "contributor/demo-shop" : "ksycz/demo-shop" },
      },
    });
  nock(API)
    .get(`${BASE}/pulls/42/commits`)
    .query({ per_page: "100" })
    .reply(200, commits);
  if (options.ai) {
    nock(API)
      .get(`${BASE}/commits/${sha(2)}`)
      .reply(200, {
        files: [
          {
            filename: "src/cart.ts",
            status: "modified",
            patch: "@@ -1,0 +1,2 @@\n+a\n+b",
          },
        ],
      });
    nock(API).get(`${BASE}/pulls/42/reviews`).query(true).reply(200, []);
  }
}

export type Recorder = {
  outputs: Record<string, string>;
  failed: string[];
  warnings: string[];
  notices: string[];
  summaries: string[];
  uploads: { name: string; files: string[]; root: string }[];
};

let workspace = "";

/** A fresh temporary workspace for the next setup() call. */
export function resetWorkspace(): string {
  workspace = mkdtempSync(join(tmpdir(), "provenance-ws-"));
  return workspace;
}

export function setup(
  inputs: Partial<ActionInputs> = {},
  context: Partial<ActionDeps["context"]> = {},
): { deps: ActionDeps; rec: Recorder } {
  const rec: Recorder = {
    outputs: {},
    failed: [],
    warnings: [],
    notices: [],
    summaries: [],
    uploads: [],
  };
  const deps: ActionDeps = {
    inputs: {
      configPath: ".github/ai-provenance.yml",
      mutationReport: "",
      reportPath: "ai-provenance-report.json",
      uploadArtifact: true,
      prComment: false,
      ...inputs,
    },
    core: {
      setOutput: (name, value) => {
        rec.outputs[name] = value;
      },
      setFailed: (message) => {
        rec.failed.push(message);
      },
      warning: (message) => {
        rec.warnings.push(message);
      },
      notice: (message) => {
        rec.notices.push(message);
      },
      info: () => {},
      writeSummary: async (markdown) => {
        rec.summaries.push(markdown);
      },
    },
    uploadArtifact: async (name, files, root) => {
      rec.uploads.push({ name, files, root });
    },
    client: client(),
    context: {
      eventName: "pull_request",
      repo: { owner: "ksycz", repo: "demo-shop" },
      payload: { pull_request: { number: 42 } },
      workflow: "ci",
      runId: 987654,
      runAttempt: 1,
      ...context,
    },
    workspace,
    actionVersion: "0.1.0",
    now: () => new Date("2026-11-08T19:00:00.000Z"),
    sleep: async () => {},
  };
  return { deps, rec };
}

export const LABEL_GATE = (mode: "enforce" | "warn") => `version: 1
policy:
  mode: ${mode}
  gates:
    - id: reviewed
      type: required-label
      label: ai-reviewed
`;
