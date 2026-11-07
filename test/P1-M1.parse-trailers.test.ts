import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTrailers } from "../src/core/parse-trailers.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/commits");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("P1-M1 trailer parsing", () => {
  it("P1-M1-01: a single trailer in the last paragraph is returned as { key, value }", () => {
    const message = "Fix the cart.\n\nCo-authored-by: Claude <noreply@anthropic.com>\n";
    expect(parseTrailers(message)).toEqual([
      { key: "Co-authored-by", value: "Claude <noreply@anthropic.com>" },
    ]);
  });

  it("P1-M1-02: several trailers in the last paragraph are returned in order", () => {
    const message = [
      "Fix the cart.",
      "",
      "Signed-off-by: Ada <ada@example.com>",
      "Co-authored-by: Claude <noreply@anthropic.com>",
      "Reviewed-by: Jana <jana@example.com>",
    ].join("\n");
    expect(parseTrailers(message)).toEqual([
      { key: "Signed-off-by", value: "Ada <ada@example.com>" },
      { key: "Co-authored-by", value: "Claude <noreply@anthropic.com>" },
      { key: "Reviewed-by", value: "Jana <jana@example.com>" },
    ]);
  });

  it("P1-M1-03: a Key: value line in a middle paragraph is ignored", () => {
    const message = [
      "Fix the cart.",
      "",
      "Co-authored-by: Copilot suggested this in the body.",
      "That line is prose, not the trailer block.",
      "",
      "More discussion with no trailers at the end.",
    ].join("\n");
    expect(parseTrailers(message)).toEqual([]);
  });

  it("P1-M1-04: a message with no blank line (subject only) returns no trailers", () => {
    expect(parseTrailers("Fix the cart.")).toEqual([]);
    expect(
      parseTrailers("Fix the cart.\nCo-authored-by: Claude <noreply@anthropic.com>"),
    ).toEqual([]);
  });

  it("P1-M1-05: CRLF line endings parse the same as LF", () => {
    const lf = "Fix the cart.\n\nCo-authored-by: Claude <noreply@anthropic.com>\n";
    const crlf = lf.replaceAll("\n", "\r\n");
    const cr = lf.replaceAll("\n", "\r");
    expect(parseTrailers(crlf)).toEqual(parseTrailers(lf));
    expect(parseTrailers(cr)).toEqual(parseTrailers(lf));
  });

  it("P1-M1-06: leading and trailing whitespace around key and value is trimmed", () => {
    const message = "Fix the cart.\n\nCo-authored-by:   Claude   \n";
    expect(parseTrailers(message)).toEqual([
      { key: "Co-authored-by", value: "Claude" },
    ]);
  });

  it("P1-M1-07: a mixed last paragraph is not treated as a trailer block", () => {
    const message = [
      "Fix the cart.",
      "",
      "Please review this change.",
      "Co-authored-by: Copilot suggested this",
      "and several more prose lines",
      "that keep talking",
      "so the ratio of trailers stays below 25%.",
    ].join("\n");
    expect(parseTrailers(message)).toEqual([]);

    // Git-generated `Signed-off-by: ` plus ≥ 25% trailer lines: still a block.
    const gitGeneratedMix = [
      "Fix the cart.",
      "",
      "Signed-off-by: Ada <ada@example.com>",
      "please also check the tests",
    ].join("\n");
    expect(parseTrailers(gitGeneratedMix)).toEqual([
      { key: "Signed-off-by", value: "Ada <ada@example.com>" },
    ]);

    const orphanContinuation = [
      "Fix the cart.",
      "",
      "  not a trailer by itself",
      "Co-authored-by: Claude <noreply@anthropic.com>",
    ].join("\n");
    expect(parseTrailers(orphanContinuation)).toEqual([]);
  });

  it("P1-M1-08: a continuation line is appended to the previous trailer value", () => {
    const message = [
      "Fix the cart.",
      "",
      "Co-authored-by: Claude",
      "  Opus 5.5 <noreply@anthropic.com>",
    ].join("\n");
    expect(parseTrailers(message)).toEqual([
      { key: "Co-authored-by", value: "Claude Opus 5.5 <noreply@anthropic.com>" },
    ]);

    const emptyThenFold = [
      "Fix the cart.",
      "",
      "Co-authored-by:",
      "\tKateřina Sýkorová <katerina@example.com>",
    ].join("\n");
    expect(parseTrailers(emptyThenFold)).toEqual([
      { key: "Co-authored-by", value: "Kateřina Sýkorová <katerina@example.com>" },
    ]);
  });

  it("P1-M1-09: Unicode in values is preserved", () => {
    const message =
      "Fix the cart.\n\nCo-authored-by: Kateřina Sýkorová <katerina@example.com>\n";
    expect(parseTrailers(message)).toEqual([
      { key: "Co-authored-by", value: "Kateřina Sýkorová <katerina@example.com>" },
    ]);
  });

  it("P1-M1-10: a 1 MB message is parsed in under 50 ms", () => {
    const body = "x".repeat(1_000_000);
    const message = `Fix the cart.\n\n${body}\n\nCo-authored-by: Claude <noreply@anthropic.com>\n`;
    const start = performance.now();
    const trailers = parseTrailers(message);
    const elapsed = performance.now() - start;
    expect(trailers).toEqual([
      { key: "Co-authored-by", value: "Claude <noreply@anthropic.com>" },
    ]);
    expect(elapsed).toBeLessThan(50);
  });

  it("real-world Claude Code, Copilot and Cursor fixtures parse", () => {
    expect(parseTrailers(fixture("claude-code.txt"))).toEqual([
      { key: "Co-Authored-By", value: "Claude Opus 4.5 <noreply@anthropic.com>" },
    ]);
    expect(parseTrailers(fixture("copilot.txt"))).toEqual([
      { key: "Co-authored-by", value: "GitHub Copilot <copilot@github.com>" },
    ]);
    expect(parseTrailers(fixture("cursor.txt"))).toEqual([
      { key: "Assisted-by", value: "Cursor" },
      { key: "Generated-by", value: "Composer" },
    ]);
  });
});
