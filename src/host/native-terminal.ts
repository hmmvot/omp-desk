/**
 * The installed OMP as a process this extension can start and inspect.
 *
 * This module owns everything that touches the installed `omp` binary: resolving it
 * from PATH (a runtime plus entry script, or OMP's own compiled program — never a
 * launcher that forwards to another process), running one-shot CLI commands, the
 * visible provider-login terminal, the bun runtime and package-root lookups, and the
 * stopped-session title helper.
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
import * as vscode from "vscode";
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
} from "./omp-unavailable";

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

export interface OmpBinary extends OmpCommand {
  /** Release `omp --version` reported, when it reported one; a diagnostic only. */
  readonly version: string | null;
  /** How this target was resolved; surfaced in diagnostics. */
  readonly origin: string;
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

/** One visible provider-login terminal: the command, where it runs, and its scope. */
export interface ProviderLoginTerminalRequest {
  /** Argument list after the executable's own prefix, e.g. `["login","anthropic"]`. */
  readonly args: readonly string[];
  /** The exact target this session runs, so the login lands in the same install. */
  readonly executable: OmpCommand;
  /** Working directory of the session the login was requested from. */
  readonly cwd: string;
  /** Environment for the command, including the session's config overlay. */
  readonly env: Readonly<Record<string, string>>;
  /** Visible terminal title, e.g. `omp login`. */
  readonly name: string;
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
  const explicitPath = (options.explicitPath ?? configuredOmpPath()).trim();
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
 * The explicit OMP path the user set (`omp.executablePath`, machine scope, so a workspace can never
 * name a program to run), or the empty string when PATH decides.
 */
export function configuredOmpPath(): string {
  const value = vscode.workspace.getConfiguration("omp").get<unknown>(OMP_PATH_SETTING.slice("omp.".length));
  return typeof value === "string" ? value.trim() : "";
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

let ompResolutionLog: ((message: string) => void) | null = null;
let otherInstallsReported = false;
let otherInstallsInFlight = false;

/** Where resolution notes go (the OMP Desk output); the extension sets it once, at activation. */
export function setOmpResolutionLog(sink: ((message: string) => void) | null): void {
  ompResolutionLog = sink;
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
        log(message);
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
            candidate: { executable: { command: file, prefixArgs: [] }, origin: "the OMP launcher directory", label: file },
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
      candidate: { executable: { command: file, prefixArgs: [] }, origin, label: file },
    };
  }
  if (identity === "bun-shim") return { kind: "bun-shim", key: file, shim: file };
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

/** Memoised {@link isOmpRuntimeProgram} answers, keyed by file identity (path, size, mtime). */
const ompProgramScans = new Map<string, boolean>();

/**
 * Does this file *contain* OMP's program, rather than merely run it?
 *
 * The file is streamed and the scan stops as soon as both kinds of marker have
 * been seen, so an installed release is recognised without ever loading it
 * whole into memory and a small wrapper is read in one pass. A file that cannot
 * be read, or that carries no embedded runtime, is not OMP's program.
 *
 * The answer is remembered per file identity — path, size and modification time
 * — because this is a property of those bytes. It is deliberately not a launcher
 * cache: nothing about which target resolution chooses is kept, and a binary the
 * user replaces is scanned again. Admission is also not identity: what makes a
 * process the writer is the child identity its broker recorded, never this scan.
 */
async function isOmpRuntimeProgram(file: string): Promise<boolean> {
  let handle: fs.FileHandle;
  let scanKey: string;
  try {
    const stats = await fs.stat(file);
    scanKey = `${file}\u0000${stats.size}\u0000${stats.mtimeMs}`;
    const remembered = ompProgramScans.get(scanKey);
    if (remembered !== undefined) return remembered;
    handle = await fs.open(file, "r");
  } catch (error) {
    rethrowIfTransientInspection(file, error);
    return false;
  }
  try {
    const buffer = Buffer.allocUnsafe(PROGRAM_SCAN_CHUNK_BYTES + PROGRAM_SCAN_CARRY_BYTES);
    let program = false;
    let runtime = false;
    let carry = 0;
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carry, PROGRAM_SCAN_CHUNK_BYTES, offset);
      if (bytesRead === 0) break;
      const window = buffer.subarray(0, carry + bytesRead);
      if (!program) program = OMP_PROGRAM_MARKERS.some(marker => window.includes(marker));
      if (!runtime) runtime = EMBEDDED_RUNTIME_MARKERS.some(marker => window.includes(marker));
      if (program && runtime) {
        ompProgramScans.set(scanKey, true);
        return true;
      }
      offset += bytesRead;
      const keep = Math.min(PROGRAM_SCAN_CARRY_BYTES, carry + bytesRead);
      buffer.copy(buffer, 0, carry + bytesRead - keep, carry + bytesRead);
      carry = keep;
    }
    ompProgramScans.set(scanKey, false);
    return false;
  } catch (error) {
    rethrowIfTransientInspection(file, error);
    throw error;
  } finally {
    await handle.close();
  }
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
  const bunRoot = path.resolve(binDirectory, "..");
  const bun = await bunRuntime(binDirectory);
  if (bun === null) return `${shim} is a bun shim, but no bun runtime was found beside it in ${binDirectory}`;

  const entry = await bunShimEntry(shim, bunRoot);
  if (entry === null) return `${shim} is a bun shim, but its target entry could not be resolved from ${bunRoot}`;
  return {
    executable: { command: bun, prefixArgs: [entry] },
    origin: `the bun shim ${shim}, resolved to ${entry}`,
    label: shim,
  };
}

