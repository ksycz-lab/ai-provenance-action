import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOctokit } from "@actions/github";
import Ajv2020 from "ajv/dist/2020.js";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../src/adapters/fetch-pull-request.js";
import { loadBaseConfig } from "../src/adapters/load-base-config.js";
import { reportSchema, type Report } from "../src/core/build-report.js";
import { renderMarkdown } from "../src/core/render-markdown.js";
import { DEFAULT_CONFIG } from "../src/core/load-config.js";

const API = "https://api.github.com";
const REPO = { owner: "ksycz", repo: "demo-shop" };
const BASE = `/repos/${REPO.owner}/${REPO.repo}`;
const SHAS = { baseSha: "b".repeat(40), headSha: "c".repeat(40) };
const PATH = ".github/ai-provenance.yml";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let calls: string[] = [];

function client(): GitHubClient {
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    calls.push(
      decodeURIComponent(String(input instanceof Request ? input.url : input)),
    );
    return globalThis.fetch(input, init);
  };
  return getOctokit("test-token", { request: { fetch } });
}

const STRICT = `version: 1
policy:
  mode: enforce
  gates:
    - id: mutation
      type: mutation-score
      threshold: 80
`;

/** The base branch's config file, served by GET /contents/{path}?ref=<base sha>. */
function serveBaseFile(text: string, blobSha: string): void {
  nock(API)
    .get(
      new RegExp(
        `^${BASE}/contents/\\.github(/|%2F)ai-provenance\\.yml\\?ref=${SHAS.baseSha}$`,
      ),
    )
    .reply(200, {
      type: "file",
      path: PATH,
      sha: blobSha,
      encoding: "base64",
      content: Buffer.from(text)
        .toString("base64")
        .replace(/(.{60})/g, "$1\n"),
    });
}

function serveBaseMissing(): void {
  nock(API)
    .get(
      new RegExp(
        `^${BASE}/contents/\\.github(/|%2F)ai-provenance\\.yml\\?ref=${SHAS.baseSha}$`,
      ),
    )
    .reply(404, { message: "Not Found" });
}

/** The head commit's trees: `.github/` and, inside it, the config blob (if any). */
function serveHeadTree(configBlobSha: string | undefined): void {
  nock(API)
    .get(`${BASE}/git/trees/${SHAS.headSha}`)
    .reply(200, {
      sha: "d".repeat(40),
      tree: [
        { path: ".github", type: "tree", sha: "e".repeat(40) },
        { path: "src", type: "tree", sha: "f".repeat(40) },
      ],
    });
  nock(API)
    .get(`${BASE}/git/trees/${"e".repeat(40)}`)
    .reply(200, {
      sha: "e".repeat(40),
      tree: [
        { path: "workflows", type: "tree", sha: "1".repeat(40) },
        ...(configBlobSha
          ? [{ path: "ai-provenance.yml", type: "blob", sha: configBlobSha }]
          : []),
      ],
    });
}

beforeEach(() => {
  calls = [];
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("P5-M2 config from the base branch", () => {
  it("P5-M2-01: the config is requested with ref = base SHA; the head side is never read", async () => {
    serveBaseFile(STRICT, "a".repeat(40));
    serveHeadTree("a".repeat(40));

    const loaded = await loadBaseConfig(client(), REPO, SHAS, PATH);

    expect(loaded.source).toBe("base-branch");
    expect(loaded.config.policy.gates).toEqual([
      expect.objectContaining({ id: "mutation", threshold: 80 }),
    ]);
    expect(loaded.changedInPr).toBe(false);
    const contentCalls = calls.filter((u) => u.includes("/contents/"));
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]).toContain(`ref=${SHAS.baseSha}`);
    expect(
      calls.some((u) => u.includes("/contents/") && u.includes(SHAS.headSha)),
    ).toBe(false);
    expect(nock.isDone()).toBe(true);
  });

  it("P5-M2-02: a 404 gives the defaults and config.source 'defaults'", async () => {
    serveBaseMissing();
    serveHeadTree(undefined);

    const loaded = await loadBaseConfig(client(), REPO, SHAS, PATH);

    expect(loaded).toEqual({
      config: DEFAULT_CONFIG,
      source: "defaults",
      path: PATH,
      sha256: null,
      changedInPr: false,
    });
  });

  it("P5-M2-03: a PR that edits the config is judged by the base version and flagged", async () => {
    serveBaseFile(STRICT, "a".repeat(40));
    serveHeadTree("9".repeat(40)); // the PR changed the file; its content is never read

    const edited = await loadBaseConfig(client(), REPO, SHAS, PATH);

    expect(edited.config.policy.mode).toBe("enforce");
    expect(edited.config.policy.gates).toHaveLength(1);
    expect(edited.changedInPr).toBe(true);

    // A PR that adds a config where the base has none: still defaults, still flagged.
    serveBaseMissing();
    serveHeadTree("9".repeat(40));
    const added = await loadBaseConfig(client(), REPO, SHAS, PATH);
    expect(added.source).toBe("defaults");
    expect(added.changedInPr).toBe(true);

    // The report carries the flag and validates against the schema.
    const report = JSON.parse(
      readFileSync(join(repoRoot, "test/__snapshots__/P4-M1.full-report.json"), "utf8"),
    ) as Report;
    report.config.changedInPr = true;
    const validate = new Ajv2020({ strict: true }).compile(reportSchema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("P5-M2-04: an invalid base config fails with the P2-M1 error messages", async () => {
    serveBaseFile(STRICT.replace("threshold", "treshold"), "a".repeat(40));
    serveHeadTree("a".repeat(40));

    await expect(loadBaseConfig(client(), REPO, SHAS, PATH)).rejects.toThrow(
      /Invalid config \.github\/ai-provenance\.yml on the base branch[\s\S]*policy\.gates\[0\]\.treshold[\s\S]*threshold/,
    );
  });

  it("P5-M2-05: sha256 is the SHA-256 of the base file's bytes", async () => {
    serveBaseFile(STRICT, "a".repeat(40));
    serveHeadTree("a".repeat(40));

    const loaded = await loadBaseConfig(client(), REPO, SHAS, PATH);

    expect(loaded.sha256).toBe(
      createHash("sha256").update(STRICT, "utf8").digest("hex"),
    );
  });

  it("P5-M2-06: the PR comment says when the PR changes the config", () => {
    const report = JSON.parse(
      readFileSync(join(repoRoot, "test/__snapshots__/P4-M1.full-report.json"), "utf8"),
    ) as Report;

    expect(renderMarkdown(report, { variant: "comment" })).not.toContain(
      "changes the config",
    );

    report.config.changedInPr = true;
    expect(renderMarkdown(report, { variant: "comment" })).toContain(
      "> ℹ️ This pull request changes the config file .github/ai-provenance.yml. It was judged by the version on the base branch.",
    );
  });
});
