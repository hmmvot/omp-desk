import type { ReactNode } from "react";
import { useState } from "react";
import type { AgentActivity, RunningAgent } from "../../chat/agents";
import { isClosedTodo, parseTodoPhases, selectCollapsedTodos, todoMatchesDescriptions } from "../../chat/todos";
import { AGENT_STATUS_ICON } from "../../chat/hud-summary";
import { resolveToolRoute } from "../../chat/tool-presentation";
import { isRecord } from "../../guards";
import { Markdown } from "./Markdown";
import { FileLink, FileLinkText } from "./FileLinks";
import type { ExplicitFileLink } from "./FileLinks";
import { fmtDuration, fmtTokens } from "../lib/format";
import { useLiveDurations } from "../lib/live-clock";
import { CodePreview, Diagnostics, DiffPreview, groupedFiles, JsonOutput, LimitedList, Link, MatchOutput, record, records, scalar, Section, string, strings, TextPreview, ToolImage } from "./tool-renderer-primitives";
import { AgentProgressView } from "./AgentProgress";

export interface ToolRenderContext {
	name: string;
	args: Record<string, unknown>;
	details: Record<string, unknown>;
	text: string;
	expanded: boolean;
	partial: boolean;
	hasResult: boolean;
	isError: boolean;
	stream: Record<string, unknown>;
	callId?: string;
	agents?: ReadonlyMap<string, RunningAgent>;
	agentActivity?: ReadonlyMap<string, AgentActivity>;
	renderChild?: (id: string) => ReactNode;
	cwd?: string;
}
export interface ToolSemanticView {
	title: string;
	icon?: string;
	target?: string;
	meta?: readonly string[];
	tone?: "error" | "warning" | "info";
	/** Native collapsed body row budget; "none" means the family emits its own compact rows. */
	preview?: number | { tail: number } | "none";
	/** One-line face extras rendered in the collapsed header after the target. */
	inline?: ReactNode;
	/** Right-aligned header slot, after every other face element (a component may own a clock). */
	trailing?: ReactNode;
	/** False when the expanded body would only repeat the header and tooltip: the row is then not a disclosure. Absent means expandable. */
	expandable?: boolean;
	/** Full header tooltip, for facts the one-line face truncates. */
	tooltip?: string;
	body: ReactNode;
	family: string;
}
type ToolRenderer = (context: ToolRenderContext) => ToolSemanticView;

function presentArgs(args: Record<string, unknown>): Record<string, unknown> {
	let projected: Record<string, unknown> | undefined;
	for (const key in args) if (Object.hasOwn(args, key) && args[key] == null) {
		projected ??= { ...args };
		delete projected[key];
	}
	return projected ?? args;
}

