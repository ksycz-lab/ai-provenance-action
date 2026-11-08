import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/adapters/run.js";
import { reportSchema } from "../src/core/build-report.js";
import { COMMENT_MARKER } from "../src/core/render-markdown.js";
import {
  API,
  BASE,
  LABEL_GATE,
  resetWorkspace,
  serveConfig,
  serveNoConfig,
  servePr,
  setup,
} from "./helpers/action-harness.js";

let workspace: string;

type ApiComment = { id: number; body: string; user: { login: string; type: string } };

const bot = (id: number, body: string): ApiComment => ({
  id,
  body,
  user: { login: "github-actions[bot]", type: "Bot" },
});
const human = (id: number, login: string, body: string): ApiComment => ({
  id,
  body,
  user: { login, type: "User" },
});

/** GET /user: a PAT gets its login; the workflow GITHUB_TOKEN gets 403. */
function serveIdentity(login: string | null): void {
  const scope = nock(API).get("/user");
  if (login === null) {
    scope.reply(403, { message: "Resource not accessible by integration" });
  } else {
    scope.reply(200, { login });
  }
}

/** GET /issues/42/comments, in pages of 100. */
function serveComments(comments: ApiComment[]): void {
  const path = `${BASE}/issues/42/comments`;
  const pages = Math.max(1, Math.ceil(comments.length / 100));
  for (let page = 1; page <= pages; page++) {
    nock(API)
      .get(path)
      .query(page === 1 ? { per_page: "100" } : { per_page: "100", page: String(page) })
      .reply(
        200,
        comments.slice((page - 1) * 100, page * 100),
        page < pages
          ? { link: `<${API}${path}?per_page=100&page=${page + 1}>; rel="next"` }
          : {},
      );
  }
}

/** Captures the body of the comment the Action creates or updates. */
function captureWrite(method: "post" | "patch", path: string, status = 200) {
  const seen: { body?: string } = {};
  const matchBody = (body: { body: string }) => {
    seen.body = body.body;
    return true;
  };
  const scope = nock(API);
  const interceptor =
    method === "post" ? scope.post(path, matchBody) : scope.patch(path, matchBody);
  interceptor.reply(
    status,
    status < 300 ? { id: 1 } : { message: "Resource not accessible by integration" },
  );
  return seen;
}

const manyOthers = Array.from({ length: 100 }, (_, i) =>
  human(1000 + i, "reviewer", `LGTM ${i}`),
);

