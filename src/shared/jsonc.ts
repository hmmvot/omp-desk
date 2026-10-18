/**
 * JSON with comments and trailing commas, as VS Code's own settings files are written (a BOM, `//` and `/* *\/` comments,
 * a comma before a closing bracket). Shared by the code-theme reader and the keybindings reader.
 */

/** `text` as plain JSON: comments and trailing commas removed; the contents of strings are left alone. */
export function stripJsonc(text: string): string {
	const out: string[] = [];
	// The position in `out` of a comma that no value has followed yet, or -1.
	let comma = -1;
	let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			out.push(text.slice(i, end + 1));
			comma = -1;
			i = end + 1;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			out.push(ch);
			i++;
		} else {
			if (ch === "}" || ch === "]") {
				if (comma !== -1) out[comma] = "";
				comma = -1;
			} else if (ch === ",") {
				comma = out.length;
			} else {
				comma = -1;
			}
			out.push(ch);
			i++;
		}
	}
	return out.join("");
}

/** The value of a JSONC document. Throws a `SyntaxError` when it is not one. */
export function parseJsonc(text: string): unknown {
	return JSON.parse(stripJsonc(text));
}
