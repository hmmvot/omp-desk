/**
 * Image format of a file from its signature, shared by the composer (a picked or pasted file) and the host (a dropped
 * path), so both refuse the same bytes.
 */

/** The formats OMP accepts as prompt input (pi-utils `SUPPORTED_IMAGE_MIME_TYPES`). */
export type SniffedImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Full PNG signature: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** JPEG start of image plus the first marker prefix. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/** RIFF container magic and the WebP form type that must follow its size field. */
const RIFF_SIGNATURE = [..."RIFF"].map(character => character.charCodeAt(0));
const WEBP_FORM_TYPE = [..."WEBP"].map(character => character.charCodeAt(0));

/**
 * MIME type of `bytes` from its file signature, or `null` when it is not one of
 * the formats the host advertises.
 *
 * A signature is a structural check, not a decode: a truncated or corrupt file
 * whose header is intact still passes here and is left to the provider boundary
 * (and the model) to reject. What this does catch is a file that is not that
 * format at all — which matters because the host forwards `mimeType` straight
 * to the model provider, and a mislabeled payload is a provider error rather
 * than a visible failure. The declared `File.type` is a hint from an OS
 * extension mapping (empty for some clipboard and renamed files); the bytes
 * decide.
 */
export function sniffImageMimeType(bytes: Uint8Array): SniffedImageMimeType | null {
	if (signatureAt(bytes, 0, PNG_SIGNATURE)) return "image/png";
	if (signatureAt(bytes, 0, JPEG_SIGNATURE)) return "image/jpeg";
	// GIF87a / GIF89a: the 6-byte version-stamped header.
	const gifHeader = ascii(bytes, 0, 6);
	if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
	if (signatureAt(bytes, 0, RIFF_SIGNATURE) && signatureAt(bytes, 8, WEBP_FORM_TYPE)) return "image/webp";
	return null;
}

/** Image formats OMP does not take but whose signature is unmistakable, so a refusal can name them instead of calling the file text. */
export type UnsupportedImageMimeType = "image/bmp" | "image/tiff" | "image/heic" | "image/avif";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/**
 * The image format `bytes` is, when it is a known one that is not in {@link SniffedImageMimeType}: BMP (with its zeroed
 * reserved field, which a text file starting with "BM" does not have), TIFF, HEIC and AVIF.
 */
export function sniffUnsupportedImageMimeType(bytes: Uint8Array): UnsupportedImageMimeType | null {
	if (signatureAt(bytes, 0, [0x42, 0x4d]) && bytes.length >= 14 && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0) return "image/bmp";
	if (signatureAt(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || signatureAt(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
	if (ascii(bytes, 4, 4) === "ftyp") {
		const brand = ascii(bytes, 8, 4);
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (HEIC_BRANDS.has(brand)) return "image/heic";
	}
	return null;
}

/** True when `signature` sits at `offset` in `bytes`. */
function signatureAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
	if (bytes.length < offset + signature.length) return false;
	for (let index = 0; index < signature.length; index++) {
		if (bytes[offset + index] !== signature[index]) return false;
	}
	return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let text = "";
	for (let index = offset; index < offset + length; index++) text += String.fromCharCode(bytes[index] ?? 0);
	return text;
}
