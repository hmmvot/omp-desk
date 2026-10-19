/**
 * The loopback listener that serves the frame document of a reply's HTML page (`shared/html-page-frame.ts`, ADR-0079).
 *
 * It exists so the page's frame can have its own Content-Security-Policy: a `srcdoc` frame inherits the Chat's policy and its
 * nonce, a `data:`/`blob:` one is no better, and an extension resource URL is not served to a nested navigation. A document
 * fetched over HTTP carries its policy as a header and inherits nothing.
 *
 * What it is, exactly: one `GET` path, constant bytes (the same document and the same policy header for everyone), bound to
 * `127.0.0.1` on an ephemeral port, started only when the setting is on and closed with the extension. It reads no body, keeps no
 * state, logs nothing and has no model text, session data or secret: a request for anything else (other path, other method, a
 * query, a foreign `Host`) is answered `404` with no content, and a request that does arrive carries at most what a page put in a
 * URL it navigated to, which is dropped.
 */
import { createHash } from "node:crypto";
import * as http from "node:http";
import { HTML_PAGE_BOOTSTRAP, HTML_PAGE_FRAME_PATH, htmlPageFrameDocument, htmlPageFramePolicy } from "../shared/html-page-frame.ts";

const MAX_HEADER_BYTES = 4096;

export interface HtmlPageServer {
	/** Binds the listener if it is not bound yet; the port, or `null` when it could not be bound. Concurrent calls share one bind. */
	ensure(): Promise<number | null>;
	/** The bound port, or `null` before {@link ensure} succeeded and after {@link close}. */
	readonly port: number | null;
	close(): Promise<void>;
}

/** The headers every answer carries, the frame's own policy included. */
function frameHeaders(policy: string, type: string, length: number): Record<string, string | number> {
	return {
		"content-type": type,
		"content-length": length,
		"content-security-policy": policy,
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"cache-control": "no-store",
	};
}

export function createHtmlPageServer(): HtmlPageServer {
	const body = Buffer.from(htmlPageFrameDocument(), "utf8");
	const policy = htmlPageFramePolicy(createHash("sha256").update(HTML_PAGE_BOOTSTRAP, "utf8").digest("base64"));
	let server: http.Server | null = null;
	let binding: Promise<number | null> | null = null;
	let port: number | null = null;

	const handle = (request: http.IncomingMessage, response: http.ServerResponse): void => {
		const ok = request.method === "GET" && request.url === HTML_PAGE_FRAME_PATH && request.headers.host === `127.0.0.1:${port ?? 0}`;
		if (!ok) {
			response.writeHead(404, frameHeaders(policy, "text/plain; charset=utf-8", 0));
			response.end();
			return;
		}
		response.writeHead(200, frameHeaders(policy, "text/html; charset=utf-8", body.length));
		response.end(body);
	};

	return {
		get port() {
			return port;
		},
		ensure() {
			if (binding !== null) return binding;
			const created = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, handle);
			created.requestTimeout = 5000;
			created.headersTimeout = 5000;
			server = created;
			const bound = Promise.withResolvers<number | null>();
			binding = bound.promise;
			created.once("error", () => {
				server = null;
				binding = null;
				bound.resolve(null);
			});
			created.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
				const address = created.address();
				port = address === null || typeof address === "string" ? null : address.port;
				bound.resolve(port);
			});
			return binding;
		},
		async close() {
			const closing = server;
			server = null;
			binding = null;
			port = null;
			if (closing === null) return;
			const closed = Promise.withResolvers<void>();
			closing.close(() => closed.resolve());
			closing.closeAllConnections();
			await closed.promise;
		},
	};
}
