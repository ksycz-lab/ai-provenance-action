import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateAiChanges,
  mapChanges,
  type CommitFile,
  type FileChange,
} from "../src/core/map-changes.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/patches");

function file(partial: CommitFile): CommitFile {
  return partial;
}

describe("P1-M3 diff to files and lines", () => {
  it("P1-M3-01: a single hunk @@ -0,0 +1,5 @@ yields added range 1-5", () => {
    const patch = ["@@ -0,0 +1,5 @@", "+one", "+two", "+three", "+four", "+five"].join(
      "\n",
    );
    expect(
      mapChanges([file({ filename: "src/new.ts", status: "added", patch })]),
    ).toEqual([{ path: "src/new.ts", status: "added", lines: [{ start: 1, end: 5 }] }]);
  });

  it("P1-M3-02: multiple hunks yield multiple ranges, with context lines excluded", () => {
    const patch = [
      "@@ -10,6 +10,7 @@ export function a() {",
      "   const x = 1",
      "   const y = 2",
      "+  const z = 3",
      "   return x + y",
      " }",
      "@@ -40,4 +41,6 @@ export function b() {",
      "   return 1",
      "+  // keep",
      "+  // going",
      " }",
    ].join("\n");
    expect(
      mapChanges([file({ filename: "src/cart.ts", status: "modified", patch })]),
    ).toEqual([
      {
        path: "src/cart.ts",
        status: "modified",
        lines: [
          { start: 12, end: 12 },
          { start: 42, end: 43 },
        ],
      },
    ]);
  });

  it("P1-M3-03: a deletion-only hunk yields no added ranges but the file is still listed", () => {
    const patch = ["@@ -10,3 +10,0 @@", "-gone", "-also", "-this"].join("\n");
    expect(
      mapChanges([file({ filename: "src/cart.ts", status: "modified", patch })]),
    ).toEqual([{ path: "src/cart.ts", status: "modified", lines: [] }]);
  });

  it("P1-M3-04: a removed file is listed with status removed and no ranges", () => {
    expect(
      mapChanges([
        file({
          filename: "src/old.ts",
          status: "removed",
          patch: "@@ -1,2 +0,0 @@\n-a\n-b",
        }),
      ]),
    ).toEqual([{ path: "src/old.ts", status: "removed", lines: [] }]);
  });

  it("P1-M3-05: a renamed file keeps previousFilename", () => {
    expect(
      mapChanges([
        file({
          filename: "src/cart.ts",
          status: "renamed",
          previous_filename: "src/basket.ts",
          patch: "@@ -1,1 +1,2 @@\n export const n = 1\n+export const m = 2\n",
        }),
      ]),
    ).toEqual([
      {
        path: "src/cart.ts",
        status: "renamed",
        previousFilename: "src/basket.ts",
        lines: [{ start: 2, end: 2 }],
      },
    ]);
  });

  it("P1-M3-06: a binary file or one without patch is listed with lines unknown", () => {
    expect(
      mapChanges([
        file({ filename: "icon.png", status: "added" }),
        file({ filename: "huge.ts", status: "modified" }),
      ]),
    ).toEqual([
      { path: "huge.ts", status: "modified", lines: "unknown" },
      { path: "icon.png", status: "added", lines: "unknown" },
    ]);
  });

  it("P1-M3-07: overlapping and adjacent ranges from two AI commits on the same file are merged", () => {
    const first: FileChange[] = [
      {
        path: "src/cart.ts",
        status: "modified",
        lines: [
          { start: 10, end: 24 },
          { start: 40, end: 41 },
        ],
      },
    ];
    const second: FileChange[] = [
      {
        path: "src/cart.ts",
        status: "modified",
        lines: [
          { start: 22, end: 30 },
          { start: 42, end: 45 },
        ],
      },
    ];
    expect(aggregateAiChanges([first, second])).toEqual([
      {
        path: "src/cart.ts",
        status: "modified",
        lines: [
          { start: 10, end: 30 },
          { start: 40, end: 45 },
        ],
      },
    ]);

    const withUnknown = aggregateAiChanges([
      first,
      [
        {
          path: "src/cart.ts",
          status: "renamed",
          previousFilename: "src/bag.ts",
          lines: "unknown",
        },
      ],
    ]);
    expect(withUnknown).toEqual([
      {
        path: "src/cart.ts",
        status: "renamed",
        previousFilename: "src/bag.ts",
        lines: "unknown",
      },
    ]);
  });

  it("P1-M3-08: No newline at end of file markers do not shift line numbers", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "+tail",
    ].join("\n");
    expect(
      mapChanges([file({ filename: "src/cart.ts", status: "modified", patch })]),
    ).toEqual([
      {
        path: "src/cart.ts",
        status: "modified",
        lines: [{ start: 2, end: 3 }],
      },
    ]);
  });

  it("P1-M3-09: files are sorted by path for deterministic output", () => {
    const files = [
      file({ filename: "z.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+z\n" }),
      file({ filename: "a.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+a\n" }),
      file({ filename: "m.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+m\n" }),
    ];
    const once = mapChanges(files);
    const twice = mapChanges([...files].reverse());
    expect(once.map((f) => f.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it("maps a fixture recorded from GitHub REST-shaped commit files", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtures, "commit-files.rest.json"), "utf8"),
    ) as CommitFile[];
    const mapped = mapChanges(raw);
    expect(mapped.map((f) => f.path)).toEqual(["docs/README.md", "src/cart.ts"]);
    expect(mapped[0]?.previousFilename).toBe("README.md");
    expect(mapped[1]?.lines).toEqual([{ start: 10, end: 11 }]);
  });
});