async function resolveBunShim(shim: string, rejections: string[], probeTimeoutMs: number): Promise<OmpBinary | null> {
  const candidate = await bunShimCandidate(shim);
  if (typeof candidate === "string") {
    rejections.push(candidate);
    return null;
  }
  return await verifyLaunchCandidate(candidate, rejections, probeTimeoutMs);
}

/** The runtime beside a bun shim, or `bun` from PATH. */
async function bunRuntime(binDirectory: string): Promise<string | null> {
  const names = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  for (const name of names) {
    const candidate = path.join(binDirectory, name);
    if (await isRunnableFile(candidate)) return candidate;
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
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
  return { command, prefixArgs, version, origin: candidate.origin };
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
 * Open the native interactive provider login in a *visible* terminal.
 *
 * `omp login [provider]` is interactive only (readline prompts plus a browser
 * OAuth flow), so the GUI starts it and gets out of the way: this function
 * creates the terminal, shows it, and returns the handle. Nothing the flow
 * prints is read, captured, parsed or logged — the extension never learns the
 * provider URL, the pasted code or the stored credential, and OMP writes the
 * credential into its own store.
 *
 * `isTransient` matches the host terminal for the same reason: the extension
 * owns session restoration, so a reload must not resurrect a login command. The
 * environment carries the session's own `PI_CONFIG_FILES` overlay (when it has
 * one), so the credential is resolved and stored exactly as the session that
 * asked for it would resolve it.
 */
export function openProviderLoginTerminal(request: ProviderLoginTerminalRequest): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: request.name,
    shellPath: request.executable.command,
    shellArgs: [...request.executable.prefixArgs, ...request.args],
    cwd: vscode.Uri.file(request.cwd),
    env: { ...request.env },
    isTransient: true,
    iconPath: new vscode.ThemeIcon("account"),
  });
  terminal.show(false);
  return terminal;
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

/**
 * bun flags that hand the public recipient to the native module.
 *
 * The recipient is public by construction, so a `--define` literal is the right
 * carrier: only the public recipient appears in Bun argv, while the control key
 * and private recipient remain absent from argv, the environment, and stdin.
 */
export function controlRuntimeFlags(control: NativeControlBootstrap | null): string[] {
  if (control === null) return [];
  return [
    "--define",
    `${control.defineName}:${JSON.stringify(control.publicRecipient)}`,
    "--preload",
    control.modulePath,
  ];
}

/**
 * The pty process of a terminal, or undefined while VS Code has not reported it.
 *
 * The resolved command runs OMP in the PTY process itself (including the
 * installed Bun entry), not via the `omp.exe` shim's child. That makes the
 * process-identity comparison against the recorded broker child exact.
 */
async function terminalProcessId(terminal: vscode.Terminal): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  terminal.processId.then(
    pid => resolve(pid),
    () => resolve(undefined),
  );
  return await promise;
}

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
  /** Directory the native host publishes its rendezvous record into. */
  readonly directory: string;
  /** Non-secret slot id for this launch. */
  readonly slotId: string;
}

/**
 * The identical VS Code terminal of a recorded process, when this window still
 * has it. Matching is by exact `processId`; a miss never invents a terminal and
 * never starts a second OMP process.
 */
export async function findTerminalForPid(pid: number): Promise<vscode.Terminal | null> {
  for (const terminal of vscode.window.terminals) {
    if (terminal.exitStatus !== undefined) continue;
    if ((await terminalProcessId(terminal)) === pid) return terminal;
  }
  return null;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStderr(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line.length === 0 ? "" : `: ${line.slice(0, 400)}`;
}

// Stopped-session title: the installed agent's own storage code, run by Bun

/** The name a Bun executable has on this platform. */
const BUN_EXECUTABLE_NAMES: readonly string[] =
  process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];

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