beforeEach(() => {
  nock.disableNetConnect();
  workspace = resetWorkspace();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("P5-M4 sticky PR comment and fork PRs", () => {
  it("P5-M4-01: with no existing comment, one is created", async () => {
    serveNoConfig();
    servePr({ ai: true });
    serveIdentity(null);
    serveComments([]);
    const created = captureWrite("post", `${BASE}/issues/42/comments`, 201);
    const { deps, rec } = setup({ prComment: true });

    await run(deps);

    expect(created.body?.startsWith(`${COMMENT_MARKER}\n✅ `)).toBe(true);
    expect(rec.failed).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });

  it("P5-M4-02: an existing marked comment is updated, found across paginated comments", async () => {
    serveNoConfig();
    servePr({ ai: true });
    serveIdentity(null);
    serveComments([...manyOthers, bot(7, `${COMMENT_MARKER}\n❌ old failure`)]);
    const updated = captureWrite("patch", `${BASE}/issues/comments/7`);
    const { deps, rec } = setup({ prComment: true });

    await run(deps);

    expect([...rec.warnings, ...rec.notices]).toEqual([]);
    expect(updated.body?.startsWith(`${COMMENT_MARKER}\n✅ `)).toBe(true);
    expect(nock.isDone()).toBe(true); // no POST was set up, so none was made
  });

  it("P5-M4-03: a marked comment by someone else is never edited", async () => {
    // GITHUB_TOKEN: only github-actions[bot] comments are ours.
    serveNoConfig();
    servePr({ ai: true });
    serveIdentity(null);
    serveComments([human(5, "mallory", `${COMMENT_MARKER}\nfake result`)]);
    const created = captureWrite("post", `${BASE}/issues/42/comments`, 201);
    await run(setup({ prComment: true }).deps);
    expect(created.body).toBeDefined();
    expect(nock.isDone()).toBe(true);

    // A personal token: the identity comes from GET /user.
    serveNoConfig();
    servePr({ ai: true });
    serveIdentity("ksycz-bot");
    serveComments([
      bot(6, `${COMMENT_MARKER}\nposted by another workflow`),
      human(8, "ksycz-bot", `${COMMENT_MARKER}\n❌ old`),
    ]);
    const updated = captureWrite("patch", `${BASE}/issues/comments/8`);
    await run(setup({ prComment: true }).deps);
    expect(updated.body).toBeDefined();
    expect(nock.isDone()).toBe(true);
  });

  it("P5-M4-04: a 403 on the comment gives a notice and leaves the verdict alone", async () => {
    serveConfig(LABEL_GATE("enforce"));
    servePr({ ai: true, fork: true });
    serveIdentity(null);
    serveComments([]);
    captureWrite("post", `${BASE}/issues/42/comments`, 403);
    const { deps, rec } = setup({ prComment: true });

    await run(deps);

    expect(rec.notices).toEqual([
      "Skipped the PR comment: the token cannot write to this pull request (pull requests from forks get a read-only token). The job summary and the report artifact are still available.",
    ]);
    expect(rec.outputs.verdict).toBe("fail");
    expect(rec.failed).toEqual([
      "AI provenance verdict: fail. See the job summary for the gates that failed.",
    ]);
    expect(rec.summaries).toHaveLength(1);
    expect(rec.uploads).toHaveLength(1);
  });

  it("P5-M4-05: a fork PR is recorded in the report", async () => {
    serveNoConfig();
    servePr({ ai: true, fork: true });
    const fork = setup();
    await run(fork.deps);
    const forkReport = JSON.parse(
      readFileSync(join(workspace, "ai-provenance-report.json"), "utf8"),
    );

    serveNoConfig();
    servePr({ ai: true });
    const same = setup();
    await run(same.deps);
    const sameReport = JSON.parse(
      readFileSync(join(workspace, "ai-provenance-report.json"), "utf8"),
    );

    expect(forkReport.pullRequest.isFork).toBe(true);
    expect(sameReport.pullRequest.isFork).toBe(false);
    const validate = new Ajv2020({ strict: true }).compile(reportSchema);
    expect(validate(forkReport), JSON.stringify(validate.errors)).toBe(true);
  });

  it("P5-M4-06: a no-AI PR updates an existing comment to the short version", async () => {
    serveNoConfig();
    servePr({ ai: false });
    serveIdentity(null);
    serveComments([bot(9, `${COMMENT_MARKER}\n❌ **AI provenance: Fail**: stale`)]);
    const updated = captureWrite("patch", `${BASE}/issues/comments/9`);

    await run(setup({ prComment: true }).deps);

    expect(updated.body).toMatch(
      new RegExp(`^${COMMENT_MARKER}\\n✅ .*no AI-assisted commits[^\\n]*\\n$`),
    );
  });

  it("P5-M4-07: no comment is created for a no-AI PR, and none at all when pr-comment is false", async () => {
    serveNoConfig();
    servePr({ ai: false });
    serveIdentity(null);
    serveComments([human(3, "reviewer", "LGTM")]);
    const quiet = setup({ prComment: true });
    await run(quiet.deps);
    expect(nock.isDone()).toBe(true);
    expect([...quiet.rec.warnings, ...quiet.rec.notices]).toEqual([]); // no POST was attempted

    serveNoConfig();
    servePr({ ai: true });
    const { deps, rec } = setup({ prComment: false });
    await run(deps);
    expect(rec.failed).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });
});
