import {
  mkdtempSync,
  readFileSync,
  existsSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOctokit } from "@actions/github";
import Ajv2020 from "ajv/dist/2020.js";
import { load as loadYaml } from "js-yaml";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../src/adapters/fetch-pull-request.js";
import { run, type ActionDeps, type ActionInputs } from "../src/adapters/run.js";
import { reportSchema } from "../src/core/build-report.js";

const API = "https://api.github.com";
const BASE = "/repos/ksycz/demo-shop";
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const sha = (i: number) => i.toString(16).padStart(40, "0");

function client(): GitHubClient {
  return getOctokit("test-token", { request: { fetch: globalThis.fetch } });
}

/** No config on the base branch, none at the head either. */
function serveNoConfig(): void {
  nock(API)
    .get(/\/contents\/\.github(\/|%2F)ai-provenance\.yml\?ref=b+$/)
    .reply(404, { message: "Not Found" });
  nock(API)
    .get(`${BASE}/git/trees/${HEAD_SHA}`)
    .reply(200, { sha: "d".repeat(40), tree: [] });
}

/** A config on the base branch, unchanged at the head. */
function serveConfig(yaml: string): void {
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
function servePr(options: { ai: boolean; labels?: string[] }): void {
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
      head: { sha: HEAD_SHA, repo: { full_name: "ksycz/demo-shop" } },
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

type Recorder = {
  outputs: Record<string, string>;
  failed: string[];
  warnings: string[];
  summaries: string[];
  uploads: { name: string; files: string[]; root: string }[];
};

let workspace: string;

function setup(
  inputs: Partial<ActionInputs> = {},
  context: Partial<ActionDeps["context"]> = {},
): { deps: ActionDeps; rec: Recorder } {
  const rec: Recorder = {
    outputs: {},
    failed: [],
    warnings: [],
    summaries: [],
    uploads: [],
  };
  const deps: ActionDeps = {
    inputs: {
      configPath: ".github/ai-provenance.yml",
      mutationReport: "",
      reportPath: "ai-provenance-report.json",
      uploadArtifact: true,
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

beforeEach(() => {
  nock.disableNetConnect();
  workspace = mkdtempSync(join(tmpdir(), "provenance-ws-"));
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

const LABEL_GATE = (mode: "enforce" | "warn") => `version: 1
policy:
  mode: ${mode}
  gates:
    - id: reviewed
      type: required-label
      label: ai-reviewed
`;

describe("P5-M3 outputs, job summary and artifact", () => {
  it("P5-M3-01: outputs ai_tagged, ai_files (a JSON array), report_path and verdict are set", async () => {
    serveNoConfig();
    servePr({ ai: true });
    const { deps, rec } = setup();

    await run(deps);

    expect(rec.outputs).toEqual({
      ai_tagged: "true",
      ai_files: '["src/cart.ts"]',
      report_path: "ai-provenance-report.json",
      verdict: "pass",
    });
    expect(JSON.parse(rec.outputs.ai_files!)).toEqual(["src/cart.ts"]);
    const report = JSON.parse(
      readFileSync(join(workspace, "ai-provenance-report.json"), "utf8"),
    );
    const validate = new Ajv2020({ strict: true }).compile(reportSchema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.run).toEqual({
      repository: "ksycz/demo-shop",
      workflow: "ci",
      runId: 987654,
      runAttempt: 1,
      event: "pull_request",
    });
    expect(rec.failed).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });

  it("P5-M3-02: verdict fail calls setFailed; warn emits a warning and does not fail", async () => {
    serveConfig(LABEL_GATE("enforce"));
    servePr({ ai: true });
    const failing = setup();
    await run(failing.deps);
    expect(failing.rec.outputs.verdict).toBe("fail");
    expect(failing.rec.failed).toEqual([
      "AI provenance verdict: fail. See the job summary for the gates that failed.",
    ]);

    serveConfig(LABEL_GATE("warn"));
    servePr({ ai: true });
    const warning = setup();
    await run(warning.deps);
    expect(warning.rec.outputs.verdict).toBe("warn");
    expect(warning.rec.failed).toEqual([]);
    expect(warning.rec.warnings).toEqual([
      "AI provenance verdict: warn. See the job summary for the gates that did not pass.",
    ]);
  });

  it("P5-M3-03: the job summary is written in every outcome, including failure", async () => {
    serveNoConfig();
    servePr({ ai: false });
    const quiet = setup();
    await run(quiet.deps);
    expect(quiet.rec.summaries).toHaveLength(1);
    expect(quiet.rec.summaries[0]).toMatch(/^✅ .*no AI-assisted commits/);

    serveConfig(LABEL_GATE("enforce"));
    servePr({ ai: true });
    const failing = setup();
    await run(failing.deps);
    expect(failing.rec.summaries).toHaveLength(1);
    expect(failing.rec.summaries[0]).toMatch(/^❌ /);

    // An error before any report exists still leaves a summary behind.
    const broken = setup({}, { eventName: "push", payload: {} });
    await run(broken.deps);
    expect(broken.rec.summaries).toHaveLength(1);
    expect(broken.rec.summaries[0]).toMatch(
      /^❌ \*\*AI provenance: error\*\*: this Action needs a pull&#95;request event/,
    );
    expect(broken.rec.failed).toEqual([
      "this Action needs a pull_request event (got 'push')",
    ]);
  });

  it("P5-M3-04: the artifact is named ai-provenance-<pr>-<run_attempt>", async () => {
    serveNoConfig();
    servePr({ ai: true });
    const { deps, rec } = setup({}, { runAttempt: 3 });

    await run(deps);

    expect(rec.uploads).toEqual([
      {
        name: "ai-provenance-42-3",
        files: [join(workspace, "ai-provenance-report.json")],
        root: workspace,
      },
    ]);
  });

  it("P5-M3-05: upload-artifact false writes the file but skips the upload", async () => {
    serveNoConfig();
    servePr({ ai: true });
    const { deps, rec } = setup({
      uploadArtifact: false,
      reportPath: "out/report.json",
    });

    await run(deps);

    expect(existsSync(join(workspace, "out/report.json"))).toBe(true);
    expect(rec.uploads).toEqual([]);
    expect(rec.outputs.report_path).toBe("out/report.json");
  });

  it("P5-M3-06: a mutation-report path outside the workspace is rejected", async () => {
    const outside = mkdtempSync(join(tmpdir(), "provenance-outside-"));
    writeFileSync(join(outside, "mutation.json"), "{}");
    mkdirSync(join(workspace, "reports"));
    symlinkSync(join(outside, "mutation.json"), join(workspace, "reports/link.json"));

    for (const path of [
      "../outside/mutation.json",
      join(outside, "mutation.json"),
      "reports/link.json",
    ]) {
      const { deps, rec } = setup({ mutationReport: path });
      await run(deps);
      expect(rec.failed, path).toEqual([
        `mutation-report must be a file inside the workspace (got '${path}')`,
      ]);
      expect(rec.summaries[0], path).toMatch(/^❌ \*\*AI provenance: error\*\*/);
    }
    expect(nock.pendingMocks()).toEqual([]); // rejected before any API call
  });

  it("P5-M3-08: a mutation-report inside the workspace is read and scored on the AI files", async () => {
    mkdirSync(join(workspace, "reports"));
    writeFileSync(
      join(workspace, "reports/mutation.json"),
      readFileSync(join(repoRoot, "test/fixtures/stryker/stryker-js.json")),
    );
    serveConfig(`version: 1
policy:
  gates:
    - id: mutation
      type: mutation-score
      threshold: 0
      scope: ai-files
`);
    servePr({ ai: true });
    const { deps, rec } = setup({ mutationReport: "reports/mutation.json" });

    await run(deps);

    const report = JSON.parse(
      readFileSync(join(workspace, "ai-provenance-report.json"), "utf8"),
    );
    expect(report.gates[0]).toMatchObject({ id: "mutation", result: "pass" });
    expect(report.gates[0].details.filesInScope).toEqual(["src/cart.ts"]);
    expect(typeof report.gates[0].details.score).toBe("number");
    expect(rec.failed).toEqual([]);
  });

  it("P5-M3-07: action.yml inputs and outputs match the README table", () => {
    const action = loadYaml(readFileSync(join(repoRoot, "action.yml"), "utf8")) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
    };
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const rows = (heading: string) => {
      const section = readme.slice(readme.indexOf(`## ${heading}`));
      const body = section.slice(
        0,
        section.indexOf("\n## ", 1) === -1 ? undefined : section.indexOf("\n## ", 1),
      );
      return [...body.matchAll(/^\| `([a-z_-]+)`\s*\|/gm)].map((m) => m[1]);
    };

    expect(rows("Inputs")).toEqual(Object.keys(action.inputs));
    expect(rows("Outputs")).toEqual(Object.keys(action.outputs));
  });
});
