import {
  mkdtempSync,
  readFileSync,
  existsSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { load as loadYaml } from "js-yaml";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/adapters/run.js";
import { reportSchema } from "../src/core/build-report.js";

import {
  LABEL_GATE,
  repoRoot,
  resetWorkspace,
  serveConfig,
  serveNoConfig,
  servePr,
  setup,
} from "./helpers/action-harness.js";

let workspace: string;

beforeEach(() => {
  nock.disableNetConnect();
  workspace = resetWorkspace();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

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
