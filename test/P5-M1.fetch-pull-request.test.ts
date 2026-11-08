import { getOctokit } from "@actions/github";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gatherPullRequestData,
  pullRequestRef,
  type GitHubClient,
  type PullRequestRef,
} from "../src/adapters/fetch-pull-request.js";
import { DEFAULT_CONFIG, type Config } from "../src/core/load-config.js";

const API = "https://api.github.com";
const REF: PullRequestRef = { owner: "ksycz", repo: "demo-shop", number: 42 };
const BASE = `/repos/${REF.owner}/${REF.repo}`;

/** Every URL the client requested, in order. */
let calls: string[] = [];

/** A real Octokit from @actions/github; only its fetch is swapped so nock can see it. */
function client(): GitHubClient {
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return globalThis.fetch(input, init);
  };
  return getOctokit("test-token", { request: { fetch } });
}

const sha = (i: number) => i.toString(16).padStart(40, "0");

function apiCommit(i: number, message = `Change ${i}\n`) {
  return {
    sha: sha(i),
    commit: { message, author: { name: `Dev ${i}` } },
    author: { login: `dev${i}` },
  };
}

const aiMessage = (i: number) =>
  `AI change ${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`;

function pullRequest(totalCommits: number, labels: string[] = []) {
  return {
    number: REF.number,
    html_url: `https://github.com/${REF.owner}/${REF.repo}/pull/${REF.number}`,
    commits: totalCommits,
    user: { login: "ksycz" },
    labels: labels.map((name) => ({ name })),
    base: { sha: "b".repeat(40), repo: { full_name: "ksycz/demo-shop" } },
    head: { sha: "c".repeat(40), repo: { full_name: "ksycz/demo-shop" } },
  };
}

function link(path: string, page: number, perPage: number): Record<string, string> {
  return { link: `<${API}${path}?per_page=${perPage}&page=${page}>; rel="next"` };
}

/** Serves `commits` from GET /pulls/{n}/commits in pages of 100, as GitHub does. */
function serveCommits(commits: ReturnType<typeof apiCommit>[]): void {
  const path = `${BASE}/pulls/${REF.number}/commits`;
  const pages = Math.max(1, Math.ceil(commits.length / 100));
  for (let page = 1; page <= pages; page++) {
    nock(API)
      .get(path)
      .query(page === 1 ? { per_page: "100" } : { per_page: "100", page: String(page) })
      .reply(
        200,
        commits.slice((page - 1) * 100, page * 100),
        page < pages ? link(path, page + 1, 100) : {},
      );
  }
}

