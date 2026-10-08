/** Display text only: one XML-safe line, bounded without splitting Unicode code points. */
export function notificationLine(value: string, limit = 200): string {
	const newline = value.search(/[\r\n\u2028\u2029]/);
	const line = (newline === -1 ? value : value.slice(0, newline))
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufffe\uffff]/g, "")
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
		.trim();
	let end = 0;
	for (let count = 0; count < limit && end < line.length; count++) {
		end += (line.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
	}
	return end === line.length ? line : line.slice(0, end);
}
