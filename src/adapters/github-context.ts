import * as core from "@actions/core";
import * as github from "@actions/github";

export function getGithubContext(): typeof github.context {
  return github.context;
}

export function info(message: string): void {
  core.info(message);
}
