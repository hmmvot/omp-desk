import type { ReactNode } from "react";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentActivity, RunningAgent } from "../../chat/agents";
import type { ChatContent, CustomMessage, ToolResultMessage } from "../../chat/messages";
import { isInterruptedToolResult, parseChatContent } from "../../chat/messages";
import { toolPresentation } from "../../chat/tool-presentation";
import { messageText } from "../lib/format";
import { ToolTargetText } from "./FileLinks";
import { MessageContentView } from "./MessageContent";
import { lateDiagnosticsFiles, recordRows, stringField } from "./native-message-helpers";
import { Diagnostics, displayText, record, scalar, Section, TextPreview } from "./tool-renderer-primitives";
import { describeTool, hasNoDetails, hasWaitRows, TOOL_ICONS, type ToolSemanticView } from "./tool-renderers";

export interface ToolCardProps {
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
	callId?: string;
	status?: "queued" | "running" | "complete" | "error" | "skipped";
	streamUpdate?: unknown;
	attachments?: readonly CustomMessage[];
	agents?: ReadonlyMap<string, RunningAgent>;
	agentActivity?: ReadonlyMap<string, AgentActivity>;
	renderChild?: (id: string) => ReactNode;
	initiallyExpanded?: boolean;
	expanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
	autoExpanded?: boolean;
	cwd?: string;
}

const STATE_ICONS: Record<NonNullable<ToolCardProps["status"]>, string> = {
	queued: "clock", running: "loading codicon-modifier-spin", complete: "check", error: "error", skipped: "circle-slash",
};

