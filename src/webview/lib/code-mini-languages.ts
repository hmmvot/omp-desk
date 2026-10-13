/**
 * Two languages highlight.js has no grammar for: ignore files (`.gitignore`, `.dockerignore`) and HCL
 * (Terraform). Each is a small scanner whose output is the HTML shape highlight.js produces
 * (`<span class="hljs-…">`), so the one classifier in `code-tokens.ts` names their tokens too.
 */

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, character => ESCAPES[character] as string);
}

function span(className: string, text: string): string {
	return `<span class="hljs-${className}">${escapeHtml(text)}</span>`;
}

/** Ignore files: a comment is a line starting with `#`; `!` negates a pattern; `*`, `**`, `?` and `[…]` are globs. */
export function highlightIgnore(source: string): string {
	let html = "";
	for (const line of source.split(/(?<=\n)/)) {
		if (line.startsWith("#")) {
			const body = line.endsWith("\n") ? line.slice(0, -1) : line;
			html += span("comment", body) + escapeHtml(line.slice(body.length));
			continue;
		}
		let at = 0;
		if (line.startsWith("!")) {
			html += span("negation", "!");
			at = 1;
		}
		const rest = line.slice(at);
		let cursor = 0;
		for (const glob of rest.matchAll(/\\.|\*+|\?|\[[^\]\n]*\]/g)) {
			html += escapeHtml(rest.slice(cursor, glob.index));
			html += glob[0].startsWith("\\") ? escapeHtml(glob[0]) : span("glob", glob[0]);
			cursor = glob.index + glob[0].length;
		}
		html += escapeHtml(rest.slice(cursor));
	}
	return html;
}

const HCL_KEYWORDS: Readonly<Record<string, true>> = { for: true, in: true, if: true, else: true, endif: true, endfor: true };
const HCL_LITERALS: Readonly<Record<string, true>> = { true: true, false: true, null: true };
/** One token of HCL, tried in order at the current position. */
const HCL_TOKEN = /(\s+)|(#[^\n]*|\/\/[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|(<<-?([A-Za-z_]\w*)\n[\s\S]*?\n[ \t]*\5(?=\n|$))|("(?:\\.|[^"\\\n])*"?)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][\w-]*)|([\s\S])/y;

/** HCL: comments, strings and heredocs, numbers, `true`/`false`/`null`, the `for`/`in`/`if` words, block types, attribute names and function calls. */
export function highlightHcl(source: string): string {
	let html = "";
	HCL_TOKEN.lastIndex = 0;
	let lineStart = true;
	/** After a block type on its line: quoted strings are the block's labels. */
	let blockHeader = false;
	for (let match = HCL_TOKEN.exec(source); match !== null; match = HCL_TOKEN.exec(source)) {
		const [text] = match;
		if (match[1] !== undefined) {
			html += escapeHtml(text);
			if (text.includes("\n")) {
				lineStart = true;
				blockHeader = false;
			}
			continue;
		}
		const start = match.index;
		if (match[2] !== undefined || match[3] !== undefined) html += span("comment", text);
		else if (match[4] !== undefined) html += span("string", text);
		else if (match[6] !== undefined) html += span(blockHeader ? "label" : "string", text);
		else if (match[7] !== undefined) html += span("number", text);
		else if (match[8] !== undefined) {
			const rest = source.slice(start + text.length, start + text.length + 80).split("\n", 1)[0] as string;
			if (Object.hasOwn(HCL_LITERALS, text)) html += span("literal", text);
			else if (Object.hasOwn(HCL_KEYWORDS, text)) html += span("keyword", text);
			else if (/^\s*\(/.test(rest)) html += span("title function_", text);
			else if (/^\s*=(?!=)/.test(rest)) html += span("attr", text);
			else if (lineStart && /^\s*(?:"|[A-Za-z_]|\{)/.test(rest)) {
				html += span("block", text);
				blockHeader = true;
			} else html += escapeHtml(text);
		} else html += escapeHtml(text);
		lineStart = false;
	}
	return html;
}
