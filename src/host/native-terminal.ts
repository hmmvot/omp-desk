/**
 * The installed OMP as a process this extension can start and inspect.
 *
 * This module owns everything that touches the installed `omp` binary: resolving it
 * from PATH (a runtime plus entry script, or OMP's own compiled program — never a
 * launcher that forwards to another process), running one-shot CLI commands, the bun
 * runtime and package-root lookups, and the stopped-session title helper. The three parts
 * that touch the VS Code API live in `omp-vscode.ts`, so this module imports no `vscode`.
 *
 * The invariant that matters: the process that runs is `omp` itself, started
 * *directly*. What a launcher prints is not identity — an unknown wrapper can answer
 * `omp --version` and still start the real OMP as a child — so only a file that
 * carries OMP's own program, or a recognised bun shim resolved to its entry, is ever
 * started. The chat process command line is built by `rpc-launch.ts`, and the writer's
 * ownership is decided by `rpc-reconcile.ts`.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "../shared/logger.ts";
import type { OmpLauncherKind } from "./chat-broker-runtime";
import type { PtyHandle } from "./pty-client";
import type { PtyStatusPayload } from "./pty-protocol";
import type { PtyBrokerRecord } from "./pty-protocol";
import type {
  TerminalWriter,
  TerminalWriterEvent,
  TerminalWriterSnapshot,
  TerminalWriterStatus,
} from "./terminal-pipeline";
import { placeSnapshotCursor } from "./terminal-pipeline";
import {
  formatDuration,
  isTransientOmpFailure,
  NO_FALLBACK_NOTICE,
  OMP_PATH_SETTING,
  OmpUnavailableError,
  rethrowIfTransientInspection,
  transientErrnoCause,
} from "../shared/omp-unavailable";

const CLI_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 15_000;
const MAX_CLI_OUTPUT_CHARS = 4 * 1024 * 1024;

/**
 * A launch target: an executable plus arguments that must precede every OMP
 * argument.
 *
 * A runtime plus entry script is still ONE process, unlike a launcher shim that
 * spawns the real binary as a child — which is what keeps the process id we
 * observe equal to the process id OMP publishes.
 */
export interface OmpCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export type { OmpLauncherKind };

export interface OmpBinary extends OmpCommand {
  /** Release `omp --version` reported, when it reported one; a diagnostic only. */
  readonly version: string | null;
  /** How this target was resolved; surfaced in diagnostics. */
  readonly origin: string;
  /**
   * What the launch is. `bun-shim`: `command` is Bun's own CLI running OMP's entry (`prefixArgs`), which takes
   * Bun's flags on its command line. `program`: OMP's own compiled executable (the winget portable package,
   * the `omp.sh` binary install, a mise install), whose command line is OMP's alone: Bun's flags there are
   * OMP's unknown flags. Absent when a caller built the value by hand; nothing then assumes either.
   */
  readonly launcher?: OmpLauncherKind;
}

export interface OmpCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /**
   * The signal that ended the process when something other than this module's own timeout or output
   * limit killed it (the machine's memory manager, a user, a service stop); absent otherwise.
   */
  readonly signal?: NodeJS.Signals;
}

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Resolve a launch target that can prove its own process identity.
 *
 * The extension never bundles, downloads or installs a second agent: whichever
 * `omp` is installed on this machine is the one that runs. The search therefore
 * follows the user's PATH in PATH order — the first `omp` PATH offers wins, so
 * an install the user just made (a newer Bun global shim, for example) is never
 * shadowed by an older copy — and the launcher directory OMP's own installer
 * writes to is only a last resort when PATH offers nothing usable.
 *
 * The reported release is a diagnostic, never an admission test: whichever
 * installed release the user's PATH selects is the one that runs, and a release
 * that later changes the rpc-ui wire or host-control contract surfaces as a
 * visible discovery or protocol error instead of a blanket refusal to start.
 * What is refused here, with its reason, is a target that cannot be launched as
 * one process.
 *
 * Identity is the real contract: the process id we observe must be the process
 * id the broker reports for its child, and a launcher *shim* breaks that by
 * spawning the real binary as a child. What a candidate prints is therefore
 * never evidence about it — `omp --version` succeeds just as well for a wrapper
 * that starts the real OMP in a child process. A recognised bun shim is
 * resolved through to the runtime entry it forwards to — one process, not two —
 * and a direct executable is accepted only when the file itself carries OMP's
 * own program. An unrecognised script, package-manager launcher or foreign
 * `.exe` is refused instead of being launched blindly.
 *
 * A failure of a candidate is classified before the search moves on (see
 * {@link OmpUnavailableError}). A *definitive* refusal — a missing file, a program that is not
 * OMP's, a foreign launcher, a probe that exits non-zero — records its reason and the search goes on
 * to the next candidate. A *transient* failure — the `--version` probe running past its limit, the
 * process not being creatable, the process being killed — says nothing about the candidate, so the
 * search stops with an error naming it: continuing would start whichever lower-priority install
 * happens to answer, i.e. an older OMP than the one PATH selects, because the machine was busy.
 * Retrying once with a longer bound was considered and rejected: it doubles the wait on exactly the
 * machines where the wait hurts, and the next launch is the retry.
 *
 * Every call resolves afresh, and that is deliberate: a session started now must
 * run the installation the user has now, so a replaced shim target or a new PATH
 * entry is picked up by the next launch. A host that is already running is never
 * re-resolved into a second writer — it keeps the command captured at its own
 * launch (`RpcHostRuntime.binary`) for every later CLI call.
 */
export async function resolveOmpBinary(
  options: { readonly probeTimeoutMs?: number; readonly explicitPath?: string } = {},
): Promise<OmpBinary> {
  const probeTimeoutMs = options.probeTimeoutMs ?? VERSION_TIMEOUT_MS;
  const explicitPath = (options.explicitPath ?? ompPathReader?.() ?? "").trim();
  const explicit = explicitPath.length > 0;
  const rejections: string[] = [];

  // Each distinct file is tried once, in search order, and every refusal is
  // recorded at the position it was tried, so the reasons a failure reports
  // read in the same order the search used. An explicit path is the only target.
  // A file is looked at only when the search reaches it: a file further down PATH that
  // cannot be read right now is no obstacle to a healthy preferred install.
  const seenTargets = new Set<string>();
  const pending: PendingTarget[] = explicit
    ? [{ file: explicitPath, classify: () => explicitTarget(explicitPath) }]
    : launchTargets();
  for (const [index, item] of pending.entries()) {
    const key = process.platform === "win32" ? item.file.toLowerCase() : item.file;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    const target = await item.classify();
    if (target === null) continue;

    let resolved: OmpBinary | null = null;
    if (target.kind === "unusable") {
      rejections.push(target.reason);
    } else if (target.kind === "bun-shim") {
      resolved = await resolveBunShim(target.shim, rejections, probeTimeoutMs);
    } else {
      resolved = await verifyLaunchCandidate(target.candidate, rejections, probeTimeoutMs);
    }
    if (resolved !== null) {
      // A Test of a typed path, or a resolution under an explicit setting, says nothing about what PATH offers.
      if (options.explicitPath === undefined && !explicit) noteOtherInstalls(item.file, resolved, pending.slice(index + 1));
      return resolved;
    }
  }

  if (explicit) {
    throw new OmpUnavailableError(
      `The OMP named by the ${OMP_PATH_SETTING} setting (${explicitPath}) cannot be used.` +
        `${describeRejections(rejections)} Desk does not search PATH while that setting is set; ` +
        "correct the path, or clear the setting to use the OMP on PATH.",
    );
  }
  throw new OmpUnavailableError(
    "No usable OMP launcher was found." +
      `${describeRejections(rejections)} Check the installed OMP and PATH; this extension runs the ` +
      "OMP that is installed and does not install, download or upgrade it.",
  );
}

