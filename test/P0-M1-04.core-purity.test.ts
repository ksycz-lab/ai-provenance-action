import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P0-M1-04", () => {
  it("dependency-cruiser config forbids core → actions/fs/adapters", () => {
    const configPath = join(process.cwd(), ".dependency-cruiser.cjs");
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("core-stays-pure");
    expect(text).toContain("src/core");
    expect(text).toContain("@actions/");
  });
});