function OutputMetadata({ details }: { details: Record<string, unknown> }): ReactNode {
	const meta = record(details.meta);
	const truncation = record(meta.truncation ?? details.truncation);
	const limits = record(meta.limits ?? details.limits);
	const notices: string[] = [];
	if (typeof truncation.totalLines === "number") {
		const range = record(truncation.shownRange);
		const head = record(truncation.headRange);
		const tail = record(truncation.tailRange);
		if (truncation.direction === "middle") {
			const ranges = [typeof head.start === "number" && typeof head.end === "number" ? `${head.start}–${head.end}` : "", typeof tail.start === "number" && typeof tail.end === "number" ? `${tail.start}–${tail.end}` : ""].filter(Boolean).join(" and ");
			const elidedLines = typeof truncation.elidedLines === "number" ? truncation.elidedLines : typeof truncation.outputLines === "number" ? Math.max(0, truncation.totalLines - truncation.outputLines) : undefined;
			const elidedBytes = typeof truncation.elidedBytes === "number" ? truncation.elidedBytes : typeof truncation.totalBytes === "number" && typeof truncation.outputBytes === "number" ? Math.max(0, truncation.totalBytes - truncation.outputBytes) : undefined;
			notices.push(ranges ? `Showing lines ${ranges} of ${truncation.totalLines}; ${elidedLines === undefined ? "middle" : `${elidedLines.toLocaleString()} middle lines`}${elidedBytes === undefined ? "" : ` (${elidedBytes} bytes)`} elided` : typeof elidedBytes === "number" && elidedBytes > 0 ? `Showing head and tail bytes of ${truncation.totalLines} lines; ${elidedBytes} bytes elided` : `Showing ${scalar(truncation.outputLines)} of ${truncation.totalLines} lines; middle elided`);
		} else if (truncation.partialLine === true) {
			notices.push(`Showing line ${typeof range.start === "number" ? range.start : 1} (partial, ${scalar(truncation.outputBytes)} of ${scalar(truncation.totalBytes)} bytes) of ${truncation.totalLines}`);
		} else {
			notices.push(typeof range.start === "number" && typeof range.end === "number" ? `Showing lines ${range.start}–${range.end} of ${truncation.totalLines}` : `Showing ${scalar(truncation.outputLines)} of ${truncation.totalLines} lines`);
		}
		if (truncation.direction !== "middle" && truncation.partialLine !== true && truncation.truncatedBy === "bytes" && typeof (truncation.maxBytes ?? truncation.outputBytes) === "number") notices.push(`${scalar(truncation.maxBytes ?? truncation.outputBytes)} bytes limit`);
		if (truncation.partialLine !== true && typeof truncation.nextOffset === "number") notices.push(`Use :${truncation.nextOffset} to continue`);
	}
	const artifact = scalar(truncation.artifactId ?? meta.artifactId);
	if (artifact) notices.push(record(meta.source).type === "report" ? `Read artifact://${artifact} for full report (${scalar(record(meta.source).value)})` : `Read artifact://${artifact} for full output`);
	const artifactError = meta.artifactError ?? details.artifactError;
	if (artifactError === "open" || artifactError === "write" || artifactError === "flush" || artifactError === "end") notices.push(`Full output was not saved completely (artifact ${artifactError} failed)`);
	for (const key of ["matchLimit", "resultLimit", "headLimit"]) {
		const limit = record(limits[key]);
		if (typeof limit.reached === "number") notices.push(`${limit.reached} ${key === "matchLimit" ? "matches" : "results"} limit reached${typeof limit.suggestion === "number" ? `. Use limit=${limit.suggestion} for more` : ""}`);
	}
	const column = record(limits.columnTruncated);
	if (typeof column.maxColumn === "number") notices.push(`Some lines truncated to ${column.maxColumn} ${column.unit === "bytes" ? "bytes" : "chars"}${scalar(column.artifactId) ? `. Read artifact://${scalar(column.artifactId)} for full output` : ""}`);
	return notices.length > 0 ? <p className="omp-native-warning">{notices.join(". ")}</p> : null;
}
function ParseErrors({ details, expanded }: { details: Record<string, unknown>; expanded: boolean }): ReactNode {
	const errors = strings(details.parseErrors);
	return errors.length > 0 ? <Section title={`Parse errors · ${scalar(details.parseErrorsTotal) || errors.length}`}><LimitedList items={errors} expanded={expanded} render={error => <span className="omp-native-error">{string(error)}</span>} /></Section> : null;
}
function ask(c: ToolRenderContext): ToolSemanticView {
	const { args: a, details: d } = c;
	const questions = records(d.results).length ? records(d.results) : d.question !== undefined ? [d] : records(a.questions).length ? records(a.questions) : [a];
	return { title: !c.hasResult && !c.isError ? "Waiting for your answer" : "Ask", icon: "question", family: "ask", target: string(questions[0]?.question), meta: questions.length > 1 ? [`${questions.length} questions`] : undefined, tone: d.chatRedirect === true ? "info" : undefined,
		body: d.chatRedirect === true ? <Section title="Chat redirect">{strings(d.questions).map((question, index) => <Markdown key={index} text={question} />)}</Section> : <>{questions.map((question, index) => {
			const selected = new Set(strings(question.selectedOptions));
			const options = Array.isArray(question.options) ? question.options : [];
			const answered = selected.size > 0 || question.customInput !== undefined || question.note !== undefined;
			return <Section key={index} title={string(question.id) || `Question ${index + 1}`}><Markdown text={string(question.question)} /><ul className="omp-native-answers">{options.map((option, i) => {
				const label = typeof option === "string" ? option : string(record(option).label);
				const chosen = selected.has(label);
				const marker = question.multi === true ? (chosen ? "check" : "blank") : chosen ? "circle-large-filled" : "circle-large-outline";
				return <li key={i} className={chosen ? "omp-native-selected" : ""}><span className={`omp-ask-option-marker${question.multi === true ? " omp-ask-option-marker--checkbox" : ""} codicon codicon-${marker}`} aria-hidden="true" /> {label}{isRecord(option) && typeof option.description === "string" && <div className="omp-empty-note">{option.description}</div>}</li>;
			})}</ul>{question.customInput !== undefined && <Section title="Custom input"><Markdown text={string(question.customInput)} /></Section>}{question.note !== undefined && <Section title="Note"><Markdown text={string(question.note)} /></Section>}{question.timedOut === true && <div className="omp-native-warning">Auto-selected after timeout — not a user choice</div>}{!answered && question.multi !== true && c.hasResult && !c.isError && <div className="omp-native-warning">Cancelled</div>}{!c.hasResult && <div className="omp-empty-note">Waiting for your answer…</div>}</Section>;
		})}{c.hasResult && d.question === undefined && d.results === undefined && <TextPreview text={c.text} expanded={c.expanded} prose />}</> };
}
function astGrep(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	return { title: "AST Grep", family: "ast-grep", target: string(c.args.pat), meta: [d.matchCount !== undefined ? `${scalar(d.matchCount)} matches` : "", d.fileCount !== undefined ? `${scalar(d.fileCount)} files` : "", d.filesSearched !== undefined ? `searched ${scalar(d.filesSearched)}` : "", scalar(d.scopePath || c.args.path || c.args.paths), c.args.skip !== undefined ? `skip:${scalar(c.args.skip)}` : ""].filter(Boolean), tone: d.matchCount === 0 || d.limitReached === true ? "warning" : undefined,
		preview: 6,
		body: <>{d.matchCount === 0 ? <div className="omp-empty-note">No matches found{strings(d.parseErrors).length > 0 ? "; parse issues may mean the query is mis-scoped" : ""}</div> : <MatchOutput text={string(d.displayContent) || c.text} expanded={c.expanded} matchLimit={6} />}<ParseErrors details={d} expanded={c.expanded} />{d.limitReached === true && <div className="omp-native-warning">Limit reached; narrow path or increase limit</div>}<OutputMetadata details={d} /></> };
}
function AstChanges({ text, expanded }: { text: string; expanded: boolean }): ReactNode {
	const groups: { path: string; lines: string[] }[] = [];
	for (const file of groupedFiles(text)) {
		let previous: number | undefined;
		let group: { path: string; lines: string[] } | undefined;
		for (const line of file.lines) {
			const row = /^([+\- ])\s*(\d+)(?:│|[:|])(.*)$/.exec(line);
			if (!row) continue;
			const number = Number(row[2]);
			if (!group || previous === undefined || number > previous + 1 || number < previous) {
				group = { path: file.path, lines: [`@@ -${number} +${number} @@`] };
				groups.push(group);
			}
			group.lines.push(`${row[1]}${row[3]}`);
			previous = number;
		}
	}
	if (groups.length === 0) return <TextPreview text={text} expanded={expanded} lines={6} />;
	const shown: typeof groups = [];
	let used = 0;
	for (const group of groups) {
		const size = group.lines.length + (shown.length ? 1 : 0);
		if (!expanded && shown.length > 0 && used + size + (shown.length + 1 < groups.length ? 1 : 0) > 6) break;
		shown.push(group); used += size;
	}
	return <>{shown.map((group, index) => <Section key={index} title={group.path || "Changes"}><DiffPreview text={group.lines.join("\n")} expanded /></Section>)}{shown.length < groups.length && <div className="omp-empty-note">{groups.length - shown.length} more changes</div>}</>;
}
function astEdit(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const ops = records(c.args.ops);
	const text = string(d.displayContent) || c.text;
	const pattern = ops.length === 1 ? string(ops[0]!.pat).replace(/\s+/g, " ").trim() : `${ops.length} rewrites`;
	return { title: "AST Edit", family: "ast-edit", target: pattern, meta: [d.totalReplacements !== undefined ? `${scalar(d.totalReplacements)} replacements` : "", d.filesTouched !== undefined ? `${scalar(d.filesTouched)} files` : "", d.filesSearched !== undefined ? `searched ${scalar(d.filesSearched)}` : "", d.applied === false ? "proposed" : "", d.limitReached === true ? "limit reached" : ""].filter(Boolean), tone: d.totalReplacements === 0 || d.limitReached === true ? "warning" : undefined,
		preview: 6,
		body: <>{!c.hasResult && <LimitedList items={ops} expanded={c.expanded} limit={6} render={op => <><Section title="Pattern"><TextPreview text={string(op.pat)} expanded={c.expanded} /></Section><Section title="Rewrite"><TextPreview text={string(op.out)} expanded={c.expanded} /></Section></>} />}{d.totalReplacements === 0 ? <div className="omp-empty-note">No edits</div> : <AstChanges text={text} expanded={c.expanded} />}<ParseErrors details={d} expanded={c.expanded} /><OutputMetadata details={d} /></> };
}
function withoutBashNotice(output: string, notice: string): string {
	const at = output.lastIndexOf(notice);
	return at < 0 ? output : (output.slice(0, at) + output.slice(at + notice.length)).trimEnd();
}
/** Strips the notices OMP appends for the model (background job, exit code, wall time, artifact pointer); they are status facts, not shell output. */
function bashOutput(source: string, details: Record<string, unknown>): string {
	let output = source;
	const async = record(details.async);
	if (async.state === "running" && typeof async.jobId === "string") output = withoutBashNotice(output, `Backgrounded as job ${async.jobId}; its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no \`sleep\`, \`ps\`, \`pgrep\`, \`top\`, \`pidwait\`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.`);
	if (typeof details.exitCode === "number") output = withoutBashNotice(output, `Command exited with code ${details.exitCode}`);
	if (typeof details.wallTimeMs === "number") output = withoutBashNotice(output, `Wall time: ${(details.wallTimeMs / 1000).toFixed(2)} seconds`);
	const meta = record(details.meta);
	const artifact = scalar(record(meta.truncation).artifactId ?? meta.artifactId);
	if (artifact) output = withoutBashNotice(output, `[raw output: artifact://${artifact}]`);
	return output.trimEnd();
}
function bash(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	let cwd = string(c.args.cwd).replaceAll("\\", "/").replace(/\/$/, "");
	const root = c.cwd?.replaceAll("\\", "/").replace(/\/$/, "");
	if (cwd === "." || cwd === root) cwd = "";
	else if (root && cwd.startsWith(`${root}/`)) cwd = cwd.slice(root.length + 1);
	const env = Object.entries(record(c.args.env)).filter(([, value]) => value != null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
		.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}="${String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`).join(" ");
	const command = [cwd ? `cd ${cwd} &&` : "", env, string(c.args.command)].filter(Boolean).join(" ");
	const service = record(d.service);
	const serviceParts = [scalar(service.name), scalar(service.state), service.name ? service.ready === true ? "ready" : service.timedOut === true ? "ready timed out" : "not ready" : "", typeof service.pid === "number" ? `PID ${service.pid}` : ""].filter(Boolean);
	return { title: c.args.name ? `Bash · ${scalar(c.args.name)}` : "Bash", family: "bash", target: command, meta: [typeof d.exitCode === "number" && d.exitCode !== 0 ? `exit ${d.exitCode}` : "", d.timedOut === true ? "timed out" : "", record(d.async).state === "running" ? "background" : ""].filter(Boolean), tone: d.timedOut === true ? "warning" : undefined,
		preview: { tail: 10 },
		body: <><TextPreview text={bashOutput(string(c.stream.output) || c.text, d)} expanded={c.expanded} lines={10} tail />{serviceParts.length > 0 && <p className="omp-empty-note">{serviceParts.join(" · ")}</p>}<OutputMetadata details={d} /></> };
}
/** True when the details carry no truncation, limit or artifact notice. */
function noNotices(details: Record<string, unknown>): boolean {
	const meta = record(details.meta);
	return Object.keys(record(meta.truncation ?? details.truncation)).length === 0 && Object.keys(record(meta.limits ?? details.limits)).length === 0
		&& !scalar(record(meta.truncation).artifactId ?? meta.artifactId) && !(meta.artifactError ?? details.artifactError);
}
const NO_OUTPUT_TEXT = /^(?:\(no output\))?$/;
/**
 * A settled call whose expanded body would be empty: only an empty result with no error, exit code,
 * notice or service/background state. Callers separately require success, diagnostics and artifacts to be absent.
 */
export function hasNoDetails(c: Pick<ToolRenderContext, "name" | "args" | "details" | "stream" | "text">): boolean {
	const d = c.details;
	if (c.name === "bash") {
		const exited = typeof d.exitCode !== "number" || d.exitCode === 0;
		return exited && d.timedOut !== true && record(d.async).state !== "running" && d.service === undefined && noNotices(d)
			&& NO_OUTPUT_TEXT.test(bashOutput(string(c.stream.output) || c.text, d).trim());
	}
	if (c.name === "read") {
		const path = string(c.args.path ?? c.args.file_path);
		if (d.proc !== undefined || d.cfg !== undefined || /^(?:proc|cfg):\/\//i.test(path) || d.isDirectory === true || d.suffixResolution || d.conflictCount !== undefined) return false;
		return noNotices(d) && !string(record(d.displayContent).text) && NO_OUTPUT_TEXT.test(c.text.trim());
	}
	return false;
}
function debug(c: ToolRenderContext): ToolSemanticView {
	const snapshot = record(c.details.snapshot);
	const location = typeof snapshot.source === "string" ? snapshot.source : string(record(snapshot.source).path);
	const description = [string(snapshot.program), string(snapshot.frameName), location ? `${location}${typeof snapshot.line === "number" ? `:${snapshot.line}` : ""}` : "", typeof snapshot.exitCode === "number" ? `exit ${snapshot.exitCode}` : ""].filter(Boolean).join(" · ");
	return { title: "Debug", family: "debug", target: [scalar(c.args.action || c.details.action), ...["program", "file", "line", "function", "expression", "command", "name"].map(key => scalar(c.args[key]))].filter(Boolean).join(" · "), meta: [scalar(snapshot.status), scalar(snapshot.stopReason)].filter(Boolean),
		preview: 3 + (description ? 1 : 0) + (snapshot.needsConfigurationDone === true ? 1 : 0),
		body: <>{description && <p className="omp-empty-note">{description}</p>}{snapshot.needsConfigurationDone === true && <div className="omp-native-warning">Configuration pending; set breakpoints, then continue.</div>}<TextPreview text={c.text} expanded={c.expanded} /></> };
}
function editSectionTitle(file: Record<string, unknown>): string {
	return [string(file.sourcePath), scalar(file.op), string(file.path), file.firstChangedLine !== undefined ? `line ${scalar(file.firstChangedLine)}` : "", scalar(file.move ?? file.rename) ? `→ ${scalar(file.move ?? file.rename)}` : ""].filter(Boolean).join(" · ") || "Diff";
}
/** The section's path opens the file at the first changed line, when the result says where that is. */
function editSectionLink(file: Record<string, unknown>): ExplicitFileLink | undefined {
	const path = string(file.path);
	return path && typeof file.firstChangedLine === "number" ? { text: path, target: `${path}:${file.firstChangedLine}`, proof: path } : undefined;
}
function edit(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const finalized = c.hasResult && !c.partial;
	const preview = finalized ? {} : record(c.stream.editDiffPreview);
	const streamedFiles = finalized ? [] : records(c.stream.files).length ? records(c.stream.files) : records(c.stream.perFileDiffPreview);
	const files = records(d.perFileResults).length ? records(d.perFileResults) : streamedFiles.length ? streamedFiles : [{
		...d, path: d.path ?? c.args.path ?? c.args.file_path,
		diff: finalized ? d.diff : d.diff ?? preview.diff ?? c.args.previewDiff ?? c.args.diff,
		firstChangedLine: d.firstChangedLine ?? preview.firstChangedLine,
		error: d.error ?? preview.error,
	}];
	const path = string(files[0]?.path);
	let added = 0; let removed = 0;
	for (const file of files) for (const line of string(file.diff).split("\n")) { if (line.startsWith("+") && !line.startsWith("+++")) added++; if (line.startsWith("-") && !line.startsWith("---")) removed++; }
	const failed = files.some(file => file.isError === true || string(file.error) || string(file.errorText) || string(file.displayErrorText));
	const op = scalar(d.op ?? c.args.op ?? files[0]?.op);
	return { title: op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit", family: "edit", target: files.length > 1 ? `${files.length} files` : [string(d.sourcePath) || path, scalar(d.move ?? c.args.rename ?? files[0]?.rename) ? `→ ${scalar(d.move ?? c.args.rename ?? files[0]?.rename)}` : ""].filter(Boolean).join(" "), meta: [`+${added} −${removed}`], tone: failed ? "error" : undefined,
		body: <>{files.map((file, index) => <Section key={index} title={editSectionTitle(file)} link={editSectionLink(file)}>
			{string(file.displayErrorText ?? file.errorText ?? file.error) && <div className="omp-native-error"><TextPreview text={string(file.displayErrorText ?? file.errorText ?? file.error)} expanded={c.expanded} /></div>}
			<DiffPreview text={string(file.diff)} expanded={c.expanded} /><Diagnostics value={file.diagnostics} expanded={c.expanded} />
			{c.expanded && <OutputMetadata details={file} />}
		</Section>)}{!files.some(file => string(file.diff)) && <TextPreview text={finalized ? c.text : string(c.stream.editStreamingFallback) || string(c.args.newText) || string(c.args.patch) || string(c.args.input) || c.text} expanded={c.expanded} lines={6} />}<OutputMetadata details={d} /></> };
}
function statusEventText(event: Record<string, unknown>): string {
	const op = string(event.op);
	if (event.error) return `${op}: ${scalar(event.error)}`;
	let detail = "";
	switch (op) {
		case "read": case "write": detail = `${scalar(event.chars ?? event.bytes ?? 0)} chars ${op === "read" ? "from" : "to"} ${string(event.path)}`; break;
		case "cat": case "batch": detail = `${scalar(event.files)} files · ${scalar(event.chars)} chars`; break;
		case "ls": detail = `${scalar(event.count)} entries`; break;
		case "env": detail = event.action === "get" || event.action === "set" ? `${event.action === "set" ? "set " : ""}${scalar(event.key)}=${scalar(event.value).slice(0, 30)}` : `${scalar(event.count)} variables`; break;
		case "git_status": detail = [event.clean ? "clean" : ["staged", "modified", "untracked"].filter(key => event[key]).map(key => `${scalar(event[key])} ${key}`).join(", "), event.branch ? `on ${scalar(event.branch)}` : ""].filter(Boolean).join(" · "); break;
		case "git_log": detail = `${scalar(event.commits)} commits`; break;
		case "git_diff": detail = `${scalar(event.lines)} lines${event.staged ? " · staged" : ""}`; break;
		case "completion": detail = [scalar(event.model), scalar(event.tier), `${scalar(event.chars ?? 0)} chars`].filter(Boolean).join(" · "); break;
		case "tool_define": detail = `${scalar(event.name)}(${strings(event.params).join(", ")})`; break;
		case "workpool": detail = `${scalar(event.action)} ${scalar(event.pool)}${typeof event.count === "number" ? ` · ${event.count} ${event.action === "create" ? "agents" : "items"}` : ""}`; break;
		case "judge_batch": detail = [scalar(event.action), `${scalar(event.done ?? 0)}/${scalar(event.total ?? 0)}`, event.failed ? `${scalar(event.failed)} failed` : "", scalar(event.model)].filter(Boolean).join(" · "); break;
		case "wc": detail = `${scalar(event.lines)}L ${scalar(event.words)}W ${scalar(event.chars)}C`; break;
		case "cd": case "pwd": case "mkdir": case "touch": detail = string(event.path); break;
		case "log": detail = string(event.message); break;
		case "phase": detail = string(event.title); break;
		default: detail = [string(event.detail).slice(0, 80), scalar(event.count), string(event.path)].filter(Boolean).join(" · ");
	}
	return [op, detail.trim()].filter(Boolean).join(" · ");
}
function StatusEvents({ events, expanded }: { events: unknown; expanded: boolean }): ReactNode {
	const rows = records(events);
	const shown = rows.slice(-(expanded ? 10 : 3));
	return <>{shown.length < rows.length && <div className="omp-empty-note">{rows.length - shown.length} earlier events</div>}{shown.map((event, index) => <div className="omp-empty-note" key={index}>{statusEventText(event)}</div>)}</>;
}
function evaluate(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const cells = records(d.cells).length ? records(d.cells) : records(c.args.cells).length ? records(c.args.cells) : c.args.code !== undefined ? [c.args] : [];
	return { title: "Eval", family: "eval", target: cells.length > 1 ? `${cells.length} cells` : string(cells[0]?.title), meta: [...new Set(cells.map(cell => string(cell.language) || string(d.language)).filter(Boolean)), scalar(record(d.async).state)].filter(Boolean), tone: cells.some(cell => cell.status === "error") || d.isError === true ? "error" : undefined,
		preview: 10,
		body: <>{cells.map((cell, index) => <Section key={index} title={[`${index + 1}/${cells.length}`, string(cell.title), string(cell.language), string(cell.status), cell.exitCode !== undefined ? `exit ${scalar(cell.exitCode)}` : ""].filter(Boolean).join(" · ")}><TextPreview text={string(cell.code)} expanded={c.expanded} lines={10} tail /><Section title="Output"><TextPreview text={string(cell.output) || (index === cells.length - 1 && d.cells === undefined ? c.text : "")} expanded={c.expanded} lines={10} prose={cell.hasMarkdown === true} /><StatusEvents events={cell.statusEvents} expanded={c.expanded} /></Section>{typeof cell.durationMs === "number" && <span className="omp-empty-note">{fmtDuration(cell.durationMs)}</span>}</Section>)}{cells.length === 0 && <TextPreview text={string(c.stream.output) || c.text} expanded={c.expanded} lines={10} />}<StatusEvents events={d.statusEvents} expanded={c.expanded} />{Array.isArray(d.jsonOutputs) && <Section title="Display output"><LimitedList items={d.jsonOutputs} expanded={c.expanded} render={value => <JsonOutput value={value} expanded={c.expanded} />} /></Section>}{Array.isArray(d.images) && <Section title="Images">{d.images.map((image, index) => <ToolImage key={index} value={image} />)}</Section>}{d.notice !== undefined && <div className="omp-empty-note">{scalar(d.notice)}</div>}<OutputMetadata details={d} /></> };
}
function find(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const hits = records(d.hits);
	return { title: "Find", family: "find", target: string(c.args.query || d.query), meta: [d.hits !== undefined ? `${hits.length} hits` : "", scalar(d.scopePath || c.args.path), strings(d.keywords || c.args.grep_keywords).join(", ")].filter(Boolean), tone: c.hasResult && !c.partial && d.hits !== undefined && hits.length === 0 ? "warning" : undefined,
		preview: 12,
		body: <>{c.partial || d.hits === undefined ? <TextPreview text={c.text} expanded={c.expanded} /> : <LimitedList items={hits} expanded={c.expanded} limit={5} render={value => {
			const hit = record(value);
			const ranges = records(hit.ranges).sort((a, b) => Number(b.p) - Number(a.p) || Number(a.start) - Number(b.start));
			return <Section title={`${scalar(hit.rel)} · score ${scalar(hit.contentScore)}`}><div className="omp-empty-note">{scalar(hit.linesSeen)} lines judged{hit.truncated === true ? ", partial" : ""}</div><LimitedList items={ranges} expanded={c.expanded} limit={1} render={range => <><div className="omp-empty-note"><FileLink target={`${scalar(hit.rel)}:${typeof record(range).start === "number" ? record(range).start as number : 1}`} proof={scalar(hit.rel)}>lines {scalar(record(range).start)}–{scalar(record(range).end)}</FileLink> · {scalar(record(range).p)}</div><CodePreview text={string(record(range).snippet)} expanded={c.expanded} start={typeof record(range).start === "number" ? record(range).start as number : 1} /></>} /></Section>;
		}} />}<LimitedList items={strings(record(d.stats).failures)} expanded={c.expanded} render={error => <span className="omp-native-error">{string(error)}</span>} /><OutputMetadata details={d} /></> };
}
function glob(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const files = Array.isArray(d.files) ? strings(d.files) : c.hasResult ? c.text.split("\n").filter(line => line.trim()) : [];
	const zero = d.fileCount === 0 || (!d.fileCount && /No files (?:matching|found)/.test(c.text));
	return { title: "Glob", family: "glob", target: strings(c.args.path ?? c.args.paths).join(", "), meta: [d.fileCount !== undefined ? `${scalar(d.fileCount)} files` : c.hasResult ? `${zero ? 0 : files.length} files` : "", c.args.limit !== undefined ? `limit ${scalar(c.args.limit)}` : "", d.truncated === true ? "truncated" : ""].filter(Boolean), tone: zero || d.truncated === true ? "warning" : undefined,
		preview: 8,
		body: <>{zero ? <div className="omp-empty-note">No files found</div> : <LimitedList items={files} expanded={c.expanded} render={file => <span className="omp-native-path"><span className={`codicon codicon-${string(file).endsWith("/") ? "folder" : "file"}`} aria-hidden="true" /> <FileLinkText text={string(file)} /></span>} />}{strings(d.missingPaths).length > 0 && <div className="omp-native-warning">Skipped missing: {strings(d.missingPaths).join(", ")}</div>}<OutputMetadata details={d} /></> };
}
function grep(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	return { title: "Grep", family: "grep", target: string(c.args.pattern), meta: [d.matchCount !== undefined ? `${scalar(d.matchCount)} matches` : "", d.fileCount !== undefined ? `${scalar(d.fileCount)} files` : "", scalar(d.scopePath) || strings(c.args.path ?? c.args.paths).join(", "), c.args.case === false ? "case:insensitive" : "", c.args.gitignore === false ? "gitignore:false" : "", c.args.skip !== undefined ? `skip:${scalar(c.args.skip)}` : "", d.truncated === true ? "truncated" : ""].filter(Boolean), tone: d.error ? "error" : d.matchCount === 0 ? "warning" : undefined,
		preview: 12,
		body: <>{d.error ? <TextPreview text={string(d.error)} expanded={c.expanded} /> : d.matchCount === 0 ? <div className="omp-empty-note">No matches found</div> : <MatchOutput text={string(d.displayContent) || c.text} expanded={c.expanded} fileLimit={2} />}{strings(d.missingPaths).length > 0 && <div className="omp-native-warning">Skipped missing: {strings(d.missingPaths).join(", ")}</div>}<OutputMetadata details={d} /></> };
}
function LspReferences({ text, expanded }: { text: string; expanded: boolean }): ReactNode {
	const files = new Map<string, string[]>();
	for (const line of text.split("\n")) {
		const match = /^\s*(.+):(\d+):(\d+)\s*$/.exec(line);
		if (!match) continue;
		const path = match[1]!;
		const locations = files.get(path) ?? [];
		locations.push(`line ${match[2]}, col ${match[3]}`);
		files.set(path, locations);
	}
	if (!files.size) return <TextPreview text={text} expanded={expanded} />;
	return <LimitedList items={[...files]} expanded={expanded} limit={3} render={([path, locations]) => <Section title={`${path} · ${locations.length} references`}>
		<LimitedList items={locations} expanded={false} limit={expanded ? 3 : 1} render={location => <span>{location}</span>} />
	</Section>} />;
}
function LspDiagnostics({ text, expanded }: { text: string; expanded: boolean }): ReactNode {
	const lines = text.split("\n").filter(line => line.trim());
	const diagnostics = lines.filter(line => /:\d+(?::\d+)?/.test(line));
	if (!diagnostics.length) return <TextPreview text={text} expanded={expanded} />;
	return <><div className="omp-empty-note">{lines.filter(line => /\d+\s+(?:error|warning)/.test(line) && !diagnostics.includes(line)).join(" · ")}</div><LimitedList items={diagnostics} expanded={expanded} limit={3} render={line => <div className={/\b(?:error|fatal)\b/i.test(line) ? "omp-native-error" : "omp-native-warning"}>{line}</div>} /></>;
}
function lsp(c: ToolRenderContext): ToolSemanticView {
	const a = Object.keys(c.args).length ? c.args : record(c.details.request);
	const action = string(a.action || c.details.action) || "request";
	const diagnostics = action === "diagnostics" || /\d+\s+(?:error|warning)\(s\)/.test(c.text);
	const references = action === "references" || /\d+\s+reference\(s\)/.test(c.text);
	const symbols = /Symbols in .+:/.test(c.text);
	return { title: "LSP", family: "lsp", target: [action, string(a.file), a.line !== undefined ? `:${scalar(a.line)}` : "", scalar(a.symbol || a.query)].filter(Boolean).join(" "), meta: [a.new_name !== undefined ? `new:${scalar(a.new_name)}` : "", a.apply !== undefined ? `apply:${scalar(a.apply)}` : ""].filter(Boolean),
		preview: diagnostics || references || symbols ? 8 : 4,
		body: <Section title={diagnostics ? "Diagnostics" : references ? "References" : symbols ? "Symbols" : action === "hover" ? "Hover" : action.includes("rename") || action === "code_actions" ? "Edits" : action.replace(/_/g, " ")}>{diagnostics ? <LspDiagnostics text={c.text} expanded={c.expanded} /> : references ? <LspReferences text={c.text} expanded={c.expanded} /> : symbols ? <MatchOutput text={c.text} expanded={c.expanded} fileLimit={8} /> : <TextPreview text={c.text} expanded={c.expanded} lines={4} prose={/```/.test(c.text) || action === "hover"} />}</Section> };
}
function jobPreview(source: string): string {
	let text = source.trim();
	if (text.startsWith("<task-result")) text = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2]?.trim() || text;
	if (text.startsWith("{") || text.startsWith("[")) text = text.slice(0, 640).replace(/\s+/g, " ");
	const lines = text.split(/\r?\n/);
	const limit = 4;
	return lines.slice(0, limit).map(line => line.length > 80 ? `${line.slice(0, 79)}…` : line).join("\n") + (lines.length > limit ? "\n…" : "");
}
const JOB_STATUS_ORDER: Readonly<Record<string, number>> = { running: 0, failed: 1, cancelled: 2, completed: 3 };
/** Whether a wait result or progress carries job or agent rows, which stay visible while the call is collapsed. */
export function hasWaitRows(details: Record<string, unknown>): boolean {
	return jobList(details).length > 0 || records(details.agents).length > 0;
}
function jobList(d: Record<string, unknown>): Record<string, unknown>[] {
	const rawJobs = records(d.jobs);
	return rawJobs.length ? rawJobs : isRecord(d.job) ? [d.job] : [];
}
/** Display clock for live job rows; the shared hook keeps the last authoritative `durationMs` ticking between progress events. */
function useJobDurations(jobs: readonly Record<string, unknown>[], live: boolean): (job: Record<string, unknown>) => number | undefined {
	const durationOf = useLiveDurations(jobs.map(job => ({ id: string(job.id), reportedMs: typeof job.durationMs === "number" ? job.durationMs : undefined, running: job.status === "running" })), live);
	return job => durationOf(string(job.id));
}
const JOB_ICONS: Readonly<Record<string, string>> = { running: "loading codicon-modifier-spin", failed: "error", cancelled: "circle-slash", completed: "check" };
function JobRows({ details: d, expanded, live = false, settled = false }: { details: Record<string, unknown>; expanded: boolean; live?: boolean; settled?: boolean }): ReactNode {
	const all = jobList(d);
	// A sealed TUI wait retires its still-running rows (they are the next poll's business) unless nothing else would remain.
	const remaining = settled && records(d.agents).length === 0 ? all.filter(job => job.status !== "running") : all;
	const sorted = [...remaining.length > 0 ? remaining : all].sort((a, b) => (JOB_STATUS_ORDER[string(a.status)] ?? 4) - (JOB_STATUS_ORDER[string(b.status)] ?? 4) || Number(b.durationMs ?? 0) - Number(a.durationMs ?? 0));
	const durationOf = useJobDurations(sorted, live);
	return <><LimitedList items={sorted} expanded={expanded} render={job => {
		const status = string(job.status);
		const id = scalar(job.name || job.id);
		const lines = string(job.label).split(/\r?\n/);
		const first = lines[0]?.trim() ?? "";
		const label = first && first !== id ? first : "";
		const duration = durationOf(job);
		return <section className="omp-native-job" data-job-id={scalar(job.id)} data-job-status={status}>
			<div className="omp-native-job-head omp-native-job-head--row"><span className={`codicon codicon-${JOB_ICONS[status] ?? "check"}`} aria-hidden="true" /><span className="omp-native-badge">{scalar(job.type)}</span><strong>{id || label || "Job"}</strong>{label && <span className="omp-native-job-label" title={string(job.label)}>{lines.length > 1 ? `${label} …` : label}</span>}<span className="omp-sr-only">{status}</span>{typeof job.exitCode === "number" && <span className="omp-empty-note">exit {job.exitCode}</span>}{duration !== undefined && <span className="omp-empty-note omp-native-job-duration">{fmtDuration(duration)}</span>}</div>
			{expanded && <>{lines.slice(1, 3).some(line => line.trim()) && <div className="omp-native-job-description">{lines.slice(1, 3).map(line => line.length > 60 ? `${line.slice(0, 59)}…` : line).join("\n")}</div>}
				<TextPreview text={jobPreview(string(job.errorText || job.resultText))} expanded />
				<OutputMetadata details={job} /></>}
		</section>;
	}} /><LimitedList items={records(d.agents)} expanded={expanded} render={agent => <div className="omp-native-job-head"><span className="omp-native-badge">agent{agent.live === false ? " · no turn" : ""}</span><strong>{scalar(agent.name || agent.id)}</strong><span className="omp-native-job-label">{scalar(agent.activity)}</span>{typeof agent.ageMs === "number" && <span className="omp-empty-note">{fmtDuration(agent.ageMs)}</span>}</div>} /><LimitedList items={records(d.cancelled)} expanded={expanded} render={cancelled => <div className="omp-native-job-head"><span className="codicon codicon-circle-slash" aria-hidden="true" /><strong>{scalar(cancelled.name || cancelled.id)}</strong><span>{scalar(cancelled.status)}</span><span>{scalar(cancelled.message)}</span></div>} /></>;
}
const WAIT_STATUS_WORD: Readonly<Record<string, string>> = { running: "running", completed: "settled", failed: "failed", cancelled: "cancelled" };
/** The wait's elapsed time in the header's right-hand slot: the longest awaited job or agent, ticking while it runs. */
function WaitElapsed({ jobs, agents, live }: { jobs: readonly Record<string, unknown>[]; agents: readonly Record<string, unknown>[]; live: boolean }): ReactNode {
	const entries = [...jobs, ...agents.map(agent => ({ id: agent.id, status: "running", durationMs: agent.ageMs }))];
	const durationOf = useJobDurations(entries, live);
	const longest = Math.max(-1, ...entries.map(entry => durationOf(entry) ?? -1));
	return longest < 0 ? null : <span className="omp-empty-note omp-tool-elapsed omp-native-job-duration">{fmtDuration(longest)}</span>;
}
/** A job's own label lines past the first, or its result/error text or output notices: what the header and tooltip cannot show. */
function jobAddsDetail(job: Record<string, unknown>): boolean {
	return string(job.label).split(/\r?\n/).slice(1, 3).some(line => line.trim() !== "") || jobPreview(string(job.errorText || job.resultText)) !== "" || !noNotices(job);
}
function wait(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const waited = record(d.waited);
	const jobs = jobList(d);
	const agents = records(d.agents);
	const settled = !c.partial && agents.length === 0;
	const shown = settled && jobs.some(job => job.status !== "running") ? jobs.filter(job => job.status !== "running") : jobs;
	const counts = { running: 0, completed: 0, failed: 0, cancelled: 0 };
	for (const job of shown) counts[string(job.status) as keyof typeof counts]++;
	const noun = `${shown.length} job${shown.length === 1 ? "" : "s"}`;
	// TUI header wording: "waiting on N jobs" / "waiting on X of N jobs" while live, "N jobs settled" with per-outcome counts once sealed.
	const live = shown.length > 0 && counts.running > 0 && c.partial;
	const title = waited.from ? "IRC" : live ? counts.running === shown.length ? `Waiting on ${noun}` : `Waiting on ${counts.running} of ${noun}` : "Wait";
	const outcome = [counts.completed ? `${counts.completed} done` : "", counts.failed ? `${counts.failed} failed` : "", counts.cancelled ? `${counts.cancelled} cancelled` : ""].filter(Boolean);
	// A lone job names itself and its outcome ("Worker settled"); several jobs get a count plus their names.
	const lone = shown.length === 1 && agents.length === 0 && !waited.from ? shown[0]! : undefined;
	const loneName = lone ? scalar(lone.name || lone.id) : "";
	const target = waited.from ? scalar(waited.from) : lone ? live ? loneName : `${loneName} ${WAIT_STATUS_WORD[string(lone.status)] ?? "settled"}` : shown.length > 0 && !live ? `${noun} settled` : shown.length === 0 && agents.length > 0 ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : undefined;
	const lines = [...shown.map(job => [scalar(job.name || job.id), string(job.type), string(job.status), typeof job.durationMs === "number" ? fmtDuration(job.durationMs) : "", typeof job.exitCode === "number" ? `exit ${job.exitCode}` : "", string(job.label).split(/\r?\n/, 1)[0] ?? ""].filter(Boolean).join(" · ")), ...agents.map(agent => [scalar(agent.name || agent.id), agent.live === false ? "agent · no turn" : "agent", scalar(agent.activity), typeof agent.ageMs === "number" ? fmtDuration(agent.ageMs) : ""].filter(Boolean).join(" · "))];
	const names = [...shown, ...agents].map(entry => scalar(entry.name || entry.id)).filter(Boolean).join(", ");
	const rows = shown.length + agents.length;
	// Expansion exists only where it shows what the one-line face and its tooltip cannot: several entries (the header ellipsizes their names),
	// job results, errors or extra label lines, cancellations, output notices, an IRC message body, or the native text of a rowless result.
	const rowless = d.jobs === undefined && d.job === undefined && d.agents === undefined && d.cancelled === undefined;
	const expandable = waited.body !== undefined || rows > 1 || records(d.cancelled).length > 0 || !noNotices(d) || rowless && c.text.trim() !== "" || (lone !== undefined && jobAddsDetail(lone));
	return { title, family: "wait", target, meta: [...d.interrupted === true ? ["interrupted by message"] : [], ...shown.length > 0 && !live && !lone ? outcome : []], tone: counts.failed > 0 && !live ? "warning" : undefined,
		preview: waited.body !== undefined ? 3 : "none", tooltip: lines.length ? lines.join("\n") : undefined, expandable,
		inline: rows > 1 && waited.body === undefined && names ? <span className="omp-native-tool-meta omp-wait-names">{names}</span> : undefined,
		trailing: rows > 0 && waited.body === undefined ? <WaitElapsed jobs={shown} agents={agents} live={c.partial} /> : undefined,
		body: <>{waited.body !== undefined ? <TextPreview text={string(waited.body)} expanded={c.expanded} lines={2} prose /> : <><JobRows details={d} expanded={c.expanded} live={c.partial} settled={settled} />{rowless && <TextPreview text={c.text} expanded={c.expanded} />}</>}<OutputMetadata details={d} /></> };
}
function config(c: ToolRenderContext, writing: boolean): ToolSemanticView {
	const d = record(c.details.cfg);
	const path = string(c.args.path ?? c.args.file_path);
	const save = d.save === true || (d.save === undefined && /\/save$/.test(path));
	return { title: "Config", family: writing ? "cfg-write" : "cfg-read", target: string(d.path) || path.replace(/^cfg:\/\//i, "").replace(/\/save$/, "").replace(/\//g, ".") || "all settings", meta: writing ? [save ? "persist" : "session", scalar(d.outcome)].filter(Boolean) : [d.count !== undefined ? `${scalar(d.count)} settings` : "", d.modified !== undefined ? `${scalar(d.modified)} modified` : ""].filter(Boolean), tone: d.outcome === "declined" ? "warning" : undefined,
		preview: writing ? undefined : 8,
		body: writing ? <><div className="omp-native-config-change">{d.previous !== undefined && <><span>{scalar(d.previous)}</span> → </>}<span>{scalar(d.value ?? c.args.content)}</span></div>{d.effective !== undefined && <div className="omp-native-warning">Still {scalar(d.effective)}: a higher-precedence layer overrides the saved value.</div>}{d.outcome === "declined" && <div className="omp-empty-note">Change declined</div>}{d.outcome === "unchanged" && <div className="omp-empty-note">Unchanged</div>}</> : <TextPreview text={c.text} expanded={c.expanded} lines={8} /> };
}
function processRoute(c: ToolRenderContext, writing: boolean): ToolSemanticView {
	const d = record(c.details.proc);
	const path = string(c.args.path ?? c.args.file_path).replace(/^proc:\/\//i, "");
	const action = writing ? path.endsWith("/kill") ? "kill" : path.endsWith("/mode") ? "mode" : "stdin" : "read";
	const daemons = records(d.daemons).length ? records(d.daemons) : isRecord(d.daemon) ? [d.daemon] : [];
	return { title: "Process", family: writing ? "proc-write" : "proc-read", target: `${action} ${path}`,
		body: <><LimitedList items={daemons} expanded={c.expanded} render={daemon => <div className="omp-native-job-head"><span className="omp-native-badge">service</span><strong>{scalar(daemon.name)}</strong><span>{scalar(daemon.state)}</span>{daemon.ready === true && <span>ready</span>}{typeof daemon.startedAt === "number" && <span className="omp-empty-note">{fmtDuration(Math.max(0, (typeof daemon.exitedAt === "number" ? daemon.exitedAt : Date.now()) - daemon.startedAt))}</span>}{typeof daemon.error === "string" && daemon.error && <span className="omp-native-error">{daemon.error}</span>}</div>} /><JobRows details={d} expanded={c.expanded} />{writing && c.args.content !== undefined && <Section title={action === "mode" ? "Mode" : "Input"}><TextPreview text={string(c.args.content)} expanded={c.expanded} /></Section>}<TextPreview text={string(d.log) || strings(d.terminalRows).join("\n") || (daemons.length === 0 && d.jobs === undefined && d.job === undefined && d.agents === undefined ? c.text : "")} expanded={c.expanded} lines={10} tail /></> };
}
function read(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const path = string(c.args.path ?? c.args.file_path);
	if (d.proc !== undefined || /^proc:\/\//i.test(path)) return processRoute(c, false);
	if (d.cfg !== undefined || /^cfg:\/\//i.test(path)) return config(c, false);
	const display = record(d.displayContent);
	const url = d.kind === "url" || /^https?:\/\//i.test(path);
	const target = strings(d.displayReadTargets).length ? strings(d.displayReadTargets).join(", ") : path;
	return { title: "Read", family: url ? "read-url" : d.isDirectory === true ? "read-directory" : "read", target, meta: [d.conflictCount !== undefined ? `${scalar(d.conflictCount)} conflicts` : "", d.totalLines !== undefined ? `${scalar(d.totalLines)} lines` : "", d.fileSize !== undefined ? `${scalar(d.fileSize)} bytes` : "", d.suffixResolution ? "resolved suffix" : ""].filter(Boolean), tone: d.suffixResolution ? "warning" : undefined,
		body: <>{d.contentType === "text/markdown" && !/:raw(?:$|:)/i.test(path) && c.args.raw !== true ? <TextPreview text={string(display.text) || c.text} expanded={c.expanded} lines={12} prose /> : <CodePreview text={string(display.text) || c.text} expanded={c.expanded} lines={12} start={typeof display.startLine === "number" ? display.startLine : Number(/:(\d+)(?:[-+:]|$)/.exec(path)?.[1] ?? 1)} lineNumbers={display.lineNumbers} />}<OutputMetadata details={d} /></> };
}
function resolution(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const action = string(d.action || c.args.action) || (c.name === "reject" ? "discard" : "apply");
	return { title: c.name === "reject" ? "Reject" : "Resolve", family: "resolution", target: string(d.label || d.sourceToolName), meta: [c.hasResult ? action === "discard" ? "rejected" : c.isError ? "apply failed" : "resolved" : action].filter(Boolean), tone: c.isError ? "error" : action === "discard" ? "warning" : undefined,
		body: <TextPreview text={string(d.reason || c.args.reason) || c.text} expanded={c.expanded} lines={1} prose /> };
}
function retain(c: ToolRenderContext): ToolSemanticView {
	const items = records(c.args.items);
	return { title: "Retain", family: "retain", preview: 8, meta: c.details.count !== undefined ? [`${scalar(c.details.count)} retained`] : undefined, body: <><LimitedList items={items} expanded={c.expanded} render={value => <Markdown text={string(record(value).content)} />} /><TextPreview text={c.text} expanded={c.expanded} lines={1} prose /></> };
}
function recall(c: ToolRenderContext): ToolSemanticView {
	const match = /^Found (\d+) relevant/.exec(c.text);
	const count = match ? Number(match[1]) : null;
	return { title: "Recall", family: "recall", target: string(c.args.query), meta: count === null ? undefined : [count === 0 ? "no matches" : `${count} found`], tone: count === 0 ? "warning" : undefined,
		preview: 0,
		body: <TextPreview text={c.text} expanded={c.expanded} lines={0} prose /> };
}
function reflect(c: ToolRenderContext): ToolSemanticView {
	return { title: "Reflect", family: "reflect", preview: 3, target: string(c.args.query), body: <TextPreview text={c.text} expanded={c.expanded} lines={3} prose /> };
}

interface Finding {
	title: string; body: string; priority: number; confidence: number;
	file: string; start: number; end: number;
}
function finding(value: unknown): Finding | null {
	const d = record(value);
	const priority = typeof d.priority === "number" ? d.priority : typeof d.priority === "string" && /^P[0-3]$/.test(d.priority) ? Number(d.priority[1]) : -1;
	if (typeof d.title !== "string" || typeof d.body !== "string" || !Number.isInteger(priority) || priority < 0 || priority > 3 ||
		typeof d.confidence !== "number" || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1 ||
		typeof d.file_path !== "string" || !d.file_path || typeof d.line_start !== "number" || !Number.isFinite(d.line_start) ||
		typeof d.line_end !== "number" || !Number.isFinite(d.line_end)) return null;
	return { title: d.title, body: d.body, priority, confidence: d.confidence, file: d.file_path, start: d.line_start, end: d.line_end };
}
function TaskReview({ row }: { row: Record<string, unknown> }): ReactNode {
	const extracted = record(row.extractedToolData);
	const rawYields = extracted.yield;
	const yields = records(Array.isArray(rawYields) ? rawYields : isRecord(rawYields) ? [rawYields] : []);
	// Native reviewer yields append array sections and replace scalar sections; a terminal payload wins.
	let data = record(record(row.structuredOutput).data);
	const sections: Record<string, unknown> = {};
	let terminal: Record<string, unknown> | undefined;
	for (const item of yields) {
		if (item.status === "aborted") continue;
		const names = strings(item.type);
		if (names.length === 0 || names.includes("result")) { if (isRecord(item.data)) terminal = item.data; continue; }
		for (const name of names) {
			const value = names.length > 1 ? record(item.data)[name] : item.data;
			if (name === "findings") sections[name] = [...(Array.isArray(sections[name]) ? sections[name] : []), ...(Array.isArray(value) ? value : [value])];
			else sections[name] = value;
		}
	}
	if (Object.keys(data).length === 0) data = terminal ?? sections;
	const summary = isRecord(data.summary) ? data.summary : data;
	const verdict = summary.overall_correctness;
	const hasVerdict = (verdict === "correct" || verdict === "incorrect") && typeof summary.explanation === "string" && typeof summary.confidence === "number" && Number.isFinite(summary.confidence);
	const findings = (Array.isArray(data.findings) ? data.findings : []).map(finding).filter((item): item is Finding => item !== null);
	if (!hasVerdict && data.findings === undefined) return null;
	return <Section title="Review">
		{hasVerdict && <><strong className={verdict === "incorrect" ? "omp-native-error" : "omp-native-selected"}>Patch is {scalar(verdict)} · {Math.round(Number(summary.confidence) * 100)}% confidence</strong><TextPreview text={string(summary.explanation)} expanded prose /></>}
		<div className="omp-empty-note">{findings.length === 0 ? "Findings: none" : ["P0", "P1", "P2", "P3"].map((label, priority) => { const count = findings.filter(item => item.priority === priority).length; return count ? `${label}: ${count}` : ""; }).filter(Boolean).join(" · ")}</div>
		<LimitedList items={findings} expanded render={item => {
			return <div className="omp-native-finding"><strong className={item.priority === 0 ? "omp-native-error" : item.priority === 1 ? "omp-native-warning" : ""}>[P{item.priority}] {item.title.replace(/^\[P\d\]\s*/, "")}</strong><div className="omp-native-finding-location" title={`${item.file}:${item.start}-${item.end}`}>{item.file.split(/[\\/]/).at(-1)}:{item.start}{item.end !== item.start ? `–${item.end}` : ""} · {Math.round(item.confidence * 100)}% confidence</div><Markdown text={item.body} /></div>;
		}} />
	</Section>;
}
function TaskAgent({ row, context: c, depth = 0, ancestors = [] }: { row: Record<string, unknown>; context: ToolRenderContext; depth?: number; ancestors?: readonly object[] }): ReactNode {
	const [collapsed, setCollapsed] = useState(false);
	const open = c.expanded && !collapsed;
	const id = string(row.id);
	const live = id ? c.agents?.get(id) : undefined;
	const ownedLive = live && (!live.parentToolCallId || live.parentToolCallId === c.callId) ? live : undefined;
	const p = ownedLive?.progress ? { ...row, ...ownedLive.progress } : row;
	const activity = id ? c.agentActivity?.get(id) : undefined;
	const status = p.aborted === true ? "aborted" : p.exitCode !== undefined ? p.exitCode !== 0 ? "failed" : p.error ? "merge failed" : "completed" : scalar(p.status) || ownedLive?.status || "pending";
	if (!c.expanded) return <div className="omp-native-agent-head omp-native-agent-head--compact"><span className={`codicon codicon-${status === "running" ? AGENT_STATUS_ICON.running : status === "completed" ? "check" : status === "failed" || status === "merge failed" ? "error" : status === "aborted" ? "circle-slash" : "clock"}`} aria-hidden="true" /><strong>{id || scalar(p.name) || scalar(p.agent) || "Agent"}</strong><span>{scalar(p.agent)} · {status}</span></div>;
	const nested = [...records(record(p.extractedToolData).task), ...(isRecord(p.inflightTaskDetails) ? [p.inflightTaskDetails] : [])];
	const retry = record(p.retryState);
	const retryFailure = record(p.retryFailure);
	const structured = record(p.structuredOutput).data;
	return <div className={`omp-native-agent omp-native-agent--${status.replace(/ /g, "-")}`}>
		<button type="button" className="omp-native-agent-head" aria-expanded={open} onClick={() => setCollapsed(value => !value)}><span className={`codicon codicon-${open ? "chevron-down" : "chevron-right"}`} aria-hidden="true" /><strong>{id || scalar(p.name) || scalar(p.agent) || "Agent"}</strong> <span>{scalar(p.agent)} · {status}</span> <span className="omp-native-agent-description">{string(p.description || p.assignment || p.task).trim().split(/\r?\n/, 1)[0]?.slice(0, 120)}</span>{Boolean(p.resolvedModelIdentity || p.resolvedModel) && <span className="omp-chip">{scalar(p.resolvedModelIdentity || p.resolvedModel)}{p.resolvedThinkingLevel ? ` · ${scalar(p.resolvedThinkingLevel)}` : ""}</span>}{p.isolated === true && <span className="omp-chip">isolated</span>}{p.advisor === true && <span className="omp-chip">advisor</span>}{p.resolvedModelIsFallback === true && <span className="omp-chip">fallback</span>}</button>
		{open && <><AgentProgressView progress={p} activity={activity} live={ownedLive !== undefined && status === "running"} />
			{Object.keys(retry).length > 0 && <div className="omp-native-warning">Retry {scalar(retry.attempt)}/{scalar(retry.maxAttempts)} · {scalar(retry.errorMessage)}</div>}
			{Object.keys(retryFailure).length > 0 && <div className="omp-native-error">Auto-retry gave up after {scalar(retryFailure.attempt)} attempts: {scalar(retryFailure.errorMessage)}</div>}
			{p.error !== undefined && <div className="omp-native-error">{scalar(p.error)}</div>}{p.abortReason !== undefined && <div className="omp-native-warning">{scalar(p.abortReason)}</div>}{p.truncated === true && <div className="omp-native-warning">Output truncated</div>}
			<TaskReview row={p} /></>}
		{open && <div className="omp-native-agent-body"><Section title="Assignment"><Markdown text={string(p.assignment || p.task)} /></Section>{typeof p.resolvedModelRoute === "string" && <p className="omp-empty-note">{p.resolvedModelRoute}</p>}{structured !== undefined ? <Section title="Result"><JsonOutput value={structured} expanded={open} /></Section> : p.output !== undefined && <Section title="Result"><Markdown text={string(p.output)} /></Section>}{status !== "completed" && typeof p.stderr === "string" && p.stderr.trim() && <Section title="Standard error"><TextPreview text={p.stderr} expanded /></Section>}{status === "completed" && p.hasRootChanges !== false && typeof p.patchPath === "string" && <p className="omp-empty-note">Patch: {p.patchPath}</p>}{status === "completed" && typeof p.branchName === "string" && <p className="omp-empty-note">Branch: {p.branchName}</p>}<OutputMetadata details={record(p.outputMeta)} />
			{nested.map((details, index) => <Section key={index} title="Nested agents">{depth >= 8 ? <div className="omp-empty-note">Native nested progress limit reached.</div> : ancestors.includes(details) ? <div className="omp-empty-note">Nested progress already shown</div> : <TaskRows details={details} context={c} depth={depth + 1} ancestors={[...ancestors, details]} />}</Section>)}
			{id && c.renderChild && <Section title="Read-only child transcript">{c.renderChild(id)}</Section>}
		</div>}
	</div>;
}
function TaskRows({ details: d, context: c, depth = 0, ancestors = [] }: { details: Record<string, unknown>; context: ToolRenderContext; depth?: number; ancestors?: readonly object[] }): ReactNode {
	const results = records(d.results);
	const ids = new Set(results.map(row => string(row.id)).filter(Boolean));
	const progress = records(d.progress).filter(row => !ids.has(string(row.id)));
	const rows = [...results, ...progress].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
	return <>{rows.map((row, index) => <TaskAgent key={string(row.id) || index} row={row} context={c} depth={depth} ancestors={ancestors} />)}</>;
}
function task(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const results = records(d.results);
	const live = [...(c.agents?.values() ?? [])].filter(row => c.callId !== undefined && row.parentToolCallId === c.callId);
	const knownIds = new Set([...results, ...records(d.progress)].map(row => string(row.id)).filter(Boolean));
	const extra = live.filter(row => !knownIds.has(row.id)).map(row => ({ ...row, ...(row.progress ?? {}) }));
	const args = records(c.args.tasks).length ? records(c.args.tasks) : c.args.task !== undefined || c.args.agent !== undefined || c.args.name !== undefined ? [c.args] : [];
	const hasRows = results.length > 0 || records(d.progress).length > 0 || extra.length > 0;
	const rows = hasRows ? { ...d, progress: [...records(d.progress), ...extra] } : { results: [], progress: args };
	const counts = { succeeded: results.filter(row => row.exitCode === 0 && !row.error && row.aborted !== true).length, failed: results.filter(row => row.aborted !== true && (typeof row.exitCode === "number" && row.exitCode !== 0 || Boolean(row.error))).length, aborted: results.filter(row => row.aborted === true).length };
	return { title: "Task", family: "task", preview: "none", target: `${results.length + records(rows.progress).length} agents`, meta: [counts.succeeded ? `${counts.succeeded} succeeded` : "", counts.failed ? `${counts.failed} failed` : "", counts.aborted ? `${counts.aborted} aborted` : "", d.async !== undefined ? "background" : ""].filter(Boolean), tone: counts.failed > 0 || counts.aborted > 0 ? "error" : undefined,
		body: <>{c.expanded && c.args.context !== undefined && <TextPreview text={string(c.args.context)} expanded prose />}<TaskRows details={rows} context={c} />{c.expanded && !hasRows && c.hasResult && d.async === undefined && <TextPreview text={c.text} expanded prose />}{c.expanded && d.async === undefined && typeof d.totalDurationMs === "number" && d.totalDurationMs > 0 && <span className="omp-empty-note">{fmtDuration(d.totalDurationMs)}</span>}</> };
}
function think(c: ToolRenderContext): ToolSemanticView {
	return { title: "Think", family: "think", body: <TextPreview text={string(c.args.thoughts)} expanded={c.expanded} prose /> };
}
function todo(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const phases = parseTodoPhases(d.phases);
	const ops = records(c.args.ops).length ? records(c.args.ops) : [c.args];
	const descriptions = [...(c.agents?.values() ?? [])].map(agent => agent.description || agent.assignment || "").filter(Boolean);
	const all = phases?.flatMap(phase => phase.tasks) ?? [];
	const selected = c.expanded ? null : selectCollapsedTodos(all, descriptions);
	const selectedSet = new Set(selected?.items ?? all);
	return { title: "Todo", family: "todo", target: ops.map(op => [scalar(op.op || d.op), scalar(op.task), scalar(op.phase), Array.isArray(op.items) ? `${op.items.length} items` : ""].filter(Boolean).join(" ")).filter(Boolean).join(", "), meta: phases ? [`${all.filter(isClosedTodo).length}/${all.length} closed`, `${phases.length} phases`] : undefined,
		preview: "none",
		body: <>{phases ? phases.map((phase, index) => {
			const tasks = c.expanded ? phase.tasks : phase.tasks.filter(item => selectedSet.has(item));
			return tasks.length > 0 || c.expanded ? <Section key={index} title={phase.name}><ul className="omp-native-checklist">{tasks.map((item, i) => <li key={i} className={`omp-native-todo--${item.status}`}><span className={`codicon codicon-${item.status === "completed" ? "check" : item.status === "abandoned" ? "circle-slash" : item.status === "blocked" ? "warning" : item.status === "in_progress" || item.status === "pending" && todoMatchesDescriptions(item.content, descriptions) ? AGENT_STATUS_ICON.running : "circle-outline"}`} aria-hidden="true" /> <span>{item.content}</span> <span className="omp-chip">{item.status}</span>{item.blocker && <div className="omp-native-warning">Waiting for: {item.blocker}</div>}{c.expanded && <>{item.details && <Markdown text={item.details} />}{item.notes?.map((note, j) => <Markdown key={j} text={note} />)}</>}</li>)}</ul></Section> : null;
		}) : <TextPreview text={c.text} expanded={c.expanded} />}{selected && selected.hidden > 0 && <div className="omp-empty-note">{selected.hidden} more {selected.hiddenActive ? "active " : ""}tasks</div>}</> };
}
function goal(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const g = record(d.goal);
	const left = typeof g.tokenBudget === "number" && typeof g.tokensUsed === "number" ? Math.max(0, g.tokenBudget - g.tokensUsed) : d.remainingTokens;
	return { title: "Goal", family: "goal", target: scalar(d.op || c.args.op), meta: [scalar(g.status)].filter(Boolean), tone: c.hasResult && !d.goal ? "warning" : undefined,
		body: <>{c.hasResult && !d.goal ? <div className="omp-empty-note">No active goal</div> : <><Markdown text={string(g.objective || c.args.objective)} /><p className="omp-empty-note">{typeof g.tokensUsed === "number" ? `${fmtTokens(g.tokensUsed)}${typeof g.tokenBudget === "number" ? ` / ${fmtTokens(g.tokenBudget)} tokens (${typeof left === "number" ? fmtTokens(left) : scalar(left)} left)` : " tokens"}` : ""}{typeof g.timeUsedSeconds === "number" && g.timeUsedSeconds > 0 ? ` · ${fmtDuration(g.timeUsedSeconds * 1000)} elapsed` : ""}</p></>}{d.completionBudgetReport !== undefined && <Section title="Report"><Markdown text={string(d.completionBudgetReport)} /></Section>}</> };
}
function webSearch(c: ToolRenderContext): ToolSemanticView {
	const response = record(c.details.response);
	const sources = records(response.sources);
	return { title: "Web search", family: "web-search", target: string(c.args.query) || strings(response.searchQueries)[0], meta: [scalar(response.provider), response.sources !== undefined ? `${sources.length} sources` : "", scalar(response.model)].filter(Boolean), tone: c.details.error ? "error" : response.sources !== undefined && sources.length === 0 ? "warning" : undefined,
		body: <>{c.details.error ? <TextPreview text={string(c.details.error)} expanded={c.expanded} /> : <><Section title="Answer"><TextPreview text={string(response.answer) || c.text} expanded={c.expanded} prose /></Section><Section title="Sources"><LimitedList items={sources} expanded={c.expanded} render={value => {
			const source = record(value);
			const url = string(source.url);
			let domain = ""; try { domain = new URL(url).hostname; } catch { /* Invalid URLs stay visible as text. */ }
			return <><Link href={url}>{scalar(source.title) || url}</Link><div className="omp-empty-note">{[domain, scalar(source.publishedDate), source.ageSeconds !== undefined ? `${scalar(source.ageSeconds)}s old` : "", scalar(source.author)].filter(Boolean).join(" · ")}</div><TextPreview text={string(source.snippet)} expanded={c.expanded} lines={2} prose />{c.expanded && <div className="omp-native-path">{url}</div>}</>;
		}} /></Section></>}</> };
}
function github(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const watch = record(d.watch);
	const runs = records(watch.runs).length ? records(watch.runs) : isRecord(watch.run) ? [watch.run] : [];
	return { title: watch.mode ? "GitHub Run Watch" : "GitHub", family: "github", target: [scalar(c.args.op), scalar(watch.repo || c.args.repo), scalar(c.args.pr || c.args.run || c.args.branch || c.args.query)].filter(Boolean).join(" · "), meta: [scalar(watch.state), scalar(d.status), scalar(d.conclusion)].filter(Boolean),
		body: <>{watch.mode ? <>{watch.note !== undefined && <div className="omp-empty-note">{scalar(watch.note)}</div>}{runs.length === 0 && <div className="omp-empty-note">Waiting for workflow runs…</div>}<LimitedList items={runs} expanded={c.expanded} render={value => {
			const run = record(value); const jobs = records(run.jobs);
			return <Section title={`${scalar(run.workflowName || run.displayTitle)} · #${scalar(run.id)}`}><Link href={run.url}>{scalar(run.status)} {scalar(run.conclusion)}</Link><div className="omp-empty-note">{string(run.branch) || string(run.headSha).slice(0, 7)}</div>{jobs.length === 0 ? <div className="omp-empty-note">Waiting for workflow jobs…</div> : <LimitedList items={jobs} expanded={c.expanded} render={job => {
				const data = record(job);
				return <><Link href={data.url}>{scalar(data.name)}</Link> · {scalar(data.conclusion || data.status)}{typeof data.durationSeconds === "number" && <span className="omp-empty-note">{fmtDuration(data.durationSeconds * 1000)}</span>}</>;
			}} />}</Section>;
		}} /><Section title="Failed logs"><LimitedList items={records(watch.failedLogs)} expanded={c.expanded} render={value => <Section title={`${scalar(record(value).jobName)} · #${scalar(record(value).runId)}`}>{record(value).available === false ? <div className="omp-empty-note">Log tail unavailable</div> : <TextPreview text={string(record(value).tail)} expanded={c.expanded} tail />}</Section>} /></Section></> : <TextPreview text={c.text} expanded={c.expanded} lines={24} prose />}<OutputMetadata details={d} /></> };
}
function vibe(c: ToolRenderContext): ToolSemanticView {
	const op = c.name.slice("vibe_".length);
	const d = c.details;
	const wait = record(d.wait);
	const ack = op === "spawn" ? record(d.spawned) : op === "send" ? record(d.send) : op === "kill" ? record(d.killed) : {};
	return { title: "Vibe", family: `vibe-${op}`, target: [op, scalar(ack.id || c.args.session || c.args.name), scalar(ack.cli || c.args.cli)].filter(Boolean).join(" · "), meta: [scalar(ack.mode), wait.timedOut === true ? "timed out" : "", wait.waiting === true ? "watching" : "", strings(d.hiddenKilled).length ? `${strings(d.hiddenKilled).length} killed hidden` : ""].filter(Boolean), tone: wait.timedOut === true || ack.mode === "queued" ? "warning" : undefined,
		preview: op === "spawn" || op === "send" ? 3 : 10,
		body: <>{(op === "spawn" || op === "send") && <><TextPreview text={string(c.args.prompt || c.args.message)} expanded={c.expanded} lines={2} prose />{ack.mode === "steered" ? <div className="omp-empty-note">Steered into the running turn</div> : ack.mode === "queued" ? <div className="omp-native-warning">Mid-turn — queued as the next turn</div> : c.hasResult && <div className="omp-empty-note">Turn started</div>}</>}{op === "kill" && ack.cancelledTurn === true && <div className="omp-empty-note">In-flight turn cancelled</div>}<LimitedList items={records(d.screens)} expanded={c.expanded} render={screen => <Section title={[scalar(screen.id), scalar(screen.cli), scalar(screen.state), scalar(screen.model)].filter(Boolean).join(" · ")}><div className="omp-empty-note">{typeof screen.turns === "number" ? `${screen.turns} turns` : ""}{typeof screen.queued === "number" && screen.queued > 0 ? ` · ${screen.queued} queued` : ""}</div><TextPreview text={string(screen.turnMessage)} expanded={c.expanded} lines={1} prose /><div className="omp-native-job-label">{[string(screen.currentTool), string(screen.lastIntent)].filter(Boolean).join(" · ")}</div><TextPreview text={strings(screen.trace).slice(-(c.expanded ? 6 : 2)).join("\n")} expanded /><TextPreview text={strings(screen.outputTail).slice(-(c.expanded ? 3 : 1)).join("\n")} expanded tail /></Section>} />{wait.waiting === true && <div className="omp-empty-note">Watching the wall</div>}{Array.isArray(wait.settled) && wait.settled.length > 0 && <div className="omp-empty-note">{wait.settled.length} settled</div>}{d.screens === undefined && op !== "spawn" && op !== "send" && op !== "kill" && <TextPreview text={c.text} expanded={c.expanded} />}</> };
}
function agentWrite(c: ToolRenderContext): ToolSemanticView {
	const d = record(c.details.message);
	const receipts = records(d.receipts);
	return { title: "IRC", family: "agent-write", target: `→ ${scalar(d.to) || string(c.args.path).replace(/^agent:\/\//i, "")}`, meta: receipts.length ? [`${receipts.filter(receipt => receipt.outcome !== "failed").length} delivered`, `${receipts.filter(receipt => receipt.outcome === "failed").length} failed`] : undefined,
		body: <><TextPreview text={string(c.args.content)} expanded={c.expanded} prose /><LimitedList items={receipts} expanded={c.expanded} render={receipt => <div className="omp-native-job-head"><strong>{scalar(receipt.to)}</strong><span>{scalar(receipt.outcome)}</span>{typeof receipt.error === "string" && receipt.error && <span className="omp-native-error">{receipt.error}</span>}</div>} />{receipts.length === 0 && c.hasResult && <TextPreview text={c.text} expanded={c.expanded} />}</> };
}
function write(c: ToolRenderContext): ToolSemanticView {
	const d = c.details;
	const path = string(c.args.path ?? c.args.file_path);
	const route = resolveToolRoute(c.name, c.args, d);
	if (route.kind === "agent") return agentWrite(c);
	if (route.kind === "process") return processRoute(c, true);
	if (route.kind === "config") return config(c, true);
	if (route.kind === "help") return { title: route.name, family: "xd-help", target: "Help", body: <TextPreview text={c.text} expanded={c.expanded} lines={8} /> };
	if (route.kind === "device") {
		const renderer = Object.hasOwn(nativeToolRenderers, route.name) ? nativeToolRenderers[route.name] : undefined;
		// Device writes are resolved once; never recursively route or execute callbacks.
		const inner = { ...c, name: route.name, args: presentArgs(route.args), details: route.details };
		if (renderer && route.name !== "write") return { ...renderer(inner), icon: TOOL_ICONS[route.name] ?? "tools" };
		return { ...unknown(inner), icon: "tools" };
	}
	const content = typeof c.args.content === "string" ? c.args.content : scalar(c.args.content);
	return { title: "Write", family: "write", target: path, meta: [content ? `${content.split("\n").length} lines` : "", d.madeExecutable === true ? "executable" : ""].filter(Boolean),
		preview: 8,
		body: <>{c.partial && <TextPreview text={c.text} expanded={c.expanded} />}<CodePreview text={content} expanded={c.expanded} lines={6} tail={!c.hasResult} /><Diagnostics value={d.diagnostics} expanded={c.expanded} /><OutputMetadata details={d} /></> };
}
function unknown(c: ToolRenderContext): ToolSemanticView {
	const args = Object.fromEntries(Object.entries(c.args).filter(([key, value]) => value != null && key !== "i" && key !== "__partialJson"));
	const target = Object.entries(args).map(([key, value]) => `${key}=${typeof value === "object" ? Array.isArray(value) ? `[${value.length} items]` : "{…}" : typeof value === "string" ? JSON.stringify(value.slice(0, 60)) : scalar(value)}`).join(", ").slice(0, 160);
	const output = c.text.trimEnd().slice(0, 65536);
	let parsed: unknown;
	let json = false;
	if (output.startsWith("{") || output.startsWith("[")) {
		try { parsed = JSON.parse(output); json = true; } catch { /* Actual non-JSON output stays text. */ }
	}
	const outputLines = json ? [] : output.split("\n");
	const limit = c.expanded ? 12 : 4;
	return { title: c.name, family: "unknown", target: c.expanded ? undefined : target, body: <>{c.expanded && Object.keys(args).length > 0 && <Section title="Args"><JsonOutput value={args} expanded omitAbsent /></Section>}{c.hasResult && !output ? <div className="omp-empty-note">(no output)</div> : json ? <JsonOutput value={parsed} expanded={c.expanded} /> : <TextPreview text={outputLines.slice(0, limit).join("\n")} expanded />}{outputLines.length > limit && <div className="omp-empty-note">…</div>}</> };
}