/**
 * The one target an explicit path stands for. It is held to every rule a PATH entry is held to —
 * OMP's own program, or a recognised bun shim resolved to its entry — and a path that fails them is
 * refused with its reason rather than started.
 */
async function explicitTarget(file: string): Promise<LaunchTarget> {
  if (!path.isAbsolute(file)) return { kind: "unusable", key: file, reason: `${file} is not an absolute path` };
  if (!(await isRunnableFile(file))) {
    return { kind: "unusable", key: file, reason: `${file} does not exist or is not a runnable file` };
  }
  return await pathTarget(file, `the ${OMP_PATH_SETTING} setting`);
}

let ompResolutionLog: Logger | null = null;
let ompPathReader: (() => string) | null = null;
let otherInstallsReported = false;
let otherInstallsInFlight = false;

/** Where resolution notes go (the OMP Desk output); the extension sets it once, at activation. */
export function setOmpResolutionLog(logger: Logger | null): void {
  ompResolutionLog = logger;
}

/**
 * Where the explicit OMP path setting is read from; the extension registers it once, at activation.
 * It is called on every resolution, so a changed setting is read by the next launch. Without a
 * reader (a process that is not the extension host) PATH decides.
 */
export function setOmpPathReader(reader: (() => string) | null): void {
  ompPathReader = reader;
}

/**
 * Say once per window, in the log only, that PATH offers more than one OMP install: a user who
 * installed a second copy deserves to see which one runs. The selected install is never changed by
 * this, and the other installs' releases are read in the background, so a resolution never waits
 * for a probe it does not need. The allowance is spent only by a report that was written: PATH
 * entries that turn out to be the same install do not use it up.
 */
function noteOtherInstalls(selectedFile: string, selected: OmpBinary, rest: readonly PendingTarget[]): void {
  const log = ompResolutionLog;
  if (log === null || otherInstallsReported || otherInstallsInFlight || rest.length === 0) return;
  otherInstallsInFlight = true;
  void (async () => {
    try {
      const message = await reportOtherInstalls(selectedFile, selected, rest);
      // The sink may have been replaced or cleared while the probes ran (the window's output closed).
      if (message !== null && ompResolutionLog === log) {
        log.info(message);
        otherInstallsReported = true;
      }
    } catch {
      // A diagnostic never fails a resolution; a later resolution tries again.
    } finally {
      otherInstallsInFlight = false;
    }
  })();
}

/**
 * The install a launch command stands for — the entry script of a runtime launch, else the program —
 * with links and junctions resolved, so two PATH entries reaching one install are one install.
 */
