/**
 * A `read` of an internal `skill://` URL: which skill the call names, and where OMP says that skill's file is.
 *
 * OMP's read tool (tools/read.ts, internal-urls/skill-protocol.ts) accepts `skill://<name>` (the skill's SKILL.md),
 * `skill://<name>/<file>` (a file inside the skill's folder) and either with a read selector tail (`:50-80`, `:raw`).
 * A file-backed result records the real file in `details.resolvedPath` and, unless the read was `:raw`, opens its text
 * with a pure-metadata first line `[Skill file: <absolute path>]`. An MCP-served skill has neither, so it gets no link.
 */

/** What a `skill://` call names. `file` is the path inside the skill's folder, `selector` the read selector tail; both null when absent. */
export interface SkillRead { readonly name: string; readonly file: string | null; readonly selector: string | null }

/** A skill read as a row shows it: `label` is the target text and `path` the real file, null while the call runs or when the result names none. */
export interface SkillReadView extends SkillRead { readonly label: string; readonly path: string | null }

// The selector chunks OMP's read tool accepts (tui/tools/line-ranges.ts), the same set the Read row peels from a file path.
const RANGE = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const SELECTOR = new RegExp(`^(?:${RANGE}(?:,${RANGE})*|-\\d+|raw|conflicts|img)$`, "i");
const SKILL_URL = /^skill:\/\/([^\r\n]+)$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEADER = /^\[Skill file: (.+)\]$/;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|\/)/;

/** The skill a `read` path names, or null when it is not a well-formed `skill://` URL (no name, an empty or dot segment, a query or fragment, a bad escape). */
export function parseSkillUrl(input: unknown): SkillRead | null {
	if (typeof input !== "string") return null;
	const match = SKILL_URL.exec(input.trim());
	if (match === null) return null;
	let rest = match[1]!;
	const selectors: string[] = [];
	while (selectors.length < 2) {
		const colon = rest.lastIndexOf(":");
		if (colon < 0 || !SELECTOR.test(rest.slice(colon + 1))) break;
		selectors.unshift(rest.slice(colon + 1));
		rest = rest.slice(0, colon);
	}
	if (/[?#\\]/.test(rest)) return null;
	const segments = rest.split("/");
	if (segments.length > 1 && segments.at(-1) === "") segments.pop();
	const decoded: string[] = [];
	for (const segment of segments) {
		let value: string;
		try { value = decodeURIComponent(segment); } catch { return null; }
		if (value === "" || value === "." || value === ".." || CONTROL.test(value) || /[/\\]/.test(value)) return null;
		decoded.push(value);
	}
	const [name, ...file] = decoded;
	if (name === undefined || /[\s:]/.test(name)) return null;
	return { name, file: file.length > 0 ? file.join("/") : null, selector: selectors.length > 0 ? selectors.join(":") : null };
}

const absolutePath = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const path = value.trim();
	return path !== "" && ABSOLUTE.test(path) && !CONTROL.test(path) ? path : null;
};

/** The file a settled skill read opened: the result's `resolvedPath`, else the path in the `[Skill file: …]` first line; null when neither is an absolute path. */
export function skillFilePath(details: Record<string, unknown>, text: string): string | null {
	const resolved = absolutePath(details.resolvedPath);
	if (resolved !== null) return resolved;
	const header = HEADER.exec((text.split("\n", 1)[0] ?? "").replace(/\r$/, ""));
	return header === null ? null : absolutePath(header[1]);
}

/** `text` without its `[Skill file: …]` first line, which only repeats the path the row's link already carries. */
export function stripSkillHeader(text: string): string {
	const end = text.indexOf("\n");
	const first = (end < 0 ? text : text.slice(0, end)).replace(/\r$/, "");
	return HEADER.test(first) ? end < 0 ? "" : text.slice(end + 1) : text;
}

/**
 * How a `read` of `pathArgument` presents as a skill, or null when it does not name one.
 * `settled` is true only for a finished, successful call: until then, and for a failed call, the name carries no path and so no link.
 */
export function skillReadView(pathArgument: unknown, details: Record<string, unknown>, text: string, settled: boolean): SkillReadView | null {
	const read = parseSkillUrl(pathArgument);
	if (read === null) return null;
	const label = `${read.name}${read.file === null ? "" : ` / ${read.file}`}${read.selector === null ? "" : `:${read.selector}`}`;
	return { ...read, label, path: settled ? skillFilePath(details, text) : null };
}
