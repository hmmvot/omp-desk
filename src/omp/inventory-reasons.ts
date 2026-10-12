import { REASON_LIMIT } from "../host/inventory/inventory-model.ts";

/**
 * The reason a view's list may be incomplete, as the banner and the Desk log show it (ADR-0061, item 10).
 * OMP's warnings interpolate configuration values (plugin ids, server names, parser exception text, URLs), so none
 * of them is forwarded: a warning is projected onto a fixed template that keeps only the provider's display name
 * and, for a few known shapes, the local file the warning names. Anything else becomes a category with no payload.
 */

/** Warnings that mean a source was skipped or unreadable, not a naming notice: such a list can be incomplete. */
// (A missing optional file such as `<ancestor>/.vscode/mcp.json` is reported as "Failed to read" and is not an omission.)
export const OMISSION = /Failed to (load|parse)|Invalid (item|plugin|JSON|config)|no installPath/i;


/** The validator's own sentences (capability/mcp.ts `validate`): fixed vocabulary, safe to repeat. */
const VALIDATION_SENTENCES: readonly string[] = [
  "Missing server name", "Must have command or url", "stdio transport requires command field", "http/sse transport requires url field",
];

function oneLine(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
}

/** A local file path at the start of `text`, or `null`: drive or rooted, no URL, no query or fragment, cut at the first `: ` that follows the drive letter. */
function localPath(text: string): string | null {
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(text)) return null;
  const cut = text.indexOf(": ", 2);
  const candidate = (cut < 0 ? text : text.slice(0, cut)).trim();
  return candidate.length > 0 && candidate.length <= 260 && !/[?#@=]/.test(candidate) && !/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(candidate) ? candidate : null;
}

/** One OMP warning as a credential-free sentence. */
export function projectWarning(raw: string): string {
  return projectUnbounded(raw).slice(0, REASON_LIMIT);
}
function projectUnbounded(raw: string): string {
  const warning = oneLine(raw);
  const bracket = /^\[([^\]]{1,60})\]\s*(.*)$/.exec(warning);
  const provider = bracket === null ? null : bracket[1]!;
  const message = bracket === null ? warning : bracket[2]!;
  const prefix = provider === null || /[^\w .:+/()-]/.test(provider) ? "" : `[${provider}] `;
  const file = (pattern: RegExp): string | null => { const found = pattern.exec(message)?.[1]; return found === undefined ? null : localPath(found); };

  const parseJson = file(/^(?:Failed to parse JSON|Invalid JSON) in (.+)$/);
  if (parseJson !== null) return `${prefix}${message.startsWith("Invalid") ? "Invalid" : "Failed to parse"} JSON in ${parseJson}`;
  const jsonSuffix = /^(.+): invalid JSON$/.exec(message)?.[1];
  const suffixed = jsonSuffix === undefined ? null : localPath(jsonSuffix);
  if (suffixed !== null) return `${prefix}Invalid JSON in ${suffixed}`;
  const item = /^Invalid item at (.+?): (.+)$/.exec(message);
  if (item !== null) {
    const where = localPath(item[1]!);
    const why = VALIDATION_SENTENCES.includes(item[2]!) ? `: ${item[2]}` : "";
    return `${prefix}Invalid item${where === null ? "" : ` at ${where}`}${why}`;
  }
  const parse = file(/^Failed to parse (?:[A-Za-z ]+registry: )?(.+)$/);
  if (parse !== null) return `${prefix}Failed to parse ${parse}`;
  if (/Invalid plugin|no installPath|missing @marketplace/i.test(message)) return `${prefix}a plugin entry is invalid (details are in OMP's own log)`;
  if (/^Failed to load/i.test(message)) return `${prefix}failed to load (details are in OMP's own log)`;
  return `${prefix}reported a problem loading its sources (details are in OMP's own log)`;
}

/** A thrown loader's failure: its category (error class), never its message. */
export function projectFailure(what: string, error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name) ? error.name : "error";
  return `${what} failed (${name}; details are in OMP's own log)`.slice(0, REASON_LIMIT);
}