async function installIdentity(executable: OmpCommand): Promise<string> {
  const file = executable.prefixArgs.at(-1) ?? executable.command;
  let identity = file;
  try {
    identity = await fs.realpath(file);
  } catch {
    // An unreadable path stands for itself.
  }
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

async function reportOtherInstalls(
  selectedFile: string,
  selected: OmpBinary,
  rest: readonly PendingTarget[],
): Promise<string | null> {
  const distinct = new Map<string, { readonly file: string; readonly executable: OmpCommand }>();
  const selectedIdentity = await installIdentity(selected);
  for (const item of rest) {
    const target = await item.classify();
    if (target === null || target.kind === "unusable") continue;
    const candidate = target.kind === "direct" ? target.candidate : await bunShimCandidate(target.shim);
    if (typeof candidate === "string") continue;
    const identity = await installIdentity(candidate.executable);
    if (identity === selectedIdentity || distinct.has(identity)) continue;
    distinct.set(identity, { file: item.file, executable: candidate.executable });
  }
  if (distinct.size === 0) return null;

  const release = (version: string | null): string => (version === null ? "release unknown" : `release ${version}`);
  const listed = [`${selectedFile} (${release(selected.version)}, in use)`];
  for (const other of distinct.values()) {
    let version: string | null = null;
    try {
      const result = await runOmpCli(other.executable, ["--version"], VERSION_TIMEOUT_MS);
      if (result.exitCode === 0) version = parseVersion(result.stdout) ?? parseVersion(result.stderr);
    } catch {
      // The release stays unknown; the install is still reported.
    }
    listed.push(`${other.file} (${release(version)}, not used)`);
  }
  return (
    "More than one OMP install was found. Desk runs the first one PATH offers (the launcher directory " +
    `is only a last resort): ${listed.join("; ")}.`
  );
}

interface OmpLaunchCandidate {
  readonly executable: OmpCommand;
  readonly origin: string;
  /** The file PATH named, for messages: the program itself, or the bun shim that forwards to the entry. */
  readonly label: string;
  /** What the launch is: the program itself, or `bun.exe` running an entry the shim named. */
  readonly launcher: OmpLauncherKind;
  /** `bun.exe` files that were passed over on the way to this candidate's runtime because they only forward to another Bun. */
  readonly skippedRuntimes?: readonly string[];
}

/** One target to try, in search order, with the file path that identifies it. */
type LaunchTarget =
  | { readonly kind: "direct"; readonly key: string; readonly candidate: OmpLaunchCandidate }
  | { readonly kind: "bun-shim"; readonly key: string; readonly shim: string }
  | { readonly kind: "unusable"; readonly key: string; readonly reason: string };

/** One file the search will look at, in search order; what it is gets decided only when the search reaches it. */
interface PendingTarget {
  readonly file: string;
  /** The target the file is, or `null` when there is nothing there (an installer directory that is not installed). */
  classify(): Promise<LaunchTarget | null>;
}

/**
 * Why a file that is nothing but a name on PATH is never started.
 *
 * This is the refusal that a reported `--version` must not be able to buy its
 * way past: an unexamined launcher can start the real OMP as a child process,
 * which leaves the process id this extension observes pointing at a launcher
 * while the writer it cannot see keeps running.
 */
const FOREIGN_LAUNCHER_REASON =
  "is neither OMP's own program nor a recognised bun shim, so it can only be a launcher that " +
  "forwards to another process; it is not started";

/**
 * Every file to look at, in order: PATH in PATH order first, then the launcher
 * directory OMP's own installer writes to.
 *
 * The order is fixed here, before anything is verified, because verifying "all direct
 * executables, then all shims" would let a later PATH entry overtake an earlier one and would
 * put an older launcher-directory copy in front of the `omp` the user selected on PATH. What each
 * file is — OMP's program, a bun shim, or a refusal that is reported where the search reached it
 * — is decided by its `classify`, when the search gets there; a launcher directory that is not
 * installed at all classifies as absent.
 */
function launchTargets(): PendingTarget[] {
  const pending: PendingTarget[] = pathExecutableNames().map(file => ({
    file,
    async classify() {
      return (await isRunnableFile(file)) ? pathTarget(file, "PATH") : null;
    },
  }));

  // Last resort only: an install under OMP's own launcher directory is never
  // preferred over the `omp` the user put on PATH, and it is held to the same
  // identity rule as a PATH entry — a file that only forwards to OMP would
  // break the process identity the extension matches against the registry.
  for (const file of officialLauncherCandidates()) {
    pending.push({
      file,
      async classify() {
        if (!(await isRunnableFile(file))) return null;
        const identity = await classifyCandidate(file);
        if (identity === "omp-program") {
          return {
            kind: "direct",
            key: file,
            candidate: { executable: { command: file, prefixArgs: [] }, origin: "the OMP launcher directory", label: file, launcher: "program" },
          };
        }
        return { kind: "unusable", key: file, reason: `${file} ${FOREIGN_LAUNCHER_REASON}` };
      },
    });
  }
  return pending;
}

/**
 * What one file that is named as an OMP executable — on PATH, or by the user — is, judged by its
 * content: OMP's own program, a bun shim to resolve through, or a refusal with its reason.
 */
async function pathTarget(file: string, origin: string): Promise<LaunchTarget> {
  // Content decides before shape does: a compiled OMP executable embeds bun's
  // own runtime, so it also contains bun-shim strings far inside it.
  const identity = await classifyCandidate(file);
  if (identity === "omp-program") {
    return {
      kind: "direct",
      key: file,
      candidate: { executable: { command: file, prefixArgs: [] }, origin, label: file, launcher: "program" },
    };
  }
  if (identity === "bun-shim") return { kind: "bun-shim", key: file, shim: file };
  const mise = await miseShimTarget(file);
  if (mise !== null) return mise;
  // The `.cmd` launcher that npm, pnpm or Yarn writes for a package whose script says `#!/usr/bin/env bun` starts Bun on the entry through
  // a shell. Resolved through to that entry it is the same launch a bun shim stands for: Bun's own CLI running OMP's entry, with no shell.
  if (path.extname(file).toLowerCase() === ".cmd" && (await cmdShimEntry(file)) !== null) return { kind: "bun-shim", key: file, shim: file };
  if (isShimLocation(file)) {
    return { kind: "unusable", key: file, reason: `${file} is a package-manager shim, which never runs as a single process` };
  }
  if (process.platform === "win32" && !file.toLowerCase().endsWith(".exe")) {
    return {
      kind: "unusable",
      key: file,
      reason: `${file} is a script launcher, which needs a shell and would add a process layer`,
    };
  }
  return { kind: "unusable", key: file, reason: `${file} ${FOREIGN_LAUNCHER_REASON}` };
}

/**
 * The folder mise keeps the releases of OMP's documented install (`mise use -g github:can1357/oh-my-pi`) in, under its data directory:
 * `<data>/installs/github-can1357-oh-my-pi/<release>/omp.exe` is OMP's own compiled program. The `<data>/shims/omp.exe` that PATH
 * names is not: it is mise's launcher, a copy of its `mise-shim.exe`, which starts `mise x -- omp`, which starts the program.
 */
const MISE_INSTALL_DIRECTORY = "github-can1357-oh-my-pi";
/** A text mise-shim.exe carries and OMP's program and every other launcher does not. */
const MISE_SHIM_MARKER = "mise-shim:";
const MISE_SHIM_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * A mise shim for `omp`, resolved to the one release of OMP that is installed beside it, or refused with the reason; `null` when the
 * file is not a mise shim. Nothing is started: the shim would be two processes ahead of OMP, so the process Desk launches would not
 * be the one OMP registers. The files mise itself keeps are read instead (the shim directory and its sibling `installs`), and the
 * program found there is held to the same identity rule as any direct program: its own content must say it is OMP's.
 *
 * With one release installed the shim can run only that one, so Desk starts it directly. With several, which one the shim runs
 * depends on mise's configuration for the folder it is started in, which Desk does not evaluate: it refuses and names them, and
 * the user picks with `ompDesk.executablePath` or by putting that release's folder on PATH.
 */
async function miseShimTarget(file: string): Promise<LaunchTarget | null> {
  if (path.extname(file).toLowerCase() !== ".exe" || path.basename(path.dirname(file)).toLowerCase() !== "shims") return null;
  let head: string;
  try {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(MISE_SHIM_SCAN_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("latin1");
    } finally {
      await handle.close();
    }
  } catch (error) {
    rethrowIfTransientInspection(file, error);
    return null;
  }
  if (!head.includes(MISE_SHIM_MARKER)) return null;

  const installs = path.join(path.dirname(path.dirname(file)), "installs", MISE_INSTALL_DIRECTORY);
  const program = process.platform === "win32" ? "omp.exe" : "omp";
  const found: string[] = [];
  try {
    // A release is a real directory; the `latest`, `18` and `global` entries mise adds are links to one.
    for (const entry of await fs.readdir(installs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(installs, entry.name, program);
      if (await isRunnableFile(candidate)) found.push(candidate);
    }
  } catch (error) {
    rethrowIfTransientInspection(installs, error);
  }
  const shim = `${file} is mise's shim, which starts mise and mise then starts OMP (two processes ahead of it), so it is not started`;
  if (found.length === 0) {
    return { kind: "unusable", key: file, reason: `${shim}, and no release of OMP is installed in ${installs}; install one with \`mise use -g github:can1357/oh-my-pi\`` };
  }
  if (found.length > 1) {
    return {
      kind: "unusable",
      key: file,
      reason: `${shim}. ${found.length} releases are installed (${found.join(", ")}) and the one the shim runs depends on mise's configuration for the folder, ` +
        `which Desk does not evaluate: set ${OMP_PATH_SETTING} to the one to use, or put its folder on PATH before the shims`,
    };
  }
  const installed = found[0];
  if ((await classifyCandidate(installed)) !== "omp-program") {
    return { kind: "unusable", key: file, reason: `${shim}, and ${installed}, the only release installed beside it, ${FOREIGN_LAUNCHER_REASON}` };
  }
  return {
    kind: "direct",
    key: file,
    candidate: {
      executable: { command: installed, prefixArgs: [] },
      origin: `the mise install behind the shim ${file}`,
      label: installed,
      launcher: "program",
    },
  };
}

/** The directory OMP's own updater installs the release binary into. */
function officialLauncherCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const localAppData = process.env.LOCALAPPDATA ?? "";
  if (localAppData.length === 0) return [];
  return [path.join(localAppData, "omp", "omp.exe")];
}

const OMP_EXECUTABLE_NAMES: readonly string[] =
  process.platform === "win32" ? ["omp.exe", "omp.cmd", "omp.bat", "omp"] : ["omp"];

/**
 * Every file name PATH could offer an `omp` under, in PATH order. Nothing is looked at here: whether a
 * name is a runnable file is asked when the search reaches it, so a directory further down PATH that
 * cannot be read right now is no obstacle to a healthy `omp` found earlier.
 */
function pathExecutableNames(): string[] {
  const found: string[] = [];
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    for (const name of OMP_EXECUTABLE_NAMES) found.push(path.join(entry, name));
  }
  return found;
}

