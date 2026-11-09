import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("P6-M1 the committed bundle starts on a runner", () => {
  it("P6-M1-09: the file named in action.yml runs under this repo's package.json", () => {
    const action = loadYaml(readFileSync(join(repoRoot, "action.yml"), "utf8")) as {
      runs: { main: string };
    };
    const ws = mkdtempSync(join(tmpdir(), "bundle-start-"));
    writeFileSync(join(ws, "event.json"), "{}");
    writeFileSync(join(ws, "summary.md"), "");

    let output = "";
    try {
      // Run from the repo root, as a runner does, so "type": "module" in package.json applies.
      execFileSync(process.execPath, [join(repoRoot, action.runs.main)], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_PATH: join(ws, "event.json"),
          GITHUB_REPOSITORY: "ksycz/demo-shop",
          GITHUB_WORKSPACE: ws,
          GITHUB_STEP_SUMMARY: join(ws, "summary.md"),
          GITHUB_OUTPUT: join(ws, "output"),
          "INPUT_GITHUB-TOKEN": "test-token",
          "INPUT_UPLOAD-ARTIFACT": "true",
          "INPUT_PR-COMMENT": "false",
        },
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    expect(output).not.toMatch(/require is not defined|Cannot find module|SyntaxError/);
    expect(output).toContain(
      "::error::this Action needs a pull_request event (got 'push')",
    );
    expect(readFileSync(join(ws, "summary.md"), "utf8")).toMatch(
      /^❌ \*\*AI provenance: error\*\*/,
    );
  });
});
