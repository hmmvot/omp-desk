import { useState } from "react";
import type { CSSProperties } from "react";

/** Only inert raster images are embedded; provider payloads are never displayed. */
const EMBEDDABLE_MIME = /^image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)$/i;

export const IMAGE_UNAVAILABLE_TEXT = "Image not available in saved history";

/**
 * One transcript image. `data` is base64 bytes. A history entry whose bytes the host could not resolve still carries
 * OMP's `blob:sha256:…` reference (the blob is missing, unreadable or too large), and an image the browser cannot decode
 * is equally unusable: both render a labelled placeholder, never the browser's broken-image glyph.
 */
export function SavedImage({ mimeType, data, alt, className, style }: { mimeType: string; data: string; alt: string; className?: string; style?: CSSProperties }) {
	const [failed, setFailed] = useState(false);
	if (!EMBEDDABLE_MIME.test(mimeType)) return <span>Image attachment ({mimeType}) — inline preview unavailable</span>;
	if (failed || data.startsWith("blob:")) return <span className="omp-image-unavailable" role="img" aria-label={IMAGE_UNAVAILABLE_TEXT}>{IMAGE_UNAVAILABLE_TEXT}</span>;
	return <img className={className} style={style} src={`data:${mimeType};base64,${data}`} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
