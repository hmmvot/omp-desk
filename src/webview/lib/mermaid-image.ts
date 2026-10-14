/** A drawn diagram as an image the page can show: a `data:` URL (the document's `img-src` allows nothing else of ours) the browser has decoded. */
export type MermaidImage = { readonly ok: true; readonly src: string } | { readonly ok: false; readonly message: string };

/** The SVG as a decoded image source, or why it cannot be shown (an image the browser cannot decode). */
export async function mermaidImage(svg: string): Promise<MermaidImage> {
	const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	// An image the browser cannot decode would show as a broken icon after the swap; find out first.
	try {
		const probe = new Image();
		probe.src = src;
		await probe.decode();
	} catch {
		return { ok: false, message: "The diagram could not be displayed" };
	}
	return { ok: true, src };
}
