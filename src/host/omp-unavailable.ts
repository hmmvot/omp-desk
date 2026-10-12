/**
 * The error the installed OMP's resolution and CLI calls throw, and how a failure is classified.
 *
 * Kept free of `vscode` and of every other host module so a plain-Node consumer (the inventory
 * runtime resolver) can read the classification without loading the extension.
 *
 * A failure is either **definitive** or **transient**. A definitive failure says something about
 * the candidate itself — the file is missing or may not be opened, is not OMP's program, is a foreign
 * launcher, or the `--version` probe ran and exited non-zero — and the next candidate on PATH may be
 * tried. A transient failure says nothing about the candidate: the machine could not inspect or run
 * it *right now* (the probe ran past its limit, the process or file could not be created or opened for
 * lack of resources, the file was busy, a signal ended the probe). Moving on to a lower-priority
 * candidate after one would start an older OMP than the one PATH selects, which is how a busy machine
 * silently launched a stale install; the resolution therefore fails instead.
 */
export class OmpUnavailableError extends Error {
  /**
   * Why the failure says nothing about the candidate, phrased to follow a subject
   * ("did not finish within 15 s"); `undefined` for a definitive failure.
   */
  readonly transientCause: string | undefined;

  constructor(message: string, options: { readonly transientCause?: string } = {}) {
    super(message);
    this.name = "OmpUnavailableError";
    this.transientCause = options.transientCause;
  }
}

/** Whether an error is a transient OMP failure (see {@link OmpUnavailableError}). */
export function isTransientOmpFailure(error: unknown): error is OmpUnavailableError {
  return error instanceof OmpUnavailableError && error.transientCause !== undefined;
}

/** What every transient resolution failure tells the user about the choice it refused to make. */
export const NO_FALLBACK_NOTICE =
  "Desk does not fall back to another OMP, because that could start an older release than the one " +
  "it selects. Try again when the machine is less busy.";

/**
 * Error codes that mean "the system could not do this now", as opposed to a statement about the
 * file: out of processes, handles or memory, a file busy (a Windows sharing violation, or a file
 * being written by an update), an interrupted call. `ENOENT`, `EACCES`, `ENOEXEC` and the like are
 * definitive.
 */
const TRANSIENT_ERRNO_CODES: Record<string, true> = {
  EAGAIN: true,
  EBUSY: true,
  EINTR: true,
  EMFILE: true,
  ENFILE: true,
  ENOMEM: true,
  ETIMEDOUT: true,
  ETXTBSY: true,
};

/**
 * The setting that names the OMP to run explicitly (machine scope: user settings only, never a
 * workspace). Empty means PATH decides. Defined here, free of `vscode`, so the Settings view's
 * pure model, the controller and the resolver agree on the key.
 */
export const OMP_PATH_SETTING = "omp.executablePath";

/**
 * The transient cause of a failed system call (`started` for a spawn, `read` for an inspection), or
 * `undefined` when the failure is definitive.
 */
export function transientErrnoCause(error: unknown, action: "started" | "read"): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { readonly code?: unknown; readonly message?: unknown };
  if (typeof code !== "string" || TRANSIENT_ERRNO_CODES[code] !== true) return undefined;
  return `could not be ${action} right now (${code}: ${typeof message === "string" ? message : "no detail"})`;
}

/**
 * Called from a `catch` that treats a failed inspection of `file` as "not a candidate": a
 * missing or unreadable file stays that, but a failure that only says the machine is busy ends the
 * whole resolution, because a lower-priority install must not be chosen over a file that could not
 * be looked at.
 */
export function rethrowIfTransientInspection(file: string, error: unknown): void {
  const transientCause = transientErrnoCause(error, "read");
  if (transientCause === undefined) return;
  throw new OmpUnavailableError(`${file} ${transientCause}; ${NO_FALLBACK_NOTICE}`, { transientCause });
}

/** A duration as the user reads it: `15 s` for whole seconds, `250 ms` otherwise. */
export function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
