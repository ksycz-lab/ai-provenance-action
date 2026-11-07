import { describe, expect, it } from "vitest";
import { ACTION_NAME, actionVersion } from "../src/core/version.js";

describe("P0-M1-01", () => {
  it("smoke: core exports are reachable", () => {
    expect(ACTION_NAME).toBe("ai-provenance-action");
    expect(actionVersion()).toBe("0.0.0");
    expect(actionVersion("1.0.0")).toBe("1.0.0");
  });
});