/** Directory names that hold package-manager launchers instead of the program. */
const SHIM_LOCATIONS: Record<string, true> = {
  ".bun": true,
  ".npm": true,
  ".pnpm": true,
  ".yarn": true,
  node_modules: true,
  npm: true,
  pnpm: true,
  shims: true,
  volta: true,
  yarn: true,
};

function isShimLocation(file: string): boolean {
  return path
    .dirname(file)
    .split(/[\\/]+/)
    .some(segment => SHIM_LOCATIONS[segment.toLowerCase()] === true);
}

/** Marker inside a bun launcher shim. */
const BUN_SHIM_MARKER = "bun_shim_impl";
const SHIM_SCAN_BYTES = 128 * 1024;

async function isBunShim(file: string): Promise<boolean> {
  let content: string;
  try {
    await fs.access(file);
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(SHIM_SCAN_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString("latin1");
    } finally {
      await handle.close();
    }
  } catch (error) {
    rethrowIfTransientInspection(file, error);
    return false;
  }
  return content.includes(BUN_SHIM_MARKER);
}

/**
 * Strings OMP's own compiled program carries: its product identity, and the
 * JavaScript runtime it is compiled with.
 *
 * They are read out of the file's own content because nothing else here can
 * tell OMP's program from a launcher that merely starts it — `omp --version`
 * answers for both. A launcher embeds the *path* of the program it forwards to,
 * which is why one identity marker alone is not enough: a file that can answer
 * OMP's own CLI carries a JavaScript engine inside it, and a launcher does not.
 * These are product identities, never versions, so every installed release may
 * match and the file is simply re-read when the user replaces it.
 */
const OMP_PROGRAM_MARKERS: readonly string[] = ["pi-coding-agent", "oh-my-pi"];
const EMBEDDED_RUNTIME_MARKERS: readonly string[] = ["JavaScriptCore", "oven-sh/bun"];

/** How much of a candidate is read at a time while looking for those markers. */
const PROGRAM_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** Overlap kept between chunks, so a marker split by the boundary still matches. */
const PROGRAM_SCAN_CARRY_BYTES = 64;

/** Memoised {@link fileCarriesMarkers} answers, keyed by what was asked and by file identity (path, size, mtime). */
const markerScans = new Map<string, boolean>();

/**
 * Does the file's content carry at least one marker of every group?
 *
 * The file is streamed and the scan stops as soon as every group has been seen, so an installed release is recognised without ever
 * loading it whole into memory and a small wrapper is read in one pass. A file that cannot be read is not a match; a file that is
 * merely busy or unreachable right now is a transient failure, never a mismatch.
 *
 * The answer is remembered per file identity — path, size and modification time — because this is a property of those bytes. It is
 * deliberately not a launcher cache: nothing about which target resolution chooses is kept, and a binary the user replaces is scanned
 * again, so a candidate is read once per window and then answered from memory. `kind` names the question, so two questions about one
 * file stay apart.
 */
async function fileCarriesMarkers(file: string, kind: string, groups: readonly (readonly string[])[]): Promise<boolean> {
  let handle: fs.FileHandle;
  let scanKey: string;
  try {
    const stats = await fs.stat(file);
    scanKey = `${kind}\u0000${file}\u0000${stats.size}\u0000${stats.mtimeMs}`;
    const remembered = markerScans.get(scanKey);
    if (remembered !== undefined) return remembered;
    handle = await fs.open(file, "r");
  } catch (error) {
    rethrowIfTransientInspection(file, error);
    return false;
  }
  try {
    const buffer = Buffer.allocUnsafe(PROGRAM_SCAN_CHUNK_BYTES + PROGRAM_SCAN_CARRY_BYTES);
    const seen = groups.map(() => false);
    let carry = 0;
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carry, PROGRAM_SCAN_CHUNK_BYTES, offset);
      if (bytesRead === 0) break;
      const window = buffer.subarray(0, carry + bytesRead);
      groups.forEach((markers, index) => {
        if (!seen[index]) seen[index] = markers.some(marker => window.includes(marker));
      });
      if (seen.every(Boolean)) {
        markerScans.set(scanKey, true);
        return true;
      }
      offset += bytesRead;
      const keep = Math.min(PROGRAM_SCAN_CARRY_BYTES, carry + bytesRead);
      buffer.copy(buffer, 0, carry + bytesRead - keep, carry + bytesRead);
      carry = keep;
    }
    markerScans.set(scanKey, false);
    return false;
  } catch (error) {
    rethrowIfTransientInspection(file, error);
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Does this file *contain* OMP's program, rather than merely run it? OMP's identity plus an embedded JavaScript engine; admission is
 * not identity: what makes a process the writer is the child identity its broker recorded, never this scan.
 */
function isOmpRuntimeProgram(file: string): Promise<boolean> {
  return fileCarriesMarkers(file, "omp-program", [OMP_PROGRAM_MARKERS, EMBEDDED_RUNTIME_MARKERS]);
}

/**
 * Is this file Bun itself — a JavaScript engine inside the file — rather than a launcher that only names Bun?
 *
 * What a `bun.exe` is called says nothing: a package manager's shim folder can hold a launcher of that name that starts the real
 * Bun as a second process. The launcher is a small program of a package manager's own and holds a path, never an engine; the real
 * runtime holds JavaScriptCore, the same content rule that tells OMP's compiled program from a launcher that starts it. No process
 * is started to ask, which a launcher would answer for the real Bun just as well.
 */
function isBunRuntimeProgram(file: string): Promise<boolean> {
  return fileCarriesMarkers(file, "bun-runtime", [EMBEDDED_RUNTIME_MARKERS]);
}

/** What one candidate file is, judged by its content instead of by its name. */
type CandidateIdentity =
  /** OMP's own compiled program: bun's runtime plus OMP's embedded bundle. */
  | "omp-program"
  /** A package-manager launcher whose metadata resolves to the real entry. */
  | "bun-shim"
  /** Anything else, including a file that cannot be read. */
  | "foreign";

/**
 * Classify one candidate by what it *is*.
 *
 * A direct program is decided before shim identity because a compiled OMP
 * executable embeds bun's runtime — and with it the shim marker — while a
 * package-manager launcher contains neither OMP's bundle nor a JavaScript
 * engine, only the path of the entry it starts.
 */
async function classifyCandidate(file: string): Promise<CandidateIdentity> {
  if (await isOmpRuntimeProgram(file)) return "omp-program";
  if (await isBunShim(file)) return "bun-shim";
  return "foreign";
}

const OMP_PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";

/**
 * Resolve a bun shim to the runtime entry it forwards to, or say why it cannot be.
 *
 * bun records a shim's real target beside it in a `.bunx` metadata file, which
 * is the mapping the shim itself uses; the owning package's manifest is only a
 * fallback. Nothing here is guessed from a path.
 */
async function bunShimCandidate(shim: string): Promise<OmpLaunchCandidate | string> {
  const binDirectory = path.dirname(shim);
  const cmd = path.extname(shim).toLowerCase() === ".cmd";
  const kind = cmd ? "package-manager shim" : "bun shim";
  const skipped: string[] = [];
  const bun = await bunRuntime(binDirectory, skipped);
  if (bun === null) {
    const missing = `${shim} is a ${kind}, but no bun runtime was found beside it in ${binDirectory}${cmd || skipped.length > 0 ? " or on PATH" : ""}`;
    return skipped.length === 0
      ? missing
      : `${missing}: ${describeForwardingRuntimes(skipped)}. Put Bun's own bun.exe (installed with Bun's installer) on PATH.`;
  }

  const entry = cmd ? await cmdShimEntry(shim) : await bunShimEntry(shim, path.resolve(binDirectory, ".."));
  if (entry === null) {
    return cmd
      ? `${shim} is a package-manager shim, but it does not start Bun on an entry of OMP's package`
      : `${shim} is a bun shim, but its target entry could not be resolved from ${path.resolve(binDirectory, "..")}`;
  }
  return {
    executable: { command: bun, prefixArgs: [entry] },
    origin: `the ${kind} ${shim}, resolved to ${entry}`,
    label: shim,
    launcher: "bun-shim",
    ...(skipped.length === 0 ? {} : { skippedRuntimes: skipped }),
  };
}

async function resolveBunShim(shim: string, rejections: string[], probeTimeoutMs: number): Promise<OmpBinary | null> {
  const candidate = await bunShimCandidate(shim);
  if (typeof candidate === "string") {
    rejections.push(candidate);
    return null;
  }
  const resolved = await verifyLaunchCandidate(candidate, rejections, probeTimeoutMs);
  // Said only for a launch that was accepted, so the line never claims a Bun was used when nothing starts.
  if (resolved !== null && candidate.skippedRuntimes !== undefined) noteForwardingRuntimes(candidate.skippedRuntimes, candidate.executable.command);
  return resolved;
}

/**
 * The Bun runtime a bun shim's launch runs on: the one beside the shim, else the first on PATH that is Bun itself, or `null`.
 *
 * A file named `bun.exe` is not Bun until its content says so ({@link isBunRuntimeProgram}). A package manager's forwarding launcher
 * (the backlog named the shim folders of Scoop and Chocolatey) carries the name and hands the command line to the real Bun as a second process; started
 * as the launch, it leaves the process id this extension observes pointing at the launcher, so host control would fail the pid check
 * on every launch. Such a file is skipped, with its reason in `skipped`, and the search goes on to the next candidate.
 */
async function bunRuntime(binDirectory: string, skipped: string[]): Promise<string | null> {
  const names = BUN_EXECUTABLE_NAMES;
  const directories = [binDirectory];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    if (directory) directories.push(directory);
  }
  const seen = new Set<string>();
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(await isRunnableFile(candidate))) continue;
      if (await isBunRuntimeProgram(candidate)) return candidate;
      skipped.push(candidate);
    }
  }
  return null;
}

