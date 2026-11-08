import { COMMENT_MARKER } from "../core/render-markdown.js";
import type { GitHubClient, PullRequestRef } from "./fetch-pull-request.js";
import { realSleep, withRetry } from "./retry.js";

/** Who comments when the token is the workflow's own GITHUB_TOKEN. */
export const ACTIONS_BOT_LOGIN = "github-actions[bot]";

export type CommentOutcome = "created" | "updated" | "skipped";

/**
 * The login that owns the token. A personal access token can read it from GET /user;
 * the workflow's GITHUB_TOKEN cannot (403) and always comments as github-actions[bot].
 */
async function tokenLogin(
  client: GitHubClient,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  try {
    const { data } = await withRetry(() => client.rest.users.getAuthenticated(), sleep);
    return data.login;
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403 || status === 404) {
      return ACTIONS_BOT_LOGIN;
    }
    throw error;
  }
}

/**
 * Creates or updates the one sticky comment on the PR. A comment is ours only when it
 * starts with the hidden marker AND was written by the token's own identity, so a
 * comment someone else wrote with the marker text is never edited.
 */
export async function upsertComment(
  client: GitHubClient,
  ref: PullRequestRef,
  body: string,
  options: { createIfMissing: boolean; sleep?: (ms: number) => Promise<void> },
): Promise<CommentOutcome> {
  const sleep = options.sleep ?? realSleep;
  const { owner, repo, number } = ref;
  const login = await tokenLogin(client, sleep);
  const comments = await withRetry(
    () =>
      client.paginate(client.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      }),
    sleep,
  );
  const ours = comments.find(
    (c) => c.user?.login === login && (c.body ?? "").startsWith(COMMENT_MARKER),
  );

  if (ours !== undefined) {
    await withRetry(
      () =>
        client.rest.issues.updateComment({ owner, repo, comment_id: ours.id, body }),
      sleep,
    );
    return "updated";
  }
  if (!options.createIfMissing) {
    return "skipped";
  }
  await withRetry(
    () => client.rest.issues.createComment({ owner, repo, issue_number: number, body }),
    sleep,
  );
  return "created";
}
