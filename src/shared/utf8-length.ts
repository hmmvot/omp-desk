/** Bytes of `text` in UTF-8 (a lone surrogate is the three bytes of U+FFFD, as `TextEncoder` writes it), counted without encoding a 200 000-character file. */
export function utf8Length(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const unit = text.charCodeAt(index);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
			bytes += 4;
			index++;
		} else bytes += 3;
	}
	return bytes;
}