/** Launchers already reported to the log as passed over, so the reason is written once per file for the window. */
const reportedForwardingRuntimes = new Set<string>();

function describeForwardingRuntimes(skipped: readonly string[]): string {
  const listed = skipped.join(", ");
  return `${listed} ${skipped.length === 1 ? "is" : "are"} not Bun's own runtime (no JavaScript engine found in the file): ` +
    "a package manager's launcher that starts the real Bun as a second process, so the process Desk starts would not be the one that runs OMP";
}

function noteForwardingRuntimes(skipped: readonly string[], used: string): void {
  const fresh = skipped.filter(file => !reportedForwardingRuntimes.has(process.platform === "win32" ? file.toLowerCase() : file));
  const log = ompResolutionLog;
  if (fresh.length === 0 || log === null) return;
  for (const file of fresh) reportedForwardingRuntimes.add(process.platform === "win32" ? file.toLowerCase() : file);
  log.info(`${describeForwardingRuntimes(fresh)}; Bun's own ${used} is used instead.`);
}

/**
 * The entry a bun shim forwards to: its own `.bunx` metadata first (a UTF-16LE
 * path relative to the bun root), then the `omp` bin entry of the installed
 * package.
 */
async function bunShimEntry(shim: string, bunRoot: string): Promise<string | null> {
  const metadata = `${shim.slice(0, shim.length - path.extname(shim).length)}.bunx`;
  try {
    const text = (await fs.readFile(metadata)).toString("utf16le");
    const match = /"([^"\u0000]+)"/.exec(text);
    if (match !== null) {
      const recorded = path.resolve(bunRoot, match[1]);
      if (await isRunnableFile(recorded)) return recorded;
    }
  } catch (error) {
    // No metadata beside the shim; fall through to the package manifest. A file that is merely
    // busy right now is not "no metadata".
    if (isTransientOmpFailure(error)) throw error;
    rethrowIfTransientInspection(metadata, error);
  }
  const packageDirectory = path.join(bunRoot, "install", "global", "node_modules", OMP_PACKAGE_NAME);
  return await packageBinEntry(packageDirectory);
}

/**
 * The `.cmd` launchers JavaScript package managers write for a package whose bin script starts with `#!/usr/bin/env bun`, as each wrote
 * them for OMP 18.11.1 (observed): which program the launcher starts, and the entry it names relative to its own folder.
 *
 * - npm: `SET "_prog=%dp0%\bun.exe"` / `SET "_prog=bun"`, then `"%_prog%"  "%dp0%\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js" %*`.
 * - pnpm and Yarn's own `.bin` launcher: `"%~dp0\bun.exe"  "%~dp0\<entry>" %*`, else `bun  "%~dp0\<entry>" %*`.
 * - Yarn's launcher in the global prefix folder only forwards to that `.bin` launcher: `@"%~dp0\..\..\global\node_modules\.bin\omp.cmd" %*`.
 */
const NPM_SHIM_RUNS_BUN = /SET\s+"_prog=(?:%dp0%\\)?bun(?:\.exe)?"/i;
const NPM_SHIM_ENTRY = /"%_prog%"\s+"%dp0%\\([^"\r\n]+)"/i;
const BIN_SHIM_ENTRIES = [/"%~dp0\\bun\.exe"\s+"%~dp0\\([^"\r\n]+)"/i, /^\s*(?:@\s*)?bun\s+"%~dp0\\([^"\r\n]+)"/im];
const SHIM_FORWARD = /^\s*@?\s*"%~dp0\\([^"\r\n]+\.cmd)"\s+%\*/im;
/** A package manager's launcher is a few hundred bytes; a `.cmd` file far larger than this is not one. */
const CMD_SHIM_SCAN_BYTES = 16 * 1024;
/** Launchers that only forward to another launcher (Yarn's prefix folder): how many are followed. */
const CMD_SHIM_MAX_FORWARDS = 2;

