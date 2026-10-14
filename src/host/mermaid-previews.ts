/**
 * Diagram tabs (`ompDesk.mermaidPreview`): a mermaid source the chat page would not draw inline, drawn in an editor tab of its own.
 *
 * The chat page asks with `omp:open-mermaid`; the registry opens one tab per source (its SHA-256) and reveals it when the same
 * source is asked for again. The tab's document announces itself with `omp:mermaid-preview-ready` and is answered with the
 * source over the message channel, again after every later ready (a reloaded document). Nothing else the document says is
 * acted on. A tab is not a session editor: no binding, claim or restore, and the request carries no conversation.
 *
 * The registry has no vscode import so its rules are testable with fake panels (ADR-0069 amendment of 2026-10-14).
 */
import { createHash } from "node:crypto";
import { isOpenableMermaidSource, parseMermaidPreviewMessage, type MermaidPreviewSourceMessage } from "../protocol/mermaid-preview.ts";
import type { Logger } from "../shared/logger.ts";
import { mermaidKind } from "../shared/mermaid-source.ts";

/** The slice of a VS Code WebviewPanel this registry uses. */
export interface MermaidPreviewPanel {
	readonly webview: {
		postMessage(message: MermaidPreviewSourceMessage): PromiseLike<boolean> | boolean;
		onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
	};
	reveal(): void;
	dispose(): void;
	onDidDispose(listener: () => void): { dispose(): void };
}

/** The tab's view type. It avoids the `omp.session` prefix the editor-title and keybinding when-clauses match: a diagram tab is not a session editor. */
export const MERMAID_PREVIEW_VIEW_TYPE = "ompDesk.mermaidPreview";

export interface MermaidPreviewsHost {
	/** Create the editor tab with its document installed. */
	createPanel(title: string): MermaidPreviewPanel;
	readonly log: Logger;
}

/** The key a source is a tab under. */
export function mermaidPreviewKey(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

export class MermaidPreviews {
	readonly #host: MermaidPreviewsHost;
	readonly #panels = new Map<string, MermaidPreviewPanel>();

	constructor(host: MermaidPreviewsHost) {
		this.#host = host;
	}

	/** Open the tab for `source`, or reveal the one that already shows it; a source the protocol would not carry is refused. */
	open(source: string): "created" | "revealed" | "refused" {
		if (!isOpenableMermaidSource(source)) return "refused";
		const key = mermaidPreviewKey(source);
		const existing = this.#panels.get(key);
		if (existing !== undefined) {
			existing.reveal();
			return "revealed";
		}
		const panel = this.#host.createPanel(`Diagram · ${mermaidKind(source)}`);
		this.#panels.set(key, panel);
		panel.webview.onDidReceiveMessage(raw => {
			if (parseMermaidPreviewMessage(raw) === null) {
				this.#host.log.debug("diagram tab: ignored an unrecognized message");
				return;
			}
			void Promise.resolve(panel.webview.postMessage({ type: "omp:mermaid-preview-source", source })).catch(() => this.#host.log.warn("diagram tab: the source could not be delivered"));
		});
		panel.onDidDispose(() => {
			if (this.#panels.get(key) === panel) this.#panels.delete(key);
		});
		return "created";
	}

	dispose(): void {
		for (const panel of [...this.#panels.values()]) panel.dispose();
	}

	/** Open tabs, for tests and diagnostics. */
	get size(): number {
		return this.#panels.size;
	}
}
