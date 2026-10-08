/** Pushed host state is the only display source; native picks never select optimistically. */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { guestTransport } from "../bridge";
import type { ChatClient, ChatSnapshot } from "../lib/chat-client";
import type { ControlModelRef, GuestControlAction, GuestControlStateMessage } from "../messages";
import type { FooterMetadataMessage } from "../footer-metadata";
import { newControlScope } from "../messages";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { quotaUsedPercent } from "../lib/context-indicator";

const CONTROL_WAIT_TIMEOUT_MS = 35_000;
const FEEDBACK_MS = 6_000;
type ControlRequest =
	| { action: "snapshot"; picker?: "model" | "thinking" }
	| { action: "set-model"; model: ControlModelRef }
	| { action: "set-thinking"; level: string };
interface ControlBook { client: ChatClient; scope: string; nextId: number; lastSent: number; action: GuestControlAction; picker?: "model" | "thinking" }
interface ControlView { client: ChatClient; state: GuestControlStateMessage | null; awaiting: number | null; action: GuestControlAction; feedback: string | null }

export function ChatFooter({ client, snapshot, trailingActions }: {
	client: ChatClient;
	snapshot: ChatSnapshot;
	trailingActions?: ReactNode;
}): ReactNode {
	const preferences = useSyncExternalStore(client.subscribe, client.getDisplayPreferences);
	const [view, setView] = useState<ControlView>({ client, state: null, awaiting: null, action: "snapshot", feedback: null });
	const bookRef = useRef<ControlBook | null>(null);
	const [snapshotOwed, setSnapshotOwed] = useState(false);
	const [metadata, setMetadata] = useState<FooterMetadataMessage | null>(null);
	if (bookRef.current === null || bookRef.current.client !== client) {
		bookRef.current = { client, scope: newControlScope(), nextId: 1, lastSent: 0, action: "snapshot" };
	}
	if (view.client !== client) {
		setView({ client, state: null, awaiting: null, action: "snapshot", feedback: null });
		setSnapshotOwed(false);
		setMetadata(null);
	}
	const send = useCallback((request: ControlRequest): void => {
		const book = bookRef.current;
		if (book === null || book.client !== client) return;
		const requestId = book.nextId++;
		book.lastSent = requestId;
		book.action = request.action;
		book.picker = request.action === "snapshot" ? request.picker : undefined;
		setView(previous => ({ ...previous, awaiting: requestId, action: request.action, feedback: null }));
		guestTransport.post({ type: "omp:control-request", scope: book.scope, requestId, ...request,
			...(request.action === "snapshot" ? {} : { actionSeq: guestTransport.nextActionSeq() }) });
	}, [client]);
	useEffect(() => guestTransport.subscribe(message => {
		if (message.type === "omp:footer-metadata") { setMetadata(message); return; }
		if (message.type === "omp:control-invalidate") {
			setView(previous => ({ ...previous, state: null }));
			setSnapshotOwed(true);
			return;
		}
		if (message.type !== "omp:control-state") return;
		const book = bookRef.current;
		if (book === null || message.scope !== book.scope || message.requestId !== book.lastSent) return;
		const picker = book.picker;
		book.picker = undefined;
		setView(previous => previous.client !== book.client ? previous : {
			client: previous.client, state: message, awaiting: null, action: book.action,
			feedback: message.notice ?? (!message.available && book.action !== "snapshot" ? message.reason ?? "The change could not be confirmed." : null),
		});
		// The reducer updates synchronously; a state push and picker reply can precede React's next render.
		const current = client.getSnapshot();
		if (!message.available || current.phase !== "live" || current.readOnlyReason !== null) return;
		if (picker === "model" && message.selectedModel &&
			(message.selectedModel.provider !== current.state?.model?.provider || message.selectedModel.id !== current.state?.model?.id)) {
			send({ action: "set-model", model: message.selectedModel });
		} else if (picker === "thinking" && message.selectedThinking && message.selectedThinking !== current.state?.thinkingLevel &&
			message.model?.provider === current.state?.model?.provider && message.model?.id === current.state?.model?.id) {
			send({ action: "set-thinking", level: message.selectedThinking });
		}
	}), [send]);
	const live = snapshot.phase === "live";
	useEffect(() => { setSnapshotOwed(true); }, [client, live]);
	useEffect(() => {
		if (!snapshotOwed || view.awaiting !== null) return;
		send({ action: "snapshot" });
		setSnapshotOwed(false);
	}, [snapshotOwed, view.awaiting, send]);
	useEffect(() => guestTransport.onRouteChange(() => {
		const book = bookRef.current;
		if (!book || book.picker === undefined) return;
		book.picker = undefined;
		book.lastSent = -1; // A late selection from the abandoned route cannot mutate the new route.
		setView(previous => ({ ...previous, awaiting: null, state: null, feedback: "The host connection changed; the picker was cancelled." }));
		setSnapshotOwed(true);
	}), []);
	useEffect(() => {
		if (view.awaiting === null || bookRef.current?.picker !== undefined) return;
		const awaited = view.awaiting;
		const timer = setTimeout(() => setView(previous => previous.client === client && previous.awaiting === awaited ? {
			...previous, feedback: "The host has not reported this request's outcome. It was not sent again.",
		} : previous), CONTROL_WAIT_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [client, view.awaiting]);
	useEffect(() => {
		if (view.feedback === null) return;
		const timer = setTimeout(() => setView(previous => ({ ...previous, feedback: null })), FEEDBACK_MS);
		return () => clearTimeout(timer);
	}, [view.feedback]);
	const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
	useEffect(() => {
		const message = snapshot.commandFeedback?.message;
		if (message !== undefined) setCommandFeedback(message);
	}, [snapshot.commandFeedback]);
	const toolsOutput = preferences.toolCallDetail === "overview" ? "Overview" : "Detailed";
	const model = snapshot.state?.model ?? null;
	const level = snapshot.state?.thinkingLevel ?? null;
	const readOnly = snapshot.readOnlyReason !== null;
	const blocked = !live ? "This session is not running." : readOnly ? snapshot.readOnlyReason ?? "This session is read-only." :
		view.state === null ? "Waiting for the host's controls." : !view.state.available ? view.state.reason ?? "Host controls are unavailable." :
		view.state.mutationMode === "unavailable" ? "The host cannot apply changes." :
		view.awaiting !== null ? "Waiting for the host's request outcome." : null;
	const usage = snapshot.state?.contextUsage;
	const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? null;
	const { windows, quotaTooltip } = useMemo(() => {
		const windows = metadata?.provider === model?.provider ? metadata?.windows ?? [] : [];
		return {
			windows,
			quotaTooltip: metadata ? [
				metadata.accountSelection,
				...metadata.accounts.map(account => `${account.label}\n${account.windows.map(window =>
					`${window.label}: ${quotaUsedPercent(window)}% used${window.resetsAt === null ? "" : `; resets ${new Date(window.resetsAt).toLocaleString()}`}`).join("\n")}`),
			].filter(Boolean).join("\n\n") : "",
		};
	}, [metadata, model?.provider]);
	// Model, thinking, Tools and branch share one toolbar with context and composer actions.
	// Session notices and queued messages already have their own rows above the composer.
	return (
		<>
			<div className="omp-composer-toolbar">
				<div className="omp-composer-lead">
					<button type="button" className="omp-footer-trigger" disabled={blocked !== null}
						title={blocked ?? `Provider: ${model?.provider ?? "unknown"}`} onClick={() => send({ action: "snapshot", picker: "model" })}>
						<span className="omp-footer-trigger-label">{model?.name ?? model?.id ?? "Model unavailable"}</span>
						<span aria-hidden="true" className={`codicon codicon-${view.awaiting !== null && (bookRef.current?.picker === "model" || view.action === "set-model") ? "loading codicon-modifier-spin" : "chevron-down"}`} />
					</button>
					<button type="button" className="omp-footer-trigger omp-footer-trigger--level" disabled={blocked !== null}
						title={blocked ?? "Change the session's thinking level"} aria-label="Thinking level" onClick={() => send({ action: "snapshot", picker: "thinking" })}>
						<span className="omp-footer-trigger-label">{level ?? "Unavailable"}</span>
						<span aria-hidden="true" className={`codicon codicon-${view.awaiting !== null && (bookRef.current?.picker === "thinking" || view.action === "set-thinking") ? "loading codicon-modifier-spin" : "chevron-down"}`} />
					</button>
					<button type="button" className="omp-btn omp-tools-trigger"
						aria-label={`Tools output: ${toolsOutput}`} title={`Tools output: ${toolsOutput}`} onClick={() => client.chooseToolCallDetail()}>
						<span aria-hidden="true" className="codicon codicon-tools" />
					</button>
					{metadata?.branch && <span className="omp-composer-branch" title={`Git branch of the session working directory: ${metadata.branch}`}><span aria-hidden="true" className="codicon codicon-git-branch" /><span className="omp-composer-branch-name">{metadata.branch}</span></span>}
				</div>
				<div className="omp-composer-toolbar-actions">
					<ContextUsageIndicator tokens={usage?.tokens} contextWindow={contextWindow} percent={usage?.percent}
						cost={metadata?.sessionCost} windows={windows} quotaTooltip={quotaTooltip} />
					{trailingActions}
				</div>
			</div>
			{(view.feedback ?? commandFeedback) !== null && <div className="omp-footer-feedback" role="status">
				<span>{view.feedback ?? commandFeedback}</span>
				<button type="button" className="omp-btn" aria-label="Dismiss message" title="Dismiss message" onClick={() => {
					if (view.feedback !== null) setView(previous => ({ ...previous, feedback: null }));
					else setCommandFeedback(null);
				}}><span aria-hidden="true" className="codicon codicon-close" /></button>
			</div>}
		</>
	);
}
