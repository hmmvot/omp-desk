// A temporary per-child workaround until OMP exposes `stats --no-open` (ADR-0049).
// Nothing changes browser registration, PATH, SystemRoot or another process.
export const STATS_PRELOAD_MARKER = "OMP_DESK_STATS_PRELOAD_READY";

export function statsWindowsOpenerTarget(command, dashboardUrl) {
  if (!dashboardUrl || !Array.isArray(command) || typeof command[0] !== "string" || !/(?:^|[\\/])powershell\.exe$/i.test(command[0])) return null;
  if (command.length !== 5 || command[1] !== "-NoProfile" || command[2] !== "-NonInteractive" || command[3] !== "-EncodedCommand" || typeof command[4] !== "string") return null;
  const script = Buffer.from(command[4], "base64").toString("utf16le");
  const target = /^\$ErrorActionPreference='Stop';Start-Process '([^']+)'$/.exec(script)?.[1];
  return target === dashboardUrl ? target : null;
}

export function installStatsOpener(runtime, logger, report) {
  const spawn = runtime.spawn.bind(runtime);
  const log = logger.log.bind(logger);
  let dashboardUrl;
  let handled = false;
  const wrappedLog = (...args) => {
    if (args.length === 1 && typeof args[0] === "string") {
      const match = /^Dashboard available at: (http:\/\/127\.0\.0\.1:\d+)\s*$/.exec(args[0].replace(/\x1b\[[0-9;]*m/g, ""));
      if (match) {
        dashboardUrl = match[1];
        setTimeout(() => { if (!handled) report("OMP_DESK_STATS_OPENER_UNCHANGED"); }, 0);
      }
    }
    log(...args);
  };
  const wrappedSpawn = (...args) => {
    const command = Array.isArray(args[0]) ? args[0] : args[0]?.cmd;
    if (!handled && statsWindowsOpenerTarget(command, dashboardUrl) !== null) {
      handled = true;
      report("OMP_DESK_STATS_OPENER_SUPPRESSED");
      // Keep the real Bun.Subprocess contract. This starts no browser and fabricates no process/result.
      const noOpen = [command[0], "-NoProfile", "-NonInteractive", "-Command", "exit 0"];
      return Array.isArray(args[0]) ? spawn(noOpen, ...args.slice(1)) : spawn({ ...args[0], cmd: noOpen }, ...args.slice(1));
    }
    return spawn(...args);
  };
  try {
    logger.log = wrappedLog;
    runtime.spawn = wrappedSpawn;
    if (logger.log !== wrappedLog || runtime.spawn !== wrappedSpawn) throw new Error("unavailable");
    report(STATS_PRELOAD_MARKER);
    return true;
  } catch {
    try { logger.log = log; } catch { /* A sealed logger keeps its original method. */ }
    try { runtime.spawn = spawn; } catch { /* A sealed runtime keeps its original method. */ }
    return false;
  }
}

if (typeof Bun !== "undefined") installStatsOpener(Bun, console, marker => process.stderr.write(`${marker}\n`));
