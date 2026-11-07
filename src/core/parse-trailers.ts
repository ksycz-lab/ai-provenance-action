/**
 * Extract Git-style trailers from a commit message.
 * Matches git interpret-trailers --parse (Git 2.50).
 */

export type Trailer = {
  key: string;
  value: string;
};

const GIT_GENERATED_PREFIXES = [
  "Signed-off-by: ",
  "(cherry picked from commit ",
] as const;

function normalizeNewlines(message: string): string {
  return message.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isGitGenerated(line: string): boolean {
  return GIT_GENERATED_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/** Key: no leading/internal whitespace; optional space before colon. */
function parseTrailerLine(line: string): Trailer | undefined {
  if (line.length === 0 || line[0] === " " || line[0] === "\t") {
    return undefined;
  }
  const match = /^([^ \t:]+)[ \t]*:(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  return { key: match[1].trim(), value: match[2].trim() };
}

function isContinuation(line: string): boolean {
  return line.length > 0 && (line[0] === " " || line[0] === "\t");
}

function classifyBlock(lines: string[]): {
  trailers: number;
  nonTrailers: number;
  recognizedPrefix: boolean;
} {
  let trailers = 0;
  let nonTrailers = 0;
  let seenTrailer = false;
  let recognizedPrefix = false;

  for (const line of lines) {
    if (isGitGenerated(line) || parseTrailerLine(line)) {
      trailers += 1;
      seenTrailer = true;
      if (isGitGenerated(line)) {
        recognizedPrefix = true;
      }
      continue;
    }
    if (isContinuation(line)) {
      if (!seenTrailer) {
        nonTrailers += 1;
      }
      continue;
    }
    nonTrailers += 1;
  }
  return { trailers, nonTrailers, recognizedPrefix };
}

function isTrailerBlock(lines: string[]): boolean {
  const { trailers, nonTrailers, recognizedPrefix } = classifyBlock(lines);
  if (trailers > 0 && nonTrailers === 0) {
    return true;
  }
  // Git: trailer_lines * 3 >= non_trailer_lines  (at least 25% trailers)
  return recognizedPrefix && trailers * 3 >= nonTrailers;
}

function extractTrailers(lines: string[]): Trailer[] {
  const result: Trailer[] = [];
  for (const line of lines) {
    const parsed = parseTrailerLine(line);
    if (parsed) {
      result.push(parsed);
      continue;
    }
    if (isContinuation(line) && result.length > 0) {
      const previous = result[result.length - 1];
      const extra = line.trim();
      previous.value = previous.value ? `${previous.value} ${extra}` : extra;
    }
  }
  return result;
}

export function parseTrailers(message: string): Trailer[] {
  const lines = normalizeNewlines(message).split("\n");

  while (lines.length > 0 && isBlank(lines[lines.length - 1])) {
    lines.pop();
  }

  const titleEnd = lines.findIndex((line) => isBlank(line));
  if (titleEnd === -1) {
    return [];
  }

  let blockStart = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isBlank(lines[i])) {
      blockStart = i + 1;
      break;
    }
  }

  const block = lines.slice(blockStart);
  if (!isTrailerBlock(block)) {
    return [];
  }
  return extractTrailers(block);
}