function fileList(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/file-${from + i}.ts`,
    status: "added",
    patch: "@@ -0,0 +1,2 @@\n+a\n+b",
  }));
}

function config(patch?: (c: Config) => void): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  patch?.(c);
  return c;
}

beforeEach(() => {
  calls = [];
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("P5-M1 REST data fetching with pagination and limits", () => {
  it("P5-M1-01: commits are fetched with per_page=100 across 3 pages", async () => {
    nock(API).get(`${BASE}/pulls/42`).reply(200, pullRequest(230));
    serveCommits(Array.from({ length: 230 }, (_, i) => apiCommit(i + 1)));

    const data = await gatherPullRequestData(client(), REF, config());

    expect(data.commits).toHaveLength(230);
    expect(data.commits[229]).toEqual({
      sha: sha(230),
      author: "dev230",
      message: "Change 230\n",
    });
    expect(data.truncated.commits).toBe(false);
    expect(calls.filter((u) => u.includes("/commits"))).toHaveLength(3);
    expect(nock.isDone()).toBe(true);
  });

  it("P5-M1-02: more than 250 commits sets truncated.commits, never silently drops", async () => {
    nock(API).get(`${BASE}/pulls/42`).reply(200, pullRequest(300));
    serveCommits(Array.from({ length: 250 }, (_, i) => apiCommit(i + 1))); // REST stops at 250

    const data = await gatherPullRequestData(client(), REF, config());

    expect(data.commits).toHaveLength(250);
    expect(data.truncated.commits).toBe(true);
  });

  it("P5-M1-03: commit files are fetched only for AI-tagged commits", async () => {
    // A no-AI PR: PR + one page of commits, nothing else (≤ 3 calls).
    nock(API).get(`${BASE}/pulls/42`).reply(200, pullRequest(2));
    serveCommits([apiCommit(1), apiCommit(2)]);

    const quiet = await gatherPullRequestData(client(), REF, config());

    expect(quiet.classification.commits.some((c) => c.aiTagged)).toBe(false);
    expect(quiet.commitFiles).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.some((u) => /\/commits\/[0-9a-f]{40}/.test(u))).toBe(false);

    // An AI PR: files only for the tagged commit, then the reviews.
    calls = [];
    nock(API).get(`${BASE}/pulls/42`).reply(200, pullRequest(2));
    serveCommits([apiCommit(1), apiCommit(2, aiMessage(2))]);
    nock(API)
      .get(`${BASE}/commits/${sha(2)}`)
      .reply(200, { sha: sha(2), files: fileList(0, 2) });
    nock(API)
      .get(`${BASE}/pulls/42/reviews`)
      .query({ per_page: "100" })
      .reply(200, [
        {
          state: "APPROVED",
          submitted_at: "2026-11-08T10:00:00Z",
          user: { login: "jana", type: "User" },
        },
      ]);

    const tagged = await gatherPullRequestData(client(), REF, config());

    expect(tagged.commitFiles).toEqual([
      [
        {
          filename: "src/file-0.ts",
          status: "added",
          patch: "@@ -0,0 +1,2 @@\n+a\n+b",
        },
        {
          filename: "src/file-1.ts",
          status: "added",
          patch: "@@ -0,0 +1,2 @@\n+a\n+b",
        },
      ],
    ]);
    expect(calls.filter((u) => /\/commits\/[0-9a-f]{40}/.test(u))).toEqual([
      `${API}${BASE}/commits/${sha(2)}`,
    ]);
    expect(tagged.reviews).toEqual([
      {
        state: "APPROVED",
        submittedAt: "2026-11-08T10:00:00Z",
        user: { login: "jana", type: "User" },
      },
    ]);
    expect(nock.isDone()).toBe(true);
  });

  it("P5-M1-04: a commit with more than 300 files is paginated; over max-files is flagged", async () => {
    const serveBigCommit = () => {
      const path = `${BASE}/commits/${sha(1)}`;
      nock(API)
        .get(path)
        .reply(200, { sha: sha(1), files: fileList(0, 300) }, link(path, 2, 300));
      nock(API)
        .get(path)
        .query({ per_page: "300", page: "2" })
        .reply(200, { sha: sha(1), files: fileList(300, 50) });
    };
    const servePr = () => {
      nock(API).get(`${BASE}/pulls/42`).reply(200, pullRequest(1));
      serveCommits([apiCommit(1, aiMessage(1))]);
      nock(API).get(`${BASE}/pulls/42/reviews`).query(true).reply(200, []);
    };

    servePr();
    serveBigCommit();
    const all = await gatherPullRequestData(client(), REF, config());
    expect(all.commitFiles[0]).toHaveLength(350);
    expect(all.truncated.files).toBe(false);

    servePr();
    serveBigCommit();
    const capped = await gatherPullRequestData(
      client(),
      REF,
      config((c) => {
        c.limits.maxFiles = 320;
      }),
    );
    expect(capped.commitFiles[0]).toHaveLength(320);
    expect(capped.truncated.files).toBe(true);
  });

  it("P5-M1-05: a secondary rate limit is retried once after retry-after, then fails clearly", async () => {
    const limited = {
      message:
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    };
    const sleep = vi.fn(async () => {});

    nock(API).get(`${BASE}/pulls/42`).reply(403, limited, { "retry-after": "7" });
    nock(API).get(`${BASE}/pulls/42`).reply(200, pullRequest(1));
    serveCommits([apiCommit(1)]);

    const data = await gatherPullRequestData(client(), REF, config(), { sleep });
    expect(data.commits).toHaveLength(1);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);

    nock(API)
      .get(`${BASE}/pulls/42`)
      .times(2)
      .reply(403, limited, { "retry-after": "7" });
    await expect(
      gatherPullRequestData(client(), REF, config(), { sleep }),
    ).rejects.toThrow(/secondary rate limit.*retried once.*re-run the job later/i);
  });

  it("P5-M1-08: other errors (404, a plain 403 without retry-after) are not retried", async () => {
    const sleep = vi.fn(async () => {});

    nock(API).get(`${BASE}/pulls/42`).reply(404, { message: "Not Found" });
    await expect(
      gatherPullRequestData(client(), REF, config(), { sleep }),
    ).rejects.toMatchObject({
      status: 404,
    });

    nock(API)
      .get(`${BASE}/pulls/42`)
      .reply(403, { message: "Resource not accessible by integration" });
    await expect(
      gatherPullRequestData(client(), REF, config(), { sleep }),
    ).rejects.toMatchObject({
      status: 403,
    });

    // Only 403 and 429 are rate limits, even when another status carries retry-after.
    nock(API)
      .get(`${BASE}/pulls/42`)
      .reply(404, { message: "Not Found" }, { "retry-after": "7" });
    await expect(
      gatherPullRequestData(client(), REF, config(), { sleep }),
    ).rejects.toMatchObject({
      status: 404,
    });

    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(3);
  });

  it("P5-M1-09: once max-files is reached, later AI-tagged commits are not fetched", async () => {
    nock(API).get(`${BASE}/pulls/42`).reply(200, pullRequest(2));
    serveCommits([apiCommit(1, aiMessage(1)), apiCommit(2, aiMessage(2))]);
    nock(API)
      .get(`${BASE}/commits/${sha(1)}`)
      .reply(200, { sha: sha(1), files: fileList(0, 5) });
    nock(API).get(`${BASE}/pulls/42/reviews`).query(true).reply(200, []);

    const data = await gatherPullRequestData(
      client(),
      REF,
      config((c) => {
        c.limits.maxFiles = 3;
      }),
    );

    expect(data.commitFiles.map((files) => files.length)).toEqual([3, 0]);
    expect(data.truncated.files).toBe(true);
    expect(calls.some((u) => u.endsWith(`/commits/${sha(2)}`))).toBe(false);
  });

  it("P5-M1-06: a non-PR event fails fast with a clear message", () => {
    expect(() =>
      pullRequestRef({
        eventName: "push",
        repo: { owner: "ksycz", repo: "demo-shop" },
        payload: {},
      }),
    ).toThrow("this Action needs a pull_request event (got 'push')");

    expect(
      pullRequestRef({
        eventName: "pull_request",
        repo: { owner: "ksycz", repo: "demo-shop" },
        payload: { pull_request: { number: 42 } },
      }),
    ).toEqual(REF);
  });

  it("P5-M1-07: no GraphQL endpoint is ever called", async () => {
    const graphql = nock(API).post("/graphql").reply(200, {});
    nock(API)
      .get(`${BASE}/pulls/42`)
      .reply(200, pullRequest(1, ["ai-assisted"]));
    serveCommits([apiCommit(1)]);
    nock(API)
      .get(`${BASE}/commits/${sha(1)}`)
      .reply(200, { sha: sha(1), files: fileList(0, 1) });
    nock(API).get(`${BASE}/pulls/42/reviews`).query(true).reply(200, []);

    const data = await gatherPullRequestData(client(), REF, config());

    expect(data.labels).toEqual(["ai-assisted"]);
    expect(graphql.isDone()).toBe(false);
    expect(calls.some((u) => u.includes("/graphql"))).toBe(false);
  });
});
