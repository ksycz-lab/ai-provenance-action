import { describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: { repo: { owner: "ksycz", repo: "ai-provenance-action" } },
}));

import * as core from "@actions/core";
import { getGithubContext, info } from "../src/adapters/github-context.js";

describe("adapters/github-context", () => {
  it("forwards info to @actions/core", () => {
    info("hello");
    expect(core.info).toHaveBeenCalledWith("hello");
  });

  it("returns GitHub context", () => {
    expect(getGithubContext().repo.repo).toBe("ai-provenance-action");
  });
});
