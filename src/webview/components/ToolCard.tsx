import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentActivity, RunningAgent } from "../../chat/agents";
import type { ChatContent, CustomMessage, ToolResultMessage } from "../../chat/messages";
import { isInterruptedToolResult, parseChatContent } from "../../chat/messages";
import type { DiffStats } from "../../chat/diff-stats";
import { DEBUG_TOOL_TITLES, toolPresentation } from "../../chat/tool-presentation";
import { messageText } from "../../shared/format";
import { ToolTargetText } from "./FileLinks";
import { MessageContentView } from "./MessageContent";
import { lateDiagnosticsFiles, recordRows, stringField } from "./native-message-helpers";
import { Diagnostics, displayText, JsonOutput, OUTPUT_SCOPE, record, scalar, Section, TextPreview } from "./tool-renderer-primitives";
import { describeTool, hasNoDetails, hasWaitRows, rendererFace, TOOL_ICONS } from "./tool-renderers";
import type { ToolSemanticView } from "./tool-render-types";
import { formatGistDuration, toolGist, type GistPart } from "../../chat/tool-gist";
import { stripSkillHeader } from "../../chat/skill-read";
import { exitCodeOf, footerParts, splitToolNotices } from "../../chat/tool-notices";
import { useSecondTick } from "../lib/live-clock";
import { detectOutput } from "../lib/output-format";
import { FRESH_VIEW, useObservedToolMs, useToolViewState } from "../lib/tool-view-state";
import { useArtifactOpener } from "../lib/artifact-opener";
import { focusAfter } from "../lib/focus-after";
import { rawDetailsCopy, rawDetailsView } from "../lib/raw-details";
import { FoldAllButtons } from "./JsonRows";
import { JobCancel, JobChip, cardJobCancelable, cardJobShown, useCardJob } from "./JobCard";
import { ToolMenu, type ToolMenuItem } from "./ToolMenu";
import { copyToClipboard, ToolCopyButton, ToolFooter, ToolViewContext } from "./tool-view";

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
	/** Where the card keeps what it remembers beyond being open (it shows everything): one key per call. */
	viewKey?: string;
	/** When the call began (a running call's live clock) and, once settled, when its result arrived (the head gist's derived duration). */
	startedAt?: number;
	endedAt?: number;
}

const STATE_ICONS: Record<NonNullable<ToolCardProps["status"]>, string> = {
	queued: "clock", running: "loading codicon-modifier-spin", complete: "check", error: "error", skipped: "circle-slash",
};
/** The fence language a command tool's text is coloured as. */
const COMMAND_LANGUAGES: Readonly<Record<string, string>> = { bash: "shell", python: "python", powershell: "powershell", pwsh: "powershell" };

/** An edit's added and removed lines: two coloured spans with text signs, so colour is never the only carrier. */
function DiffStatSpans({ stats }: { stats: DiffStats }): ReactNode {
	return <span className="omp-native-tool-meta omp-diff-stat"><span className="omp-diff-stat--add">+{stats.added}</span> <span className="omp-diff-stat--del">−{stats.removed}</span></span>;
}

