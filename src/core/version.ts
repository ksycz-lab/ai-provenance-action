/** Placeholder until P4-M1 builds the full report envelope. */
export const ACTION_NAME = "ai-provenance-action" as const;

export const DEFAULT_ACTION_VERSION = "0.0.0";

export function actionVersion(envVersion?: string): string {
  return envVersion?.trim() || DEFAULT_ACTION_VERSION;
}
