import assert from "node:assert/strict";
import * as http from "node:http";
import { after, describe, it } from "node:test";
import { HTML_PAGE_BOOTSTRAP, HTML_PAGE_FRAME_PATH, htmlPageFrameDocument } from "../shared/html-page-frame.ts";
import { createHtmlPageServer } from "./html-page-server.ts";

interface Answer {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

function request(port: number, options: { method?: string; path?: string; host?: string; body?: string } = {}): Promise<Answer> {
	const { promise, resolve, reject } = Promise.withResolvers<Answer>();
	const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? HTML_PAGE_FRAME_PATH, headers: { host: options.host ?? `127.0.0.1:${port}`, connection: "close" } }, response => {
		const chunks: Buffer[] = [];
		response.on("data", (chunk: Buffer) => chunks.push(chunk));
		response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
	});
	req.on("error", reject);
	req.end(options.body);
	return promise;
}

describe("the HTML page frame server", () => {
	const server = createHtmlPageServer();
	after(async () => { await server.close(); });

	it("binds only when asked, to a loopback port, once", async () => {
		assert.equal(server.port, null);
		const [first, second] = await Promise.all([server.ensure(), server.ensure()]);
		assert.equal(typeof first, "number");
		assert.equal(first, second, "concurrent callers share one bind");
		assert.equal(server.port, first);
		assert.equal(await server.ensure(), first);
	});

	it("serves the constant document with the frame's own policy as a header", async () => {
		const port = server.port!;
		const one = await request(port);
		const two = await request(port);
		assert.equal(one.status, 200);
		assert.equal(one.body, htmlPageFrameDocument());
		assert.equal(two.body, one.body);
		const header = (name: string): string => String(one.headers[name] ?? "");
		assert.match(header("content-type"), /^text\/html/);
		const policy = header("content-security-policy");
		assert.match(policy, /default-src 'none'/);
		assert.match(policy, /connect-src 'none'/);
		assert.match(policy, /sandbox allow-scripts/);
		assert.match(policy, /'sha256-[A-Za-z0-9+/]+=*'/);
		assert.equal(one.headers["x-content-type-options"], "nosniff");
		assert.ok(one.body.includes(HTML_PAGE_BOOTSTRAP));
	});

	it("answers everything else with an empty 404", async () => {
		const port = server.port!;
		const refused: Answer[] = [];
		for (const options of [
			{ path: "/" },
			{ path: "/page/" },
			{ path: "/page?x=1" },
			{ path: "/Page" },
			{ path: "/%70age" },
			{ path: "/../page" },
			{ method: "POST", body: "{\"secret\":1}" },
			{ method: "HEAD" },
			{ method: "PUT", body: "x" },
			{ method: "OPTIONS" },
			{ host: "localhost" },
			{ host: `evil.example:${port}` },
			{ host: `127.0.0.1:${port + 1}` },
		]) refused.push(await request(port, options));
		for (const answer of refused) {
			assert.equal(answer.status, 404);
			assert.equal(answer.body, "");
		}
	});

	it("closes with the extension and can bind again", async () => {
		const port = server.port!;
		await server.close();
		assert.equal(server.port, null);
		await assert.rejects(request(port));
		const again = await server.ensure();
		assert.equal(typeof again, "number");
		assert.equal((await request(again!)).status, 200);
	});
});
