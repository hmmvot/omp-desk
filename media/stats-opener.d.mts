export const STATS_PRELOAD_MARKER: "OMP_DESK_STATS_PRELOAD_READY";
export function statsWindowsOpenerTarget(command: unknown, dashboardUrl: string | undefined): string | null;
export function installStatsOpener(
  runtime: { spawn(...args: unknown[]): unknown },
  logger: { log(...args: unknown[]): unknown },
  report: (marker: string) => void,
): boolean;
