/** One added-line span on the new-file side of a unified diff. Inclusive. */
export type LineRange = {
  start: number;
  end: number;
};

export type FileStatus =
  "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";

/** One file from GET /repos/.../commits/{sha} (the `files[]` entries). */
export type CommitFile = {
  filename: string;
  status: FileStatus;
  patch?: string;
  previous_filename?: string;
};

export type FileChange = {
  path: string;
  status: FileStatus;
  previousFilename?: string;
  lines: LineRange[] | "unknown";
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

function addedRangesFromPatch(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  let newLine = 0;
  let runStart: number | undefined;

  const endRun = (): void => {
    if (runStart !== undefined) {
      ranges.push({ start: runStart, end: newLine - 1 });
      runStart = undefined;
    }
  };

  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      endRun();
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+")) {
      if (runStart === undefined) {
        runStart = newLine;
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      endRun();
      continue;
    }
    endRun();
    if (line.startsWith(" ") || line.length === 0) {
      if (newLine > 0) {
        newLine += 1;
      }
    }
  }
  endRun();
  return mergeRanges(ranges);
}

function mapOne(file: CommitFile): FileChange {
  const lines: FileChange["lines"] =
    file.status === "removed"
      ? []
      : file.patch === undefined
        ? "unknown"
        : addedRangesFromPatch(file.patch);
  return {
    path: file.filename,
    status: file.status,
    ...(file.previous_filename ? { previousFilename: file.previous_filename } : {}),
    lines,
  };
}

export function mapChanges(commitFiles: CommitFile[]): FileChange[] {
  return [...commitFiles]
    .map(mapOne)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Merge file changes from AI-tagged commits (oldest first).
 * Ranges on the same path are unioned; later status and rename win.
 */
export function aggregateAiChanges(perCommit: FileChange[][]): FileChange[] {
  const byPath = new Map<string, FileChange>();

  for (const files of perCommit) {
    for (const file of files) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, {
          path: file.path,
          status: file.status,
          ...(file.previousFilename ? { previousFilename: file.previousFilename } : {}),
          lines: file.lines === "unknown" ? "unknown" : mergeRanges(file.lines),
        });
        continue;
      }
      existing.status = file.status;
      if (file.previousFilename) {
        existing.previousFilename = file.previousFilename;
      }
      if (existing.lines === "unknown" || file.lines === "unknown") {
        existing.lines = "unknown";
      } else {
        existing.lines = mergeRanges([...existing.lines, ...file.lines]);
      }
    }
  }

  return [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