/** Icon name per native tool; every name here also has a renderer in `nativeToolRenderers`. */
export const TOOL_ICONS: Readonly<Record<string, string>> = {
	ask: "question", ast_grep: "search", ast_edit: "replace", bash: "terminal", debug: "debug-alt",
	edit: "diff", apply_patch: "diff", eval: "code", find: "search", glob: "files", grep: "search",
	github: "github", goal: "target", lsp: "symbol-method", wait: "watch", read: "file",
	resolve: "check", reject: "circle-slash", retain: "bookmark", recall: "history", reflect: "lightbulb",
	task: "organization", think: "lightbulb", todo: "checklist", web_search: "globe",
	vibe_spawn: "run", vibe_send: "send", vibe_wait: "watch", vibe_kill: "debug-stop", vibe_list: "list-tree", write: "edit",
};
export const nativeToolRenderers: Record<string, ToolRenderer> = {
	ask, ast_grep: astGrep, ast_edit: astEdit, bash, debug, edit, apply_patch: edit, eval: evaluate,
	find, github, glob, grep, lsp, wait, read, resolve: resolution, reject: resolution,
	retain, recall, reflect, task, think, todo, goal, web_search: webSearch,
	vibe_spawn: vibe, vibe_send: vibe, vibe_wait: vibe, vibe_kill: vibe, vibe_list: vibe, write,
};
export function describeTool(context: ToolRenderContext): ToolSemanticView {
	const renderer = Object.hasOwn(nativeToolRenderers, context.name) ? nativeToolRenderers[context.name]! : unknown;
	const args = presentArgs(context.args);
	const view = renderer(args === context.args ? context : { ...context, args });
	return { ...view, icon: view.icon ?? (Object.hasOwn(TOOL_ICONS, context.name) ? TOOL_ICONS[context.name] : "tools") };
}
