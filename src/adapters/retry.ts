/** Shared GitHub REST helpers for the adapters. */

const DEFAULT_RETRY_AFTER_SECONDS = 60;

export const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type HttpError = {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | number | undefined> };
};

function secondaryRateLimitWait(error: unknown): number | undefined {
  const e = error as HttpError;
  if (e?.status !== 403 && e?.status !== 429) {
    return undefined;
  }
  const header = e.response?.headers?.["retry-after"];
  const limited = header !== undefined || /secondary rate limit/i.test(e.message ?? "");
  if (!limited) {
    return undefined;
  }
  const seconds = Number(header);
  return (
    (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS) *
    1000
  );
}

/** Runs one API step; on a secondary rate limit waits `retry-after` and retries once. */
export async function withRetry<T>(
  step: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const waitMs = secondaryRateLimitWait(error);
    if (waitMs === undefined) {
      throw error;
    }
    await sleep(waitMs);
    try {
      return await step();
    } catch (again) {
      if (secondaryRateLimitWait(again) !== undefined) {
        throw new Error(
          `GitHub API secondary rate limit: still limited after waiting ${waitMs / 1000}s and retried once. Re-run the job later.`,
        );
      }
      throw again;
    }
  }
}