/** Stable call identity/disclosure, with family-owned DOM bodies rather than generic JSON output. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const [localExpanded, setLocalExpanded] = useState(props.initiallyExpanded ?? false);
	const expanded = props.expanded ?? localExpanded;
	const root = useRef<HTMLDivElement>(null);
	const [retained, setRetained] = useState(false);
	const retainedView = useRef<ToolSemanticView | undefined>(undefined);
	const retainedBody = useRef<ReactNode>(null);
	const bodyId = useId();
	useEffect(() => {
		const holdsDetail = (): boolean => {
			const element = root.current;
			const selection = document.getSelection();
			return Boolean(element && (element.contains(document.activeElement) && document.activeElement?.closest(".omp-tool-body") || selection && !selection.isCollapsed && element.contains(selection.anchorNode)));
		};
		const update = (): void => {
			const held = holdsDetail();
			setRetained(held);
		};
		document.addEventListener("selectionchange", update);
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", update);
		return () => { document.removeEventListener("selectionchange", update); document.removeEventListener("focusin", update); document.removeEventListener("focusout", update); };
	}, []);
	const { name, args, result, partialResult, streamUpdate, intent, attachments } = props;
	const source = result ?? partialResult;
	const data = record(source);
	const details = record(data.details);
	// Where an edit's first change is, for the link on its path: one file's result carries it directly or in its per-file row.
	const changedRow = Array.isArray(details.perFileResults) ? record(details.perFileResults[0]) : {};
	const changedLine = [details.firstChangedLine, changedRow.firstChangedLine].find((value): value is number => typeof value === "number" && value >= 1);
	const stream = record(streamUpdate);
	const state = result && isInterruptedToolResult(result) ? "skipped" : props.status ?? (props.running === true ? "running" : result?.isError === true ? "error" : result === undefined ? "queued" : "complete");
	const partial = result === undefined && (partialResult !== undefined || state === "running");
	const content = useMemo(() => {
		if (result) return result.content;
		const value = Array.isArray(partialResult) ? partialResult : record(partialResult).content;
		if (!Array.isArray(value)) return [];
		return value.map(parseChatContent).filter((block): block is ChatContent => block !== null);
	}, [result, partialResult]);
	const text = messageText(source);
	const metadata = useMemo(() => toolPresentation({ call: { type: "toolCall", id: props.callId ?? "", name, arguments: record(args) }, entryId: "", result, active: partialResult !== undefined || streamUpdate !== undefined ? { toolCallId: props.callId ?? "", toolName: name, args, partialResult, streamUpdate, startedAt: 0 } : undefined, status: state, mutable: partial, attachments: attachments ?? [] }, props.cwd), [name, args, result, partialResult, streamUpdate, state, partial, attachments, props.callId, props.cwd]);
	const compactTarget = useMemo(() => {
		const route = metadata.route;
		if (route.name !== "task") return "";
		const rows = new Map<string, string>();
		for (const row of recordRows(route.args, "tasks")) rows.set(stringField(row, "name") ?? stringField(row, "id") ?? "Agent", `${stringField(row, "name") ?? "Agent"}${stringField(row, "agent") ? ` · ${stringField(row, "agent")}` : ""}`);
		for (const agent of props.agents?.values() ?? []) if (props.callId && agent.parentToolCallId === props.callId) rows.set(agent.id, `${agent.id} · ${agent.agent} · ${agent.status}`);
		for (const field of ["progress", "results"]) for (const row of recordRows(route.details, field)) {
			const id = stringField(row, "id") ?? "Agent";
			const status = row.aborted === true ? "cancelled" : row.error || typeof row.exitCode === "number" && row.exitCode !== 0 ? "failed" : row.exitCode === 0 ? "completed" : stringField(row, "status");
			rows.set(id, `${id}${stringField(row, "agent") ? ` · ${stringField(row, "agent")}` : ""}${status ? ` · ${status}` : ""}`);
		}
		return [...rows.values()].join(", ");
	}, [metadata.route, props.agents, props.callId]);
	const showBody = expanded || props.autoExpanded === true || retained || metadata.liveDetail;
	// Wait owns its clock; Ask names the user wait even while its details are closed.
	const waitFace = name === "wait";
	const pendingAsk = metadata.route.name === "ask" && result === undefined && (state === "running" || state === "queued");
	const view = showBody || waitFace || metadata.route.name === "ask" ? retained && retainedView.current ? retainedView.current : describeTool({
		name, args: record(args), details, stream, text, expanded: showBody, partial,
		hasResult: metadata.route.name === "ask" ? result !== undefined : source !== undefined, isError: state === "error",
		callId: props.callId, agents: props.agents, agentActivity: props.agentActivity, renderChild: props.renderChild, cwd: props.cwd,
	}) : undefined;
	const failed = state !== "skipped" && (metadata.failed || !retained && view?.tone === "error");
	const diagnosticCount = metadata.warnings;
	const nontext = content.filter(block => block.type !== "text");
	const errorText = failed ? scalar(details.error) : "";
	const body = retained ? retainedBody.current : <>
		{errorText && !text.includes(errorText) && <Section title="Error"><TextPreview text={errorText} expanded={expanded} lines={4} /></Section>}
		{state === "skipped" ? <div className="omp-empty-note">Skipped — this call did not complete.</div> : view?.body}
		{nontext.length > 0 && <MessageContentView content={nontext} />}
		{attachments?.map((attachment, index) => <Section key={`${attachment.timestamp}:${index}`} title={`Late diagnostics${attachment.attribution ? ` · ${attachment.attribution}` : ""}`}>
			{lateDiagnosticsFiles(attachment.details).map((file, fileIndex) => <Section key={fileIndex} title={file.path ?? "File diagnostics"}><Diagnostics value={file} expanded={expanded} /></Section>)}
		</Section>)}
	</>;
	useLayoutEffect(() => {
		if (!retained && showBody) { retainedBody.current = body; retainedView.current = view; }
	}, [retained, showBody, body, view]);
	if (name === "wait" && result && isInterruptedToolResult(result)) return null;
	// Nothing to disclose: a settled, error-free call whose expanded details would be empty is one static row.
	const bare = state === "complete" && result !== undefined && !retained && !failed && diagnosticCount === 0 && nontext.length === 0 && (attachments?.length ?? 0) === 0 && hasNoDetails({ name, args: record(args), details, stream, text });
	const aux = intent?.replace(/\s+/g, " ").trim() || undefined;
	if (bare) {
		const target = compactTarget || metadata.target;
		return <div ref={root} className="omp-tool omp-native-tool omp-native-tool--bare" data-tool-name={name} data-tool-family={metadata.route.name} data-tool-call-id={props.callId ?? result.toolCallId} data-tool-status={state}>
			<div className="omp-tool-head omp-tool-head--static" title={[metadata.title, target, aux, "no output"].filter(Boolean).join(" · ")}>
				<span className={`codicon codicon-${STATE_ICONS[state]}`} aria-hidden="true" />
				<span className={`codicon codicon-${TOOL_ICONS[metadata.route.name] ?? "tools"}`} aria-hidden="true" />
				<span className="omp-tool-name">{metadata.title}</span>
				{target && <span className="omp-tool-digest" title={target}><ToolTargetText category={metadata.category} paths={metadata.paths} text={displayText(target)} line={changedLine} revalidate={state} /></span>}
				{aux && <span className="omp-tool-aux omp-tool-aux--intent" title={aux}>{aux}</span>}
				<span className="omp-tool-aux omp-tool-aux--none">no output</span>
				<span className="omp-sr-only" role="status">{state}</span>
			</div>
		</div>;
	}
	const headTarget = compactTarget || view?.target || metadata.target;
	const face = <>
		{!pendingAsk && <span className={`codicon codicon-${failed ? "error omp-tool-status--failed" : STATE_ICONS[state]}`} aria-hidden="true" />}
		<span className={`codicon codicon-${view?.icon ?? TOOL_ICONS[metadata.route.name] ?? "tools"}`} aria-hidden="true" />
		<span className="omp-tool-name">{waitFace && view?.title?.startsWith("Waiting on") ? <><span className="omp-wait-title-full">{view.title}</span><span className="omp-wait-title-short">Wait</span></> : view?.title ?? metadata.title}</span>
		{headTarget && <span className="omp-tool-digest" title={headTarget}><ToolTargetText category={metadata.category} paths={metadata.paths} text={displayText(headTarget)} line={changedLine} revalidate={state} /></span>}
		{view?.inline}
		{aux && <span className="omp-tool-aux omp-tool-aux--intent" title={aux}>{aux}</span>}
		{view?.meta?.map((meta, index) => <span className="omp-native-tool-meta" key={index}>{displayText(meta)}</span>)}
		{diagnosticCount > 0 && <span className="omp-chip omp-chip--warn"><span className="codicon codicon-warning" aria-hidden="true" />{diagnosticCount} diagnostics</span>}
		{/* Failure is conveyed by one status icon; skipped calls retain their readable badge. */}
		{!pendingAsk && state === "skipped" && <span className="omp-chip">{state}</span>}
		<span className="omp-sr-only" role="status">{pendingAsk ? "Waiting for your answer" : failed ? "error" : state}</span>
		{metadata.category === "edit" && (state === "running" || state === "queued") && !showBody && <span className="omp-empty-note">preparing edit…</span>}
		{view?.trailing}
	</>;
	// The expanded body would only repeat the header and its tooltip: no chevron, no toggle, nothing focusable.
	const plainRow = view?.expandable === false && !failed && diagnosticCount === 0 && nontext.length === 0 && (attachments?.length ?? 0) === 0 && !retained;
	const title = [intent, view?.tooltip].filter(Boolean).join("\n");
	if (plainRow) {
		return <div ref={root} className="omp-tool omp-native-tool omp-native-tool--static" data-tool-name={name} data-tool-family={view?.family ?? metadata.route.name} data-tool-call-id={props.callId ?? result?.toolCallId} data-tool-status={state}>
			<div className={`omp-tool-head omp-tool-head--static${aux ? " omp-tool-head--intent" : ""}${view?.inline ? " omp-tool-head--inline" : ""}`} title={title || undefined}>{face}</div>
		</div>;
	}
	return <div ref={root} className={`omp-tool omp-native-tool${failed ? " omp-tool--error" : ""}${state === "skipped" ? " omp-native-tool--skipped" : ""}`} data-tool-name={name} data-tool-family={view?.family ?? metadata.route.name} data-tool-call-id={props.callId ?? result?.toolCallId} data-tool-status={state} onKeyDown={event => {
		if (event.key !== "Escape" || !showBody || !root.current?.contains(document.activeElement)) return;
		event.preventDefault(); event.stopPropagation(); root.current.querySelector<HTMLButtonElement>(".omp-tool-head")?.focus();
		setLocalExpanded(false); props.onExpandedChange?.(false);
	}}>
		<button type="button" className={`omp-tool-head${aux ? " omp-tool-head--intent" : ""}${view?.inline ? " omp-tool-head--inline" : ""}`} aria-expanded={showBody} aria-controls={bodyId} onClick={() => { const next = !expanded; setLocalExpanded(next); props.onExpandedChange?.(next); }} title={title || (showBody ? "Hide tool details" : "Show complete tool details")}>
			<span className={`codicon codicon-${showBody ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
			{face}
		</button>
		{showBody && <div id={bodyId} className="omp-tool-body" role="region" aria-label={`${metadata.title} details`} tabIndex={0}>{body}</div>}
	</div>;
});

