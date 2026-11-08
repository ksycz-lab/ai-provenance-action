import { createHash } from "node:crypto";
import { loadConfig, type Config, type ConfigError } from "../core/load-config.js";
import type { FetchOptions, GitHubClient } from "./fetch-pull-request.js";
import { realSleep, withRetry } from "./retry.js";

export type BaseConfig = {
  config: Config;
  source: "base-branch" | "defaults";
  path: string;
  /** SHA-256 of the base file's bytes, so an auditor can match the exact policy. */
  sha256: string | null;
  /** The PR adds, edits or deletes the config file. It is still judged by the base version. */
  changedInPr: boolean;
};

type Repo = { owner: string; repo: string };

function isNotFound(error: unknown): boolean {
  return (error as { status?: number })?.status === 404;
}

/** The base branch's config file: its bytes and Git blob SHA, or undefined when absent. */
async function readBaseFile(
  client: GitHubClient,
  repo: Repo,
  path: string,
  baseSha: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ bytes: Buffer; blobSha: string } | undefined> {
  let data: unknown;
  try {
    ({ data } = await withRetry(
      () => client.rest.repos.getContent({ ...repo, path, ref: baseSha }),
      sleep,
    ));
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  const file = data as { type?: string; content?: string; sha?: string };
  if (Array.isArray(data) || file.type !== "file" || file.content === undefined) {
    throw new Error(`Config path ${path} on the base branch is not a file`);
  }
  return { bytes: Buffer.from(file.content, "base64"), blobSha: file.sha ?? "" };
}

/**
 * The blob SHA of `path` at the head commit, found by walking Git trees one directory
 * at a time. Only tree metadata is read: the head version's content is never fetched,
 * so it can never be parsed or used as the policy.
 */
async function headBlobSha(
  client: GitHubClient,
  repo: Repo,
  path: string,
  headSha: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  let treeSha = headSha;
  for (const [index, segment] of segments.entries()) {
    const { data } = await withRetry(
      () => client.rest.git.getTree({ ...repo, tree_sha: treeSha }),
      sleep,
    );
    const entry = data.tree.find((item) => item.path === segment);
    const last = index === segments.length - 1;
    if (entry?.sha === undefined || entry.type !== (last ? "blob" : "tree")) {
      return undefined;
    }
    if (last) {
      return entry.sha;
    }
    treeSha = entry.sha;
  }
  return undefined;
}

function formatErrors(path: string, baseSha: string, errors: ConfigError[]): string {
  const lines = errors.map(
    (e) =>
      `- ${e.path}: ${e.message}${e.suggestion ? ` (did you mean '${e.suggestion}'?)` : ""}`,
  );
  return [
    `Invalid config ${path} on the base branch (${baseSha.slice(0, 7)}):`,
    ...lines,
  ].join("\n");
}

/**
 * Loads the policy from the PR's base commit (GET /contents/{path}?ref=<base sha>), so a
 * pull request, including one from a fork, cannot weaken the policy that judges it.
 * A missing file means the built-in defaults; an invalid file fails the job.
 */
export async function loadBaseConfig(
  client: GitHubClient,
  repo: Repo,
  shas: { baseSha: string; headSha: string },
  path: string,
  options: FetchOptions = {},
): Promise<BaseConfig> {
  const sleep = options.sleep ?? realSleep;
  const base = await readBaseFile(client, repo, path, shas.baseSha, sleep);
  const head = await headBlobSha(client, repo, path, shas.headSha, sleep);
  const changedInPr = head !== base?.blobSha;

  if (base === undefined) {
    const defaults = loadConfig(undefined);
    if (!defaults.ok) {
      throw new Error("built-in default config is invalid");
    }
    return {
      config: defaults.value,
      source: "defaults",
      path,
      sha256: null,
      changedInPr,
    };
  }

  const result = loadConfig(base.bytes.toString("utf8"));
  if (!result.ok) {
    throw new Error(formatErrors(path, shas.baseSha, result.error));
  }
  return {
    config: result.value,
    source: "base-branch",
    path,
    sha256: createHash("sha256").update(base.bytes).digest("hex"),
    changedInPr,
  };
}
