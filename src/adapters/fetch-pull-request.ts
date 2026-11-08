import type { getOctokit } from "@actions/github";
import { classifyCommits, type Classification } from "../core/classify-commits.js";
import type { ReviewInput } from "../core/evaluate-policy.js";
import type { Config } from "../core/load-config.js";
import type { CommitFile } from "../core/map-changes.js";
import { realSleep, withRetry } from "./retry.js";

export type GitHubClient = ReturnType<typeof getOctokit>;

export type PullRequestRef = { owner: string; repo: string; number: number };

export type EventContext = {
  eventName: string;
  repo: { owner: string; repo: string };
  payload: { pull_request?: { number: number } };
};

export type PullRequestData = {
  pullRequest: {
    number: number;
    url: string;
    baseSha: string;
    headSha: string;
    author: string | null;
    isFork: boolean;
  };
  labels: string[];
  commits: { sha: string; author: string | null; message: string }[];
  classification: Classification;
  /** One file list per AI-tagged commit, in commit order. Empty when nothing is tagged. */
  commitFiles: CommitFile[][];
  reviews: ReviewInput[];
  truncated: { commits: boolean; files: boolean };
};

export type FetchOptions = { sleep?: (ms: number) => Promise<void> };

/** Owner, repo and PR number from the workflow event; anything but a PR event fails fast. */
export function pullRequestRef(context: EventContext): PullRequestRef {
  const number = context.payload.pull_request?.number;
  if (number === undefined) {
    throw new Error(
      `this Action needs a pull_request event (got '${context.eventName}')`,
    );
  }
  return { owner: context.repo.owner, repo: context.repo.repo, number };
}

function nextLink(headers: Record<string, unknown>): string | undefined {
  const link = headers.link;
  if (typeof link !== "string") {
    return undefined;
  }
  return /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
}

type ApiFile = {
  filename: string;
  status: string;
  patch?: string;
  previous_filename?: string;
};

/** One page of GET /commits/{sha}: only the parts this adapter reads. */
type FilesPage = { data: { files?: ApiFile[] }; headers: Record<string, unknown> };

function toCommitFile(file: ApiFile): CommitFile {
  return {
    filename: file.filename,
    status: file.status as CommitFile["status"],
    ...(file.patch !== undefined ? { patch: file.patch } : {}),
    ...(file.previous_filename !== undefined
      ? { previous_filename: file.previous_filename }
      : {}),
  };
}

/**
 * Fetches files for each AI-tagged commit (GET /commits/{sha}, following pagination past
 * 300 files) until `maxFiles` files in total have been read.
 */
async function fetchCommitFiles(
  client: GitHubClient,
  ref: PullRequestRef,
  shas: string[],
  maxFiles: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ files: CommitFile[][]; truncated: boolean }> {
  const files: CommitFile[][] = [];
  let total = 0;
  let truncated = false;
  for (const sha of shas) {
    const list: CommitFile[] = [];
    files.push(list);
    if (truncated) {
      continue;
    }
    let response: FilesPage = await withRetry(
      () => client.rest.repos.getCommit({ owner: ref.owner, repo: ref.repo, ref: sha }),
      sleep,
    );
    for (;;) {
      for (const file of response.data.files ?? []) {
        if (total >= maxFiles) {
          truncated = true;
          break;
        }
        list.push(toCommitFile(file));
        total++;
      }
      const next = nextLink(response.headers);
      if (truncated || next === undefined) {
        break;
      }
      response = await withRetry(() => client.request(`GET ${next}`), sleep);
    }
  }
  return { files, truncated };
}

/**
 * Collects everything the core needs for one PR, REST only. A PR with no AI-tagged
 * commit costs two calls (the PR and one page of commits); files and reviews are
 * fetched only when something is tagged.
 */
export async function gatherPullRequestData(
  client: GitHubClient,
  ref: PullRequestRef,
  config: Config,
  options: FetchOptions = {},
): Promise<PullRequestData> {
  const sleep = options.sleep ?? realSleep;
  const { owner, repo, number } = ref;

  const { data: pr } = await withRetry(
    () => client.rest.pulls.get({ owner, repo, pull_number: number }),
    sleep,
  );
  const labels = pr.labels.map((label) => label.name);

  const listed = await withRetry(
    () =>
      client.paginate(client.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      }),
    sleep,
  );
  const commits = listed.slice(0, config.limits.maxCommits).map((c) => ({
    sha: c.sha,
    author: c.author?.login ?? c.commit.author?.name ?? null,
    message: c.commit.message,
  }));
  const truncatedCommits = pr.commits > commits.length;

  const classification = classifyCommits(commits, labels, config.detection);
  const taggedShas = classification.commits.filter((c) => c.aiTagged).map((c) => c.sha);

  let commitFiles: CommitFile[][] = [];
  let truncatedFiles = false;
  let reviews: ReviewInput[] = [];
  if (taggedShas.length > 0) {
    const fetched = await fetchCommitFiles(
      client,
      ref,
      taggedShas,
      config.limits.maxFiles,
      sleep,
    );
    commitFiles = fetched.files;
    truncatedFiles = fetched.truncated;
    const listedReviews = await withRetry(
      () =>
        client.paginate(client.rest.pulls.listReviews, {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
        }),
      sleep,
    );
    reviews = listedReviews.map((r) => ({
      state: r.state,
      submittedAt: r.submitted_at ?? "",
      user: r.user ? { login: r.user.login, type: r.user.type } : null,
    }));
  }

  return {
    pullRequest: {
      number: pr.number,
      url: pr.html_url,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      author: pr.user?.login ?? null,
      isFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
    },
    labels,
    commits,
    classification,
    commitFiles,
    reviews,
    truncated: { commits: truncatedCommits, files: truncatedFiles },
  };
}