/**
 * Volta's launcher for a global package binary (Volta 2.0.2, observed): `<VOLTA_HOME>\bin\omp.cmd` is `@echo off` and `volta run %~n0 %*`,
 * which starts Volta, which starts the package's own launcher in its image. Volta says which package a binary belongs to in
 * `<VOLTA_HOME>\tools\user\bins\<name>.json`, and keeps the image of the one installed release in
 * `<VOLTA_HOME>\tools\image\packages\<package>\<name>.cmd`.
 */
const VOLTA_LAUNCHER = /^\s*@echo off\s+volta run %~n0 %\*\s*$/i;

/** The package launcher inside Volta's image that `<VOLTA_HOME>\bin\<name>.cmd` runs for OMP, or null when it is not OMP's. */
async function voltaPackageLauncher(shim: string): Promise<string | null> {
  const bin = path.dirname(shim);
  if (path.basename(bin).toLowerCase() !== "bin") return null;
  const home = path.dirname(bin);
  const name = path.basename(shim, path.extname(shim));
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(home, "tools", "user", "bins", `${name}.json`), "utf8"));
  } catch (error) {
    rethrowIfTransientInspection(shim, error);
    return null;
  }
  if (typeof manifest !== "object" || manifest === null || !("package" in manifest) || manifest.package !== OMP_PACKAGE_NAME) return null;
  return path.join(home, "tools", "image", "packages", ...OMP_PACKAGE_NAME.split("/"), `${name}.cmd`);
}

/**
 * The entry script of OMP's package that a package manager's `.cmd` launcher starts under Bun, or null when the file is not such a
 * launcher.
 *
 * Nothing is guessed: the launcher must say it runs Bun, the entry it names must be a runnable file, and the nearest package
 * manifest above that entry must be OMP's. A launcher for Node, or for any other package, is not OMP and stays refused. A launcher
 * that only forwards is followed to the launcher it names, at most {@link CMD_SHIM_MAX_FORWARDS} times.
 */
