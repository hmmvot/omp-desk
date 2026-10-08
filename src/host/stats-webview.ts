function escapeAttribute(value: string): string {
	return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** The iframe owns its same-origin APIs/SSE; the outer document receives no host capabilities. */
export function statsWebviewHtml(mappedUri: string, nonce: string): string {
	const uri = new URL(mappedUri);
	if (uri.protocol !== "http:" && uri.protocol !== "https:") throw new Error("The Stats dashboard requires an HTTP editor address.");
	const source = escapeAttribute(uri.href);
	const origin = escapeAttribute(uri.origin);
	return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}';"><style nonce="${nonce}">html,body,iframe{width:100%;height:100%;margin:0;padding:0;border:0}body{overflow:hidden}</style></head><body><iframe src="${source}" title="OMP Stats dashboard" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe></body></html>`;
}
