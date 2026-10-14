import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MERMAID_PREVIEW_VIEW_TYPE, MermaidPreviews, mermaidPreviewKey, type MermaidPreviewPanel } from "./mermaid-previews.ts";

class FakePanel implements MermaidPreviewPanel {
	revealed = 0;
	disposed = false;
	posted: unknown[] = [];
	#receive: ((message: unknown) => void) | null = null;
	#dispose: (() => void) | null = null;
	readonly title: string;
	constructor(title: string) { this.title = title; }
	readonly webview = {
		postMessage: async (message: unknown): Promise<boolean> => { this.posted.push(message); return true; },
		onDidReceiveMessage: (listener: (message: unknown) => void) => { this.#receive = listener; return { dispose() {} }; },
	};
	reveal(): void { this.revealed += 1; }
	dispose(): void { if (this.disposed) return; this.disposed = true; this.#dispose?.(); }
	onDidDispose(listener: () => void): { dispose(): void } { this.#dispose = listener; return { dispose() {} }; }
	async send(message: unknown): Promise<void> {
		this.#receive?.(message);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

function fixture() {
	const panels: FakePanel[] = [];
	const logs: string[] = [];
	const previews = new MermaidPreviews({
		createPanel(title) { const panel = new FakePanel(title); panels.push(panel); return panel; },
		log: message => { logs.push(message); },
	});
	return { previews, panels, logs };
}

const FLOW = "flowchart TD\n  A --> B";

describe("diagram tab registry", () => {
	it("names its view type outside the session prefix", () => {
		assert.equal(MERMAID_PREVIEW_VIEW_TYPE, "ompDesk.mermaidPreview");
		assert.ok(!MERMAID_PREVIEW_VIEW_TYPE.startsWith("omp."));
	});

	it("opens one tab per source and reveals it when the same source is asked for again", () => {
		const { previews, panels } = fixture();
		assert.equal(previews.open(FLOW), "created");
		assert.equal(previews.open(FLOW), "revealed");
		assert.equal(panels.length, 1);
		assert.equal(panels[0]!.revealed, 1);
		assert.equal(previews.open(`${FLOW}\n  B --> C`), "created");
		assert.equal(panels.length, 2);
		assert.equal(previews.size, 2);
	});

	it("keys a tab by the SHA-256 of the source, so a source that differs by one character is another tab", () => {
		assert.match(mermaidPreviewKey(FLOW), /^[0-9a-f]{64}$/);
		assert.notEqual(mermaidPreviewKey(FLOW), mermaidPreviewKey(`${FLOW} `));
		const { previews, panels } = fixture();
		previews.open(FLOW);
		previews.open(`${FLOW} `);
		assert.equal(panels.length, 2);
	});

	it("creates the tab again once it was closed, and does not touch another tab's entry", () => {
		const { previews, panels } = fixture();
		previews.open(FLOW);
		previews.open("sequenceDiagram\n  A->>B: hi");
		panels[0]!.dispose();
		assert.equal(previews.size, 1);
		assert.equal(previews.open(FLOW), "created");
		assert.equal(panels.length, 3);
		assert.equal(previews.open("sequenceDiagram\n  A->>B: hi"), "revealed");
	});

	it("titles the tab with the diagram's kind", () => {
		const { previews, panels } = fixture();
		previews.open(FLOW);
		previews.open("---\ntitle: T\n---\nsequenceDiagram\n  A->>B: hi");
		previews.open("block-beta\n  columns 2\n  a b");
		assert.deepEqual(panels.map(panel => panel.title), ["Diagram · flowchart", "Diagram · sequence", "Diagram · block"]);
	});

	it("refuses a source the protocol would not carry", () => {
		const { previews, panels } = fixture();
		assert.equal(previews.open(""), "refused");
		assert.equal(previews.open("x".repeat(50_001)), "refused");
		assert.equal(previews.open("x".repeat(50_000)), "created");
		assert.equal(panels.length, 1);
	});

	it("sends the source when the tab's document announces itself, every time, and ignores anything else it says", async () => {
		const { previews, panels, logs } = fixture();
		previews.open(FLOW);
		const panel = panels[0]!;
		assert.deepEqual(panel.posted, [], "the source is not pushed before the document listens");
		await panel.send({ type: "omp:mermaid-preview-ready" });
		await panel.send({ type: "omp:mermaid-preview-ready" });
		assert.deepEqual(panel.posted, [
			{ type: "omp:mermaid-preview-source", source: FLOW },
			{ type: "omp:mermaid-preview-source", source: FLOW },
		]);
		for (const message of [{ type: "omp:open-mermaid", source: "other" }, { type: "omp:mermaid-preview-ready", source: "other" }, { type: "omp:ready" }, null, "ready"]) await panel.send(message);
		assert.equal(panel.posted.length, 2);
		assert.equal(logs.length, 5);
	});

	it("disposes every tab with the registry", () => {
		const { previews, panels } = fixture();
		previews.open(FLOW);
		previews.open(`${FLOW}\n  B --> C`);
		previews.dispose();
		assert.ok(panels.every(panel => panel.disposed));
		assert.equal(previews.size, 0);
	});
});