async function cmdShimEntry(shim: string, forwards = 0): Promise<string | null> {
  let text: string;
  try {
    const handle = await fs.open(shim, "r");
    try {
      const buffer = Buffer.allocUnsafe(CMD_SHIM_SCAN_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    rethrowIfTransientInspection(shim, error);
    return null;
  }
  const named = NPM_SHIM_RUNS_BUN.test(text) ? NPM_SHIM_ENTRY.exec(text)?.[1] : BIN_SHIM_ENTRIES.map(pattern => pattern.exec(text)?.[1]).find(entry => entry !== undefined);
  if (named === undefined) {
    const forward = SHIM_FORWARD.exec(text)?.[1];
    if (forward !== undefined) return forwards >= CMD_SHIM_MAX_FORWARDS ? null : await cmdShimEntry(path.resolve(path.dirname(shim), forward), forwards + 1);
    if (!VOLTA_LAUNCHER.test(text) || forwards >= CMD_SHIM_MAX_FORWARDS) return null;
    const launcher = await voltaPackageLauncher(shim);
    return launcher === null ? null : await cmdShimEntry(launcher, forwards + 1);
  }
  const script = path.resolve(path.dirname(shim), named);
  if (!(await isRunnableFile(script)) || (await packageDirectoryOf(script)) === null) return null;
  return script;
}

/** The declared `omp` entry of an installed package, or null. */
async function packageBinEntry(packageDirectory: string): Promise<string | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
  } catch (error) {
    rethrowIfTransientInspection(packageDirectory, error);
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;
  const declared = "bin" in manifest ? manifest.bin : undefined;
  let relative: unknown;
  if (typeof declared === "string") relative = declared;
  else if (typeof declared === "object" && declared !== null && "omp" in declared) relative = declared.omp;
  if (typeof relative !== "string" || relative.length === 0) return null;
  const entry = path.resolve(packageDirectory, relative);
  return (await isRunnableFile(entry)) ? entry : null;
}

/**
 * Accept a candidate that was already recognised as a launchable target.
 *
 * Identity is settled before this runs — by {@link classifyCandidate} for a
 * direct program, by the shim's own metadata for a bun shim — so this probe
 * answers only "does the file execute". `omp --version` is a diagnostic: the
 * reported release is recorded on the result and quoted in rejection reasons,
 * but it never admits or refuses a target on its version, because the user
 * chooses which of their installed OMP releases runs. It is not evidence of
 * identity either: any wrapper that starts the real OMP can print it, which is
 * why a file has to prove what it *is* before it is started. A target that
 * cannot be launched, or that exits non-zero when asked for its version, is
 * still refused here — a broken launcher fails visibly at resolution instead of
 * turning into a confusing discovery timeout once a session is supposed to be
 * running.
 *
 * That refusal is *definitive*, and the caller goes on to the next candidate. A probe that
 * could not be answered because of the machine — it ran past its limit, the process could not be
 * created, it was killed — is not a refusal of this candidate and throws a transient
 * {@link OmpUnavailableError} instead, ending the whole resolution (see {@link resolveOmpBinary}).
 */
async function verifyLaunchCandidate(
  candidate: OmpLaunchCandidate,
  rejections: string[],
  probeTimeoutMs: number,
): Promise<OmpBinary | null> {
  const { command, prefixArgs } = candidate.executable;
  let version: string | null = null;
  let transientCause: string | undefined;
  if (candidate.launcher === "bun-shim") {
    // A bun shim was resolved through to Bun and the entry script it runs, both already shown to be runnable files, and the package
    // that holds the entry carries its release in its manifest: no process is started to ask (a start that a busy machine can delay
    // past any limit). A manifest that does not give one falls back to asking.
    const entry = prefixArgs.at(-1);
    const release = entry === undefined ? null : await bunShimRelease(entry);
    if (release !== null) return { command, prefixArgs, version: release, origin: candidate.origin, launcher: candidate.launcher };
  }
  try {
    const result = await runOmpCli(candidate.executable, ["--version"], probeTimeoutMs);
    if (result.signal !== undefined) {
      transientCause = `was killed by ${result.signal} before it answered`;
    } else if (result.exitCode !== 0) {
      rejections.push(
        `${command} was rejected: \`--version\` exited with code ${result.exitCode}${describeStderr(result.stderr)}`,
      );
      return null;
    } else {
      version = parseVersion(result.stdout) ?? parseVersion(result.stderr);
    }
  } catch (error) {
    if (!isTransientOmpFailure(error)) {
      rejections.push(`${command} was rejected: ${messageOf(error)}`);
      return null;
    }
    transientCause = error.transientCause;
  }
  if (transientCause !== undefined) {
    throw new OmpUnavailableError(
      `\`omp --version\` of ${candidate.label} ${transientCause}; ${NO_FALLBACK_NOTICE}${describeRejections(rejections)}`,
      { transientCause },
    );
  }
  return { command, prefixArgs, version, origin: candidate.origin, launcher: candidate.launcher };
}

/** The release of the OMP package that holds `entry`, as `omp --version` prints it (major.minor.patch), or `null`. */
async function bunShimRelease(entry: string): Promise<string | null> {
  const dir = await packageDirectoryOf(entry);
  if (dir === null) return null;
  const manifest = await readPackageManifest(dir);
  return manifest?.version === undefined ? null : parseVersion(manifest.version);
}

function describeRejections(rejections: readonly string[]): string {
  if (rejections.length === 0) return "";
  return ` Tried:${rejections.map(rejection => `\n  - ${rejection}`).join("")}`;
}

async function isRunnableFile(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch (error) {
    rethrowIfTransientInspection(file, error);
    return false;
  }
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

function parseVersion(output: string): string | null {
  const match = VERSION_RE.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Run an `omp` CLI subcommand and capture its output.
 *
 * stdout is returned to the caller but never logged by this module: an
 * `omp` subcommand's stdout can carry a capability.
 *
 * `options.cwd` and `options.env` describe the scope a *scope-dependent* read
 * has to observe: OMP merges project settings and `PI_CONFIG_FILES` overlays
 * over the global layer, so a CLI read that describes one session must run in
 * that session's directory with that session's overlay, exactly as its launch
 * did. The environment is merged over this process's own, never replaced.
 */
export async function runOmpCli(
  executable: OmpCommand,
  args: readonly string[],
  timeoutMs = CLI_TIMEOUT_MS,
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<OmpCliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<OmpCliResult>();
  const child = spawn(executable.command, [...executable.prefixArgs, ...args], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let overflowed = false;
  let timer: NodeJS.Timeout | undefined;

  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    action();
  };

  timer = setTimeout(() => {
    child.kill();
    settle(() =>
      reject(
        new OmpUnavailableError(
          `\`${path.basename(executable.command)} ${args.join(" ")}\` did not finish within ${timeoutMs}ms.`,
          { transientCause: `did not finish within ${formatDuration(timeoutMs)}` },
        ),
      ),
    );
  }, timeoutMs);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > MAX_CLI_OUTPUT_CHARS) {
      overflowed = true;
      child.kill();
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", error => {
    const transientCause = transientErrnoCause(error, "started");
    settle(() =>
      reject(
        new OmpUnavailableError(
          `Could not run ${executable.command}: ${error.message}`,
          transientCause === undefined ? {} : { transientCause },
        ),
      ),
    );
  });
  child.on("close", (code, signal) => {
    // A signal this module sent itself (the output limit) is not news about the machine.
    const killedByOther = signal !== null && !overflowed;
    settle(() =>
      resolve({ stdout, stderr, exitCode: code ?? -1, ...(killedByOther ? { signal } : {}) }),
    );
  });

  return await promise;
}

/**
 * OMP's own sentinel for the default profile.
 *
 * OMP's CLI bootstrap strips `--profile` and `normalizeProfileName("default")`
 * maps it back to the default profile, so this is a verified way to *select* the
 * default rather than merely omitting the flag — an inherited
 * `OMP_PROFILE`/`PI_PROFILE` cannot then claim the session. Exported for the
 * callers that must name the same profile for a session's OMP CLI reads (the
 * documented environment equivalent is `OMP_PROFILE=default`).
 */
export const DEFAULT_OMP_PROFILE = "default";

// The runtime flags that hand the public recipient to the host-control module are built in
// `runtime-flags.ts`, by the launcher's kind; the recipient is public by construction, so a `--define` literal
// is the right carrier: the control key and the private recipient stay out of argv, the environment and stdin.

/** Host-control bootstrap for one launch; the module itself is never secret. */
export interface NativeControlBootstrap {
  /** bun `--define` symbol the native module reads the public recipient from. */
  readonly defineName: string;
  /** Public recipient key (SPKI, base64url); embedded in the define, never secret. */
  readonly publicRecipient: string;
  /**
   * Absolute path of the host-control module this launch loads with `--preload`
   * and `-e`: the verified copy staged outside the installed extension folder, so
   * the native process holds no file there and a reinstall can rename it.
   */
  readonly modulePath: string;
  /**
   * Absolute path of the staged module a launcher capability probe preloads (`launch-capability.ts`) to learn
   * whether the launcher honours `--preload` and `--define` carried by `BUN_OPTIONS`.
   */
  readonly probeModulePath: string;
  /** Directory the native host publishes its rendezvous record into. */
  readonly directory: string;
  /** Non-secret slot id for this launch. */
  readonly slotId: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStderr(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line.length === 0 ? "" : `: ${line.slice(0, 400)}`;
}

// Stopped-session title: the installed agent's own storage code, run by Bun

/**
 * The name a Bun executable has on this platform. On Windows the extensionless `bun` is never one: Bun's program file is `bun.exe`, and a
 * file with no extension is at best a script for another shell, not something started as a program.
 */
const BUN_EXECUTABLE_NAMES: readonly string[] =
  process.platform === "win32" ? ["bun.exe"] : ["bun"];

/**
 * The Bun runtime this machine can run a helper with, or `null`.
 *
 * The extension host is Node and the installed agent is TypeScript whose storage
 * code can only be imported by Bun, so the stopped-session rename needs a Bun
 * *runtime* — never the OMP program itself, which would open a session. The probe
 * is deliberately local and bounded: the documented install locations first, then
 * PATH, and nothing is downloaded.
 */
export async function resolveBunRuntime(): Promise<string | null> {
  const candidates: string[] = [];
  const bunInstall = process.env.BUN_INSTALL ?? "";
  if (bunInstall.length > 0) {
    for (const name of BUN_EXECUTABLE_NAMES) candidates.push(path.join(bunInstall, "bin", name));
  }
  for (const name of BUN_EXECUTABLE_NAMES) candidates.push(path.join(os.homedir(), ".bun", "bin", name));
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (entry.length === 0) continue;
    for (const name of BUN_EXECUTABLE_NAMES) candidates.push(path.join(entry, name));
  }
  for (const candidate of candidates) {
    if (await isRunnableFile(candidate)) return candidate;
  }
  return null;
}

/** Where the installed agent's own importable package source lives, when it does. */
export interface OmpPackageRoot {
  readonly root: string;
  readonly version: string | null;
  /** Which install layout the root was derived from, for a truthful diagnostic. */
  readonly origin: string;
}

/**
 * Resolve the *selected* OMP launch's own package source, or `null`.
 *
 * The helper imports `session/session-storage`, so it needs real source files. A runtime launch
 * names the entry script it runs, and the package that holds that entry — the nearest ancestor
 * whose manifest names OMP's package — is the one and only root. It is validated by name, by the
 * presence of the storage module and, when the launch reported a release, by that exact release.
 *
 * Nothing else is searched. A compiled single-file install carries its code inside the binary and
 * has no entry to follow, so it has no importable root and gets `null`: the caller must refuse with
 * a capability message instead of reaching for another install's package, because a package of
 * the same release number elsewhere on the machine is not evidence of being this install's source.
 * A directory that cannot be read right now ends the lookup with a transient error, never with
 * another root.
 */
export async function resolveOmpPackageRoot(
  executable: OmpCommand & { readonly version?: string | null },
): Promise<OmpPackageRoot | null> {
  const entry = executable.prefixArgs.at(-1);
  if (entry === undefined) return null;
  const dir = await packageDirectoryOf(entry);
  if (dir === null) return null;
  const manifest = await readPackageManifest(dir);
  if (manifest === null) return null;
  const expected = executable.version ?? null;
  if (expected !== null && manifest.version !== expected) return null;
  try {
    const stats = await fs.stat(path.join(dir, "src", "session", "session-storage.ts"));
    if (!stats.isFile()) return null;
  } catch (error) {
    rethrowIfTransientInspection(dir, error);
    return null;
  }
  return { root: dir, version: manifest.version ?? null, origin: "the package of the selected entry script" };
}

/** The `name` and `version` of the package manifest in `dir`, or `null` when there is none that reads. */
async function readPackageManifest(dir: string): Promise<{ readonly name?: unknown; readonly version?: string } | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  } catch (error) {
    rethrowIfTransientInspection(dir, error);
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;
  const { name, version } = manifest as { name?: unknown; version?: unknown };
  return typeof version === "string" ? { name, version } : { name };
}