/** Stable call identity/disclosure, with family-owned DOM bodies rather than generic JSON output. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const [localExpanded, setLocalExpanded] = useState(props.initiallyExpanded ?? false);
	const expanded = props.expanded ?? localExpanded;
	const root = useRef<HTMLDivElement>(null);
	const [retained, setRetained] = useState(false);
	const retainedView = useRef<ToolSemanticView | undefined>(undefined);
	const retainedBody = useRef<ReactNode>(null);
	const bodyId = useId();
	const [viewState, setViewState] = useToolViewState(props.viewKey);
	const full = viewState.full;
	const retainedState = useRef(viewState);
	// A body held for a selection or focus is kept as it was, unless the reader has since changed what it shows (Show all, a format, a fold): that is applied at once.
	const frozen = retained && retainedState.current === viewState;
	useEffect(() => {
		const holdsDetail = (active: Element | null): boolean => {
			const element = root.current;
			const selection = document.getSelection();
			return Boolean(element && (active && element.contains(active) && active.closest(".omp-tool-body") || selection && !selection.isCollapsed && element.contains(selection.anchorNode)));
		};
		const update = (event: Event): void => {
			const held = holdsDetail(focusAfter(event));
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
	// A card that started a background job says how the job is doing, and offers Cancel while it runs.
	const jobCard = useCardJob(details, props.callId ?? result?.toolCallId);
	const jobChip = jobCard !== null && cardJobShown(jobCard) ? jobCard : null;
	const jobCancel = jobCard !== null && cardJobCancelable(jobCard) ? jobCard : null;
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
	const rawText = messageText(source);
	const split = useMemo(() => splitToolNotices(displayText(rawText)), [rawText]);
	const text = split.body;
	const metadata = useMemo(() => toolPresentation({ call: { type: "toolCall", id: props.callId ?? "", name, arguments: record(args) }, entryId: "", result, active: partialResult !== undefined || streamUpdate !== undefined ? { toolCallId: props.callId ?? "", toolName: name, args, partialResult, streamUpdate, startedAt: 0 } : undefined, status: state, mutable: partial, attachments: attachments ?? [] }, props.cwd), [name, args, result, partialResult, streamUpdate, state, partial, attachments, props.callId, props.cwd]);
	/** The Task row's head: `N agents: Name1, Name2` (never the sub-agent prompt), and the per-agent `name · agent · status` list as its tooltip. */
	const compactTarget = useMemo((): { digest: string; detail: string } | null => {
		const route = metadata.route;
		if (route.name !== "task") return null;
		const rows = new Map<string, { name: string; line: string }>();
		for (const row of recordRows(route.args, "tasks")) {
			const name = stringField(row, "name") ?? stringField(row, "id") ?? "Agent";
			rows.set(name, { name, line: `${stringField(row, "name") ?? "Agent"}${stringField(row, "agent") ? ` · ${stringField(row, "agent")}` : ""}` });
		}
		for (const agent of props.agents?.values() ?? []) if (props.callId && agent.parentToolCallId === props.callId) rows.set(agent.id, { name: agent.id, line: `${agent.id} · ${agent.agent} · ${agent.status}` });
		for (const field of ["progress", "results"]) for (const row of recordRows(route.details, field)) {
			const id = stringField(row, "id") ?? "Agent";
			const status = row.aborted === true ? "cancelled" : row.error || typeof row.exitCode === "number" && row.exitCode !== 0 ? "failed" : row.exitCode === 0 ? "completed" : stringField(row, "status");
			rows.set(id, { name: id, line: `${id}${stringField(row, "agent") ? ` · ${stringField(row, "agent")}` : ""}${status ? ` · ${status}` : ""}` });
		}
		if (rows.size === 0) return null;
		return { digest: `${rows.size} agent${rows.size === 1 ? "" : "s"}: ${[...rows.values()].map(row => row.name).join(", ")}`, detail: [...rows.values()].map(row => row.line).join("\n") };
	}, [metadata.route, props.agents, props.callId]);
	const showBody = expanded || props.autoExpanded === true || retained || metadata.liveDetail;
	// Wait owns its clock; Ask names the user wait even while its details are closed.
	const waitFace = name === "wait";
	const pendingAsk = metadata.route.name === "ask" && result === undefined && (state === "running" || state === "queued");
	// The host-run debug tools carry their one-line face (outcome, clock) in their renderer, so it is built while collapsed too; so do yield, MCP and autoresearch calls.
	const debugFace = Object.hasOwn(DEBUG_TOOL_TITLES, name);
	const rendererKind = rendererFace(metadata.route.name);
	const view = showBody || waitFace || debugFace || rendererKind !== undefined || metadata.route.name === "ask" ? frozen && retainedView.current ? retainedView.current : describeTool({
		name, args: record(args), details, stream, text, expanded: full, partial,
		hasResult: metadata.route.name === "ask" ? result !== undefined : source !== undefined, isError: state === "error",
		callId: props.callId, agents: props.agents, agentActivity: props.agentActivity, renderChild: props.renderChild, cwd: props.cwd,
	}) : undefined;
	const failed = state !== "skipped" && (metadata.failed || !frozen && view?.tone === "error");
	const diagnosticCount = metadata.warnings;
	const nontext = content.filter(block => block.type !== "text");
	const errorText = failed ? scalar(details.error) : "";
	const route = metadata.route;
	const exit = route.name === "bash" ? exitCodeOf(route.details, split.notices) : undefined;
	// The Wait, Debug, Ask and renderer faces say their facts in the head even while closed; every other card says them in its output bar.
	const metaInHead = waitFace || debugFace || rendererKind !== undefined || route.name === "ask";
	const chips = metaInHead ? [] : view?.meta ?? [];
	// A format detected in the output (once it settled): its badge, the Formatted | Text switch and the fold buttons live in the bar.
	const structuredText = view?.output?.structured;
	const format = useMemo(() => structuredText === undefined || partial ? null : detectOutput(structuredText), [structuredText, partial]);
	const formatted = format !== null && viewState.format === "formatted";
	const copyText = formatted && structuredText !== undefined && !view?.output?.copy ? format.copy : view?.output?.copy || text;
	const outputLabel = view?.output?.label ?? "Output";
	const showAll = useCallback((rows: number) => setViewState({ full: true, rows }), [setViewState]);
	const artifacts = useArtifactOpener();
	const toolView = useMemo(() => ({ live: partial, showAll, openArtifact: artifacts.open, view: viewState, update: setViewState, structured: format !== null && structuredText !== undefined ? { text: structuredText, format } : undefined }), [partial, showAll, artifacts.open, viewState, setViewState, format, structuredText]);
	const footer = useMemo(() => footerParts(split.notices, details), [split.notices, details]);
	const fullOutputArtifact = (footer.find(part => part.artifact !== undefined && part.text === "full output") ?? footer.find(part => part.artifact !== undefined))?.artifact;
	const live = state === "running" && result === undefined;
	useSecondTick(live && props.startedAt !== undefined);
	const observedMs = useObservedToolMs(props.callId);
	const touched = full || viewState.raw || viewState.format !== "formatted" || viewState.folds.size > 0 || viewState.filter !== "" || viewState.wrap;
	useEffect(() => { if (!showBody && touched) setViewState(FRESH_VIEW); }, [showBody, touched, setViewState]);
	const collapse = (): void => {
		// Focus and selection inside the body hold it open: leave them first, then close.
		root.current?.querySelector<HTMLButtonElement>(".omp-tool-head")?.focus();
		const selection = document.getSelection();
		if (selection && root.current?.contains(selection.anchorNode)) selection.removeAllRanges();
		setRetained(false); setLocalExpanded(false); props.onExpandedChange?.(false); setViewState(FRESH_VIEW);
	};
	const commandText = view?.input?.find(block => block.label === "Command")?.copy ?? stringField(route.args, "command") ?? "";
	const hasDetails = Object.keys(details).length > 0;
	const menuItems: readonly ToolMenuItem[] = [
		{ id: "copy-command", label: "Copy command", icon: "terminal", disabled: commandText === "" ? "This call has no command" : null, run: () => copyToClipboard(commandText, "the command") },
		{ id: "copy-output", label: "Copy output", icon: "copy", disabled: copyText === "" ? "This call has no output" : null, run: () => copyToClipboard(copyText, `the ${outputLabel.toLowerCase()}`) },
		{ id: "copy-details", label: "Copy details JSON", icon: "json", disabled: hasDetails ? null : "This result has no details", run: () => copyToClipboard(rawDetailsCopy(details), "the details") },
		{ id: "raw", label: viewState.raw ? "Hide raw result and details" : "View raw result and details", icon: "code", disabled: source === undefined ? "There is no result yet" : null, run: () => { setViewState({ raw: !viewState.raw }); } },
		{ id: "open-full", label: "Open full output", icon: "go-to-file", disabled: fullOutputArtifact === undefined ? "This output was not truncated, so no full copy was saved" : artifacts.open === undefined ? artifacts.reason : null, run: () => { if (fullOutputArtifact !== undefined) artifacts.open?.(fullOutputArtifact); } },
	];
	const hasBar = view !== undefined && state !== "skipped" && source !== undefined;
	// A bar with nothing but the ⋯ menu (a running call with no output yet) would be an empty row: it sits in the body's corner instead, and the full view's toolbar already carries the menu.
	const menuOnly = hasBar && copyText === "" && format === null && !(exit !== undefined && exit !== 0) && chips.length === 0;
	const outputBar = hasBar && !(menuOnly && full)
		? <div className={menuOnly ? "omp-output-bar omp-output-bar--menu-only" : "omp-output-bar"}>
			{copyText !== "" && <span className="omp-output-label">{outputLabel}</span>}
			{format !== null && <span className="omp-chip omp-format-badge">{format.badge}</span>}
			{exit !== undefined && exit !== 0 && <span className="omp-chip omp-chip--err">EXIT {exit}</span>}
			{chips.map((chip, index) => <span className="omp-chip" key={index}>{displayText(chip)}</span>)}
			<span className="omp-output-spacer" />
			{format !== null && <>
				<span className="omp-segmented" role="group" aria-label="Output format">
					{(["formatted", "text"] as const).map(choice => <button key={choice} type="button" className="omp-segment" aria-pressed={viewState.format === choice} onClick={() => setViewState({ format: choice })}>{choice === "formatted" ? "Formatted" : "Text"}</button>)}
				</span>
				{formatted && format.kind !== "rows" && <FoldAllButtons source={format} scope={OUTPUT_SCOPE} />}
			</>}
			{copyText !== "" && <ToolCopyButton text={copyText} label={`Copy ${outputLabel.toLowerCase()}`} what={`the ${outputLabel.toLowerCase()}`} />}
			<ToolMenu items={menuItems} />
		</div> : null;
	// The sticky toolbar of the full view: Collapse, the filter, the wrap switch. Filter and wrap work on the whole text, not on the rows in the page.
	const outputLines = useMemo(() => full ? copyText.split("\n") : [], [full, copyText]);
	const filterText = viewState.filter.trim().toLowerCase();
	const filterMatches = useMemo(() => filterText === "" ? 0 : outputLines.filter(line => line.toLowerCase().includes(filterText)).length, [outputLines, filterText]);
	const wrapOn = viewState.wrap;
	const toolbar = full ? <div className="omp-tool-toolbar">
		<span className="omp-tool-collapse"><button type="button" className="omp-output-more" onClick={collapse}><span className="codicon codicon-chevron-up" aria-hidden="true" />Collapse</button></span>
		<input type="text" className="omp-tool-filter" aria-label="Filter lines" placeholder="Filter lines" value={viewState.filter} spellCheck={false}
			onChange={event => setViewState({ filter: event.target.value })}
			onKeyDown={event => { if (event.key === "Escape" && viewState.filter !== "") { event.preventDefault(); event.stopPropagation(); setViewState({ filter: "" }); } }} />
		{filterText !== "" && <span className="omp-tool-filter-count" role="status">{filterMatches.toLocaleString("en-US")} of {outputLines.length.toLocaleString("en-US")} lines</span>}
		<button type="button" className="omp-iconbtn" aria-label="Wrap long lines" aria-pressed={wrapOn} title={wrapOn ? "Long lines wrap" : "Long lines scroll sideways"} onClick={() => setViewState({ wrap: !wrapOn })}><span className="codicon codicon-word-wrap" aria-hidden="true" /></button>
		{copyText !== "" && <ToolCopyButton text={copyText} label={`Copy ${outputLabel.toLowerCase()}`} what={`the ${outputLabel.toLowerCase()}`} />}
		<ToolMenu items={menuItems} />
	</div> : null;
	const body = frozen ? retainedBody.current : <ToolViewContext.Provider value={toolView}>
		{toolbar}
		{errorText && !text.includes(errorText) && <Section title="Error"><TextPreview text={errorText} expanded={full} lines={4} /></Section>}
		{state === "skipped" ? <div className="omp-empty-note">Skipped — this call did not complete.</div> : <>
			{view?.input?.map(block => <div className="omp-tool-input" key={block.label}>
				<div className="omp-output-bar"><span className="omp-output-label">{block.label}</span><span className="omp-output-spacer" /><ToolCopyButton text={block.copy} label={`Copy ${block.label.toLowerCase()}`} what={`the ${block.label.toLowerCase()}`} /></div>
				{block.node}
			</div>)}
			{outputBar}
			{view?.body}
			{viewState.raw && source !== undefined && <section className="omp-tool-raw" aria-label="Raw result and details">
				<div className="omp-tool-input">
					<div className="omp-output-bar"><span className="omp-output-label">Raw result</span><span className="omp-output-spacer" /><ToolCopyButton text={rawText} label="Copy raw result" what="the raw result" /></div>
					{rawText === "" ? <div className="omp-empty-note">The result has no text.</div> : <TextPreview text={rawText} expanded={full} />}
				</div>
				<div className="omp-tool-input">
					<div className="omp-output-bar"><span className="omp-output-label">Details</span><span className="omp-output-spacer" /><ToolCopyButton text={() => rawDetailsCopy(details)} label="Copy details JSON" what="the details" /></div>
					{hasDetails ? <JsonOutput value={rawDetailsView(details)} expanded={full} id="raw-details" /> : <div className="omp-empty-note">The result has no details.</div>}
				</div>
			</section>}
		</>}
		{nontext.length > 0 && <MessageContentView content={nontext} />}
		{attachments?.map((attachment, index) => <Section key={`${attachment.timestamp}:${index}`} title={`Late diagnostics${attachment.attribution ? ` · ${attachment.attribution}` : ""}`}>
			{lateDiagnosticsFiles(attachment.details).map((file, fileIndex) => <Section key={fileIndex} title={file.path ?? "File diagnostics"}><Diagnostics value={file} expanded={full} /></Section>)}
		</Section>)}
		<ToolFooter parts={footer} />
	</ToolViewContext.Provider>;
	useLayoutEffect(() => {
		if (!frozen && showBody) { retainedBody.current = body; retainedView.current = view; retainedState.current = viewState; }
	}, [frozen, showBody, body, view, viewState]);
	if (name === "wait" && result && isInterruptedToolResult(result)) return null;
	// Nothing to disclose: a settled, error-free call whose expanded details would be empty is one static row.
	const bare = state === "complete" && result !== undefined && !frozen && !failed && diagnosticCount === 0 && nontext.length === 0 && (attachments?.length ?? 0) === 0 && hasNoDetails({ name, args: record(args), details, stream, text });
	// A command's own text is coloured by the language of the tool that runs it (the digest of several agents is not code).
	const commandLanguage = compactTarget === null && Object.hasOwn(COMMAND_LANGUAGES, name) ? COMMAND_LANGUAGES[name] : undefined;
	const commandClosed = state !== "running" && state !== "queued";
	// A skill load wears the skill-prompt block's book, whether or not its renderer has run yet.
	const toolIcon = metadata.skill !== null ? "book" : view?.icon ?? TOOL_ICONS[metadata.route.name] ?? "tools";
	const aux = intent?.replace(/\s+/g, " ").trim() || undefined;
	// The head says what a result says at a glance; the digest of agents and the wait face say it themselves.
	const elapsed = live && props.startedAt !== undefined ? Math.max(0, Date.now() - props.startedAt) : undefined;
	const gist: readonly GistPart[] = compactTarget !== null || waitFace || pendingAsk || state === "skipped" || state === "queued" || rendererKind === "yield" || rendererKind === "autoresearch" ? []
		: live ? elapsed !== undefined && elapsed >= 1000 ? [{ text: formatGistDuration(elapsed), tone: "plain" }] : []
		: result === undefined ? []
		: toolGist({ name: route.name, args: route.args, details: route.details, body: metadata.skill !== null ? stripSkillHeader(text) : text, notices: split.notices, failed, settled: true, startedAt: props.startedAt, endedAt: props.endedAt, observedMs });
	if (bare) {
		const target = compactTarget?.digest ?? metadata.target;
		return <div ref={root} className="omp-tool omp-native-tool omp-native-tool--bare" data-tool-name={name} data-tool-family={metadata.route.name} data-tool-call-id={props.callId ?? result.toolCallId} data-tool-status={state}>
			<div className="omp-tool-head omp-tool-head--static" title={[metadata.title, compactTarget?.detail ?? target, aux, "no output"].filter(Boolean).join(" · ")}>
				{/* The empty twistie slot keeps the icon in the column of the rows that disclose. */}
				<span className="codicon codicon-blank" aria-hidden="true" />
				<span className={`codicon codicon-${toolIcon}`} aria-hidden="true" />
				<span className="omp-tool-name">{metadata.title}</span>
				{target && <span className="omp-tool-digest" title={compactTarget?.detail ?? target}><ToolTargetText category={metadata.category} paths={metadata.paths} text={displayText(target)} line={changedLine} revalidate={state} language={commandLanguage} closed={commandClosed} /></span>}
				{aux && <span className="omp-tool-aux omp-tool-aux--intent" title={aux}>{aux}</span>}
				<span className="omp-tool-aux omp-tool-aux--none">no output</span>
				<span className="omp-sr-only" role="status">{state}</span>
			</div>
		</div>;
	}
	const headTarget = compactTarget?.digest ?? view?.target ?? metadata.target;
	const face = <>
		{!pendingAsk && !(state === "complete" && !failed) && <span className={`codicon codicon-${failed ? "error omp-tool-status--failed" : STATE_ICONS[state]}`} aria-hidden="true" />}
		<span className={`codicon codicon-${toolIcon}`} aria-hidden="true" />
		<span className="omp-tool-name">{waitFace && view?.title?.startsWith("Waiting on") ? <><span className="omp-wait-title-full">{view.title}</span><span className="omp-wait-title-short">Wait</span></> : view?.title ?? metadata.title}</span>
		{headTarget && <span className="omp-tool-digest" title={compactTarget?.detail ?? headTarget}><ToolTargetText category={metadata.category} paths={metadata.paths} text={displayText(headTarget)} line={changedLine} revalidate={state} language={commandLanguage} closed={commandClosed} /></span>}
		{view?.inline}
		{aux && <span className="omp-tool-aux omp-tool-aux--intent" title={aux}>{aux}</span>}
		{gist.length > 0 && <span className="omp-gist">{gist.map((part, index) => <span key={index} className={`omp-gist-part${part.tone === "plain" ? "" : ` omp-gist--${part.tone}`}${part.optional ? " omp-gist-opt" : ""}`}>{index > 0 && <span aria-hidden="true"> · </span>}{part.text}</span>)}</span>}
		{metaInHead && view?.meta?.map((meta, index) => <span className="omp-native-tool-meta" key={index}>{displayText(meta)}</span>)}
		{metadata.stats && <DiffStatSpans stats={metadata.stats} />}
		{metadata.counter && <span className="omp-native-tool-meta omp-tool-counter">{metadata.counter}</span>}
		{jobChip !== null && <JobChip cardJob={jobChip} />}
		{diagnosticCount > 0 && <span className="omp-chip omp-chip--warn"><span className="codicon codicon-warning" aria-hidden="true" />{diagnosticCount} diagnostics</span>}
		{/* Failure is conveyed by one status icon; skipped calls retain their readable badge. */}
		{!pendingAsk && state === "skipped" && <span className="omp-chip">{state}</span>}
		<span className="omp-sr-only" role="status">{pendingAsk ? "Waiting for your answer" : failed ? "error" : state}</span>
		{metadata.category === "edit" && (state === "running" || state === "queued") && !showBody && <span className="omp-empty-note">preparing edit…</span>}
		{view?.trailing}
	</>;
	// The expanded body would only repeat the header and its tooltip: no chevron, no toggle, nothing focusable.
	const plainRow = view?.expandable === false && !failed && diagnosticCount === 0 && nontext.length === 0 && (attachments?.length ?? 0) === 0 && !frozen;
	const title = [intent, view?.tooltip].filter(Boolean).join("\n");
	if (plainRow) {
		return <div ref={root} className={`omp-tool omp-native-tool omp-native-tool--static${jobCancel !== null ? " omp-native-tool--job-cancel" : ""}`} data-tool-name={name} data-tool-family={view?.family ?? metadata.route.name} data-tool-call-id={props.callId ?? result?.toolCallId} data-tool-status={state}>
			<div className={`omp-tool-head omp-tool-head--static${aux ? " omp-tool-head--intent" : ""}${view?.inline ? " omp-tool-head--inline" : ""}`} title={title || undefined}><span className="codicon codicon-blank" aria-hidden="true" />{face}</div>
		</div>;
	}
	return <div ref={root} className={`omp-tool omp-native-tool${failed ? " omp-tool--error" : ""}${state === "skipped" ? " omp-native-tool--skipped" : ""}${jobCancel !== null ? " omp-native-tool--job-cancel" : ""}`} data-tool-name={name} data-tool-family={view?.family ?? metadata.route.name} data-tool-call-id={props.callId ?? result?.toolCallId} data-tool-status={state} onKeyDown={event => {
			{jobCancel !== null && <JobCancel cardJob={jobCancel} />}
		if (event.key !== "Escape" || !showBody || !root.current?.contains(document.activeElement)) return;
		event.preventDefault(); event.stopPropagation();
		collapse();
	}}>
		<button type="button" className={`omp-tool-head${aux ? " omp-tool-head--intent" : ""}${view?.inline ? " omp-tool-head--inline" : ""}`} aria-expanded={showBody} aria-controls={bodyId} onClick={() => { const next = !expanded; setLocalExpanded(next); props.onExpandedChange?.(next); }} title={title || (showBody ? "Hide tool details" : "Show complete tool details")}>
			<span className={`codicon codicon-${showBody ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
			{face}
		</button>
		{jobCancel !== null && <JobCancel cardJob={jobCancel} />}
		{showBody && <div id={bodyId} className={menuOnly && !full ? "omp-tool-body omp-tool-body--menu-only" : "omp-tool-body"} role="region" aria-label={`${view?.title ?? metadata.title} details`} tabIndex={0}>{body}</div>}
	</div>;
});