/** The directory of the OMP package that holds `entry`: the nearest ancestor whose manifest names it. */
async function packageDirectoryOf(entry: string): Promise<string | null> {
  let dir = path.dirname(entry);
  for (;;) {
    const manifest = await readPackageManifest(dir);
    if (manifest !== null && manifest.name === OMP_PACKAGE_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** What one stopped-session rename produced. */
export interface StoppedRenameOutcome {
  readonly ok: boolean;
  /** `true` only when the stored title read back as the requested one. */
  readonly verified: boolean;
  readonly title: string | null;
  /** Whether OMP's recent-session index was updated too. */
  readonly index: "synced" | "unsynced";
  readonly detail: string | null;
}

/** How long the helper may take before it is treated as failed. */
const RENAME_HELPER_TIMEOUT_MS = 30_000;

/**
 * Run the bounded Bun helper that performs a stopped-session rename.
 *
 * The helper is given the exact file and the expected session id, revalidates both
 * itself and reports one JSON line. Nothing here retries: an unverified rename is
 * reported as such, and the caller keeps whatever it already knew.
 */
export async function renameStoppedSessionTitle(input: {
  readonly bunPath: string;
  readonly packageRoot: string;
  readonly helperPath: string;
  readonly file: string;
  readonly title: string;
  readonly sessionId: string | null;
}): Promise<StoppedRenameOutcome> {
  const args = [
    input.helperPath,
    "--package-root",
    input.packageRoot,
    "--file",
    input.file,
    "--title",
    input.title,
    ...(input.sessionId === null ? [] : ["--session-id", input.sessionId]),
  ];
  const outcome = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly failed: string | null }>(
    resolve => {
      let settled = false;
      const finish = (value: { code: number | null; stdout: string; stderr: string; failed: string | null }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const child = spawn(input.bunPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* the child may already be gone */
        }
        finish({ code: null, stdout: "", stderr: "", failed: `the rename helper did not finish within ${RENAME_HELPER_TIMEOUT_MS}ms` });
      }, RENAME_HELPER_TIMEOUT_MS);
      timer.unref?.();
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", chunk => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", chunk => {
        stderr += String(chunk);
      });
      child.on("error", error => finish({ code: null, stdout, stderr, failed: messageOf(error) }));
      child.on("close", code => finish({ code, stdout, stderr, failed: null }));
    },
  );
  if (outcome.failed !== null) return { ok: false, verified: false, title: null, index: "unsynced", detail: outcome.failed };
  const line = outcome.stdout.trim().split(/\r?\n/).filter(part => part.startsWith("{")).at(-1) ?? null;
  let parsed: unknown = null;
  if (line !== null) {
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      verified: false,
      title: null,
      index: "unsynced",
      detail: `the rename helper printed no result (exit ${outcome.code ?? "unknown"})`,
    };
  }
  const record = parsed as Record<string, unknown>;
  const index = record.index === "synced" ? "synced" : "unsynced";
  const detail = typeof record.detail === "string" ? record.detail : null;
  if (record.verified !== true || record.ok !== true) {
    return { ok: false, verified: false, title: null, index, detail: detail ?? "the rename helper refused or failed" };
  }
  return { ok: true, verified: true, title: typeof record.title === "string" ? record.title : null, index, detail };
}


/**
 * The terminal-pipeline port satisfied by one attached broker handle.
 *
 * The pipeline is deliberately ignorant of the native transport: this adapter is
 * the only place the broker's own vocabulary (`outputPosition`, `nativePid`,
 * numeric signals) meets the renderer's.
 */
export function terminalWriterForHandle(handle: PtyHandle): TerminalWriter {
  let last: PtyStatusPayload | null = null;
  return {
    get nativePid(): number {
      return handle.nativePid ?? 0;
    },
    get nativeCreationTime(): string | null {
      return last?.nativeCreationTime ?? null;
    },
    async status(): Promise<TerminalWriterStatus> {
      const status = await handle.refreshStatus();
      last = status;
      return {
        state: status.state === "running" ? "running" : "exited",
        exitCode: status.exitCode,
        signal: status.signal === null ? null : String(status.signal),
        cols: status.cols,
        rows: status.rows,
        alt: status.alt,
        title: status.title,
        seq: status.outputPosition,
        oldestSeq: status.oldestPosition,
        inputOwner: status.inputOwner,
        notices: status.notices,
      };
    },
    async snapshot(): Promise<TerminalWriterSnapshot> {
      const snapshot = await handle.snapshot();
      return {
        seq: snapshot.meta.position,
        cols: snapshot.meta.cols,
        rows: snapshot.meta.rows,
        alt: snapshot.meta.alt,
        truncated: snapshot.meta.truncated,
        data: placeSnapshotCursor(snapshot.data, { x: snapshot.meta.cursorX, y: snapshot.meta.cursorY, cols: snapshot.meta.cols }),
      };
    },
    async write(data: string, frontendId: string): Promise<void> {
      await handle.write(data, frontendId);
    },
    async resize(cols: number, rows: number, frontendId: string): Promise<void> {
      await handle.resize(cols, rows, frontendId);
    },
    async claimInput(frontendId: string, takeover: boolean): Promise<string | null> {
      return (await handle.claimInput(frontendId, { takeover })).frontendId;
    },
    async releaseInput(frontendId: string): Promise<void> {
      await handle.releaseInput(frontendId);
    },
    watch(listener: (event: TerminalWriterEvent) => void): () => void {
      return handle.subscribe(event => {
        if (event.type === "input-owner") {
          listener({ kind: "input-owner", frontendId: event.frontendId });
          return;
        }
        if (event.type === "closed") {
          listener({ kind: "closed" });
          return;
        }
        if (event.type === "output") {
          listener({ kind: "output", seq: event.fromPosition, data: event.data });
          return;
        }
        if (event.type === "state") {
          last = event.status;
          // An exit is reported through the status the broker pushes, so the
          // pipeline retires the pane without polling for it.
          if (event.status.state === "exited") {
            listener({
              kind: "exit",
              seq: event.status.outputPosition,
              code: event.status.exitCode,
              signal: event.status.signal === null ? null : String(event.status.signal),
            });
          }
        }
        // A closed connection is a detached frontend, not proof that the child
        // exited: an unreachable broker must never retire a live writer's row.
      });
    },
  };
}
