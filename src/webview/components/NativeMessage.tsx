import { useId } from "react";
import type { ChatEntry, ChatMessage, CustomMessage, ExecutionMessage, SummaryMessage } from "../../chat/messages.ts";
import { advisorNotes, entryMessage, userSkill, type AdvisorNote } from "../../chat/messages.ts";
import { isRecord } from "../../guards.ts";
import { TODO_STATUS_WORD } from "../../chat/hud-summary.ts";
import { fmtDuration, fmtTokens } from "../lib/format.ts";
import { Markdown } from "./Markdown.tsx";
import { AssistantContentView, MessageContentView, NativeDisclosure } from "./MessageContent.tsx";
import { lateDiagnosticsFiles, nativeText, numberField, recordRows, stringField } from "./native-message-helpers.ts";

export interface IrcDisclosure { expanded: boolean; onChange(expanded: boolean): void }
export interface NativeMessageProps {
	entry: ChatEntry;
	model?: { id: string; name?: string; provider?: string } | null;
	superseded?: boolean;
	/** Controlled disclosure for an IRC row, so it survives its virtualized DOM being unmounted. */
	irc?: IrcDisclosure;
}

const COMPACTION_LABELS: Record<string, string> = {
	remote: "Remote-compacted", soft: "Soft-compacted", handoff: "Handed off", snapcompact: "Snap-compacted", shake: "Shaken",
};
/** The TUI's names for a maintenance pass, by `auto_compaction_*` action. */
const MAINTENANCE_LABELS: Record<string, string> = {
	"context-full": "Context-full maintenance", compact: "Compaction", handoff: "Handoff", remote: "Server compaction", shake: "Shake", snapcompact: "Snapcompact",
};
const IRC_KINDS: Record<string, string> = {
	"irc:incoming": "incoming", "irc:autoreply": "auto-reply", "irc:relay": "relay", "irc:workpool": "work pool",
};

/** One flat, collapsed-by-default row shaped like a tool row, so relayed agent chatter never reads as assistant prose. */
function IrcRow({ message, disclosure }: { message: CustomMessage; disclosure?: IrcDisclosure }) {
	const details = message.details;
	const bodyId = useId();
	const expanded = disclosure?.expanded ?? false;
	const body = (stringField(details, message.customType === "irc:incoming" ? "message" : "body") ?? nativeText(message.content)).trim();
	const route = `${stringField(details, "from") ?? "?"} → ${stringField(details, "to") ?? "?"}`;
	const kind = IRC_KINDS[message.customType] ?? "message";
	const preview = body.replace(/\s+/g, " ");
	const meta = (["pool", "mode", "replyTo"] as const).flatMap(field => { const value = stringField(details, field); return value ? [[field === "replyTo" ? "Reply to" : field === "pool" ? "Pool" : "Mode", value] as const] : []; });
	return <div className={`omp-tool omp-native-tool omp-native-irc ${message.customType.replace(":", "-")}`} data-irc-kind={kind}>
		<button type="button" className="omp-tool-head" aria-expanded={expanded} aria-controls={bodyId} title={`IRC ${kind} · ${route}`} onClick={() => disclosure?.onChange(!expanded)}>
			<span className={`codicon codicon-${expanded ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
			<span className="codicon codicon-comment-discussion" aria-hidden="true" />
			<span className="omp-tool-name">IRC</span>
			<span className="omp-irc-route">{route}</span>
			<span className="omp-irc-kind">{kind}</span>
			{preview && <span className="omp-irc-preview">{preview}</span>}
		</button>
		{expanded && <div id={bodyId} className="omp-tool-body" role="region" aria-label={`IRC ${kind} body`}>
			{meta.map(([label, value]) => <p key={label} className="omp-native-muted">{label}: <code>{value}</code></p>)}
			<Markdown text={body} />
		</div>}
	</div>;
}



function CustomMessageView({ message, irc }: { message: CustomMessage; irc?: IrcDisclosure }) {
	if (!message.display) return null;
	const details = message.details;
	if (message.customType.startsWith("native:")) {
		const kind = message.customType.slice(7);
		const data = isRecord(details) ? details : {};
		switch (kind) {
			case "command_output": return <section className="omp-native-message"><header><strong>Command output</strong></header><pre className="omp-command-output">{stringField(data, "text") ?? ""}</pre></section>;
			case "ttsr_triggered": {
				const rules = recordRows(data, "rules");
				return <section className="omp-native-message omp-warning"><header><strong>TTSR triggered</strong> · {rules.length} rules</header><ul>{rules.map((rule, index) => <li key={index}><strong>{stringField(rule, "name") ?? stringField(rule, "id") ?? "Rule"}</strong>{stringField(rule, "description") && <p>{stringField(rule, "description")}</p>}</li>)}</ul></section>;
			}
			case "notice": return <section className={`omp-native-message omp-${data.level ?? "info"}`}><header><strong>{stringField(data, "source") ?? "Notice"}</strong></header><Markdown text={stringField(data, "message") ?? ""} /></section>;
			case "retry": return <section className={`omp-native-event ${data.status === "failed" ? "omp-error" : "omp-native-muted"}`}><strong>Retry {numberField(data, "attempt")}/{numberField(data, "maxAttempts")} · {data.status === "waiting" ? `waiting ${fmtDuration(numberField(data, "delayMs") ?? 0)}` : stringField(data, "status")}</strong>{stringField(data, "errorMessage") && <NativeDisclosure title="Retry reason"><Markdown text={stringField(data, "errorMessage")!} /></NativeDisclosure>}</section>;
			case "goal_updated": {
				const goal = isRecord(data.goal) ? data.goal : null;
				return <section className="omp-native-event"><strong>{goal === null ? "Goal cleared" : <>Goal updated · {stringField(goal, "objective") ?? "objective unavailable"} · {stringField(goal, "status") ?? "status unavailable"}</>}</strong>
					{goal && <NativeDisclosure title="Goal budget">{["tokenBudget", "tokensUsed", "timeBudgetSeconds", "timeUsedSeconds"].map(key => {
						const value = numberField(goal, key);
						return value === undefined ? null : <p key={key}>{key}: {key === "tokenBudget" || key === "tokensUsed" ? fmtTokens(value) : fmtDuration(value * 1000)}</p>;
					})}</NativeDisclosure>}
				</section>;
			}
			case "retry_failed": return <section className="omp-native-message omp-error"><strong>Retry failed after {numberField(data, "attempt") ?? 0}</strong><p>{stringField(data, "errorMessage")}</p></section>;
			case "maintenance": {
				// As the TUI: a completed pass shows as the compaction divider, a skipped one as nothing; only a
				// cancelled or failed pass leaves a short line.
				const status = stringField(data, "status");
				const error = stringField(data, "errorMessage");
				const action = MAINTENANCE_LABELS[stringField(data, "action") ?? ""] ?? "Maintenance";
				if (status === "cancelled") return <div className="omp-native-muted">{action} cancelled</div>;
				if (!error) return null;
				return <div className="omp-native-muted omp-warning">{action} failed: {error}{data.willRetry === true ? " · will retry" : ""}</div>;
			}
			case "retry_fallback_applied": return <section className="omp-native-event omp-warning"><strong>Fallback applied · {stringField(data, "role")} · {stringField(data, "from")} → {stringField(data, "to")}</strong>{stringField(data, "reason") && <NativeDisclosure title="Fallback reason"><Markdown text={stringField(data, "reason")!} /></NativeDisclosure>}</section>;
			case "retry_fallback_succeeded": return <section className="omp-native-message omp-success"><strong>Fallback succeeded · {stringField(data, "model")}</strong><p>{stringField(data, "role")}</p></section>;
			case "todo_reminder": return <section className="omp-native-message omp-native-muted"><strong>TODO reminder · {numberField(data, "attempt")}/{numberField(data, "maxAttempts")}</strong><ul>{recordRows(data, "todos").map((todo, index) => {
				const status = stringField(todo, "status");
				const label = status !== undefined && Object.hasOwn(TODO_STATUS_WORD, status) ? TODO_STATUS_WORD[status as keyof typeof TODO_STATUS_WORD] : "status unavailable";
				return <li key={index}>{stringField(todo, "content")} · {label}{stringField(todo, "blocker") && <p>Blocker: {stringField(todo, "blocker")}</p>}</li>;
			})}</ul></section>;
		}
	}
	switch (message.customType) {
		case "background-tan-dispatch": {
			const jobId = stringField(details, "jobId");
			const work = stringField(details, "work");
			const singleLine = work?.replace(/\s+/g, " ").trim();
			const preview = singleLine && singleLine.length > 56 ? `${singleLine.slice(0, 55)}…` : singleLine;
			return <section className="omp-native-message omp-native-tangent">
				<header><span className="codicon codicon-output" aria-hidden="true" /> <strong>Tangent dispatched</strong> <span className="omp-native-badge">task</span> <code>{jobId ?? "unknown"}</code>{preview ? <span> · {preview}</span> : null}</header>
			</section>;
		}
		case "async-result": {
			const jobs = recordRows(details, "jobs");
			const rows = jobs.length ? jobs : [isRecord(details) ? details : {}];
			return <section className="omp-native-message omp-native-async-result">
				{rows.map((job, index) => <div className="omp-native-status" key={index}>
					<span className="codicon codicon-check" aria-hidden="true" /> <strong>Background job completed</strong> <span className="omp-native-badge">{stringField(job, "type") ?? "job"}</span> <code>{stringField(job, "jobId") ?? "unknown"}</code>{stringField(job, "label") ? <span> · {stringField(job, "label")}</span> : null}
					<ArtifactWarning meta={job.meta} />
				</div>)}
				{isRecord(details) ? <ArtifactWarning meta={details.meta} /> : null}
			</section>;
		}
		case "lsp-late-diagnostic": {
			const files = lateDiagnosticsFiles(details);
			const errored = files.some(file => file.errored);
			const count = files.reduce((sum, file) => sum + (file.messages?.length ?? 0), 0);
			let remaining = 5;
			return <section className={`omp-native-message omp-native-diagnostics ${errored ? "omp-error" : "omp-warning"}`}>
				<header><strong>Late diagnostics</strong> <span className="omp-native-badge">{count} diagnostic{count === 1 ? "" : "s"}</span></header>
				{files.map((file, index) => {
					const shown = file.messages?.slice(0, remaining) ?? [];
					remaining -= shown.length;
					return <div key={index}><strong>{file.path ?? "Unspecified file"}</strong>{file.summary ? <p>{file.summary}</p> : null}{shown.map((text, line) => <pre key={line}>{text}</pre>)}</div>;
				})}
				{count > 5 ? <p className="omp-native-muted">{count - 5} more diagnostics in full details</p> : null}
				<NativeDisclosure title="All diagnostics">{files.map((file, index) => <section key={index}><strong>{file.path ?? "Unspecified file"}</strong>{file.summary ? <p>{file.summary}</p> : null}{file.messages?.map((text, line) => <pre key={line}>{text}</pre>)}</section>)}</NativeDisclosure>
			</section>;
		}
		case "collab-prompt":
			return <section className="omp-native-message omp-user omp-native-collab"><header><strong>«{stringField(details, "from")?.trim() || "guest"}»</strong></header><MessageContentView content={message.content} /></section>;
		case "skill-prompt": {
			const invocation = userSkill(message);
			if (invocation) return <section className="omp-native-message omp-native-skill omp-user">
				<header><span className="codicon codicon-book" aria-hidden="true" /><Markdown text={invocation.prompt} />{invocation.reconstructed && <span className="omp-native-badge">reconstructed</span>}</header>
				<NativeDisclosure title="Expanded skill"><MessageContentView content={message.content} /></NativeDisclosure>
			</section>;
			const name = stringField(details, "name");
			return <section className="omp-native-message omp-native-skill"><header><span className="codicon codicon-book" aria-hidden="true" /> <strong>Skill · {name ?? "Unknown skill"}</strong></header>
				{stringField(details, "path") ? <p><code>{stringField(details, "path")}</code></p> : null}
				{stringField(details, "args") ? <p>Arguments: <code>{stringField(details, "args")}</code></p> : null}
				{numberField(details, "lineCount") !== undefined ? <p>{numberField(details, "lineCount")} lines</p> : null}
				{stringField(details, "prompt") ? <Markdown text={stringField(details, "prompt")!} /> : null}
			</section>;
		}
		case "irc:incoming": case "irc:autoreply": case "irc:relay": case "irc:workpool":
			return <IrcRow message={message} disclosure={irc} />;
		case "advisor": {
			const notes = advisorNotes(message);
			const blockers = notes.filter(note => note.severity === "blocker").length;
			const renderNotes = (rows: readonly AdvisorNote[]) => rows.map((note, index) => <blockquote key={index} className={note.severity === "blocker" ? "omp-error" : note.severity === "concern" ? "omp-warning" : "omp-native-muted"}>
				<strong className="omp-native-badge">{note.severity === "unknown" ? "severity unknown" : note.severity}</strong>
				{note.advisor && <span> [{note.advisor}]</span>}<Markdown text={note.note} />
			</blockquote>);
			const preview = [...notes.filter(note => note.severity === "blocker"), ...notes.filter(note => note.severity !== "blocker")].slice(0, 3);
			return <section className={`omp-native-message omp-native-advisor ${blockers ? "omp-error" : ""}`}>
				<header><strong>Advisor</strong>{notes.length > 0 && <> · {notes.length} notes{blockers > 0 && <span> · {blockers} blocker{blockers === 1 ? "" : "s"}</span>}</>}</header>
				{notes.length > 0 ? renderNotes(preview) : <MessageContentView content={message.content} />}
				{notes.length > 3 && <NativeDisclosure title={`All ${notes.length} advisor notes`}>{renderNotes(notes)}</NativeDisclosure>}
			</section>;
		}
		case "launch-completion": {
			const daemons = recordRows(details, "daemons");
			return <section className="omp-native-message omp-native-launch">
				{daemons.length ? daemons.map((daemon, index) => {
					const exit = numberField(daemon, "exitCode");
					const failed = daemon.state === "failed" || (exit !== undefined && exit !== 0);
					return <div key={index} className={failed ? "omp-error" : "omp-success"}><strong>Supervised process {failed ? "failed" : "completed"}</strong> · {stringField(daemon, "name") ?? "Unnamed process"}{exit !== undefined ? <span> · exit {exit}</span> : null}</div>;
				}) : <><header><strong>Supervised process completion</strong></header><MessageContentView content={message.content} /></>}
			</section>;
		}
		case "handoff": {
			const text = nativeText(message.content);
			const start = text.indexOf("<handoff-context>");
			const end = start === -1 ? -1 : text.indexOf("</handoff-context>", start + 17);
			const document = start === -1 ? text.trim() : text.slice(start + 17, end === -1 ? undefined : end).trim();
			return <section className="omp-native-summary omp-native-handoff"><NativeDisclosure title="Handed off"><Markdown text={document} /></NativeDisclosure></section>;
		}
		default:
			return <section className="omp-native-message omp-native-custom"><header><strong>{message.customType}</strong></header><Markdown text={nativeText(message.content)} /></section>;
	}
}

function ArtifactWarning({ meta }: { meta: unknown }) {
	const error = isRecord(meta) ? meta.artifactError : undefined;
	if (error !== "open" && error !== "write" && error !== "flush" && error !== "end") return null;
	return <p className="omp-warning">Full output was not saved completely (artifact {error} failed)</p>;
}

function ExecutionView({ message }: { message: ExecutionMessage }) {
	const lines = message.output.split(/\r?\n/);
	const failed = !message.cancelled && message.exitCode !== undefined && message.exitCode !== 0;
	return <section className={`omp-native-message omp-native-execution ${failed ? "omp-error" : message.cancelled ? "omp-warning" : ""}`}>
		<header><strong>{message.role === "bashExecution" ? "Bash execution" : "Python execution"}</strong> · {message.cancelled ? "cancelled" : failed ? "failed" : "complete"}{message.exitCode !== undefined ? <span> · exit {message.exitCode}</span> : null}{message.excludeFromContext ? <span className="omp-native-badge">Excluded from model context</span> : null}{message.truncated ? <span className="omp-native-badge">Output truncated</span> : null}</header>
		<pre className="omp-native-code">{message.role === "bashExecution" ? message.command : message.code}</pre>
		<pre className="omp-native-output">{lines.slice(-10).join("\n")}</pre>
		{lines.length > 10 ? <NativeDisclosure title={`Full output (${lines.length} lines)`}><pre className="omp-native-output">{message.output}</pre></NativeDisclosure> : null}
		{message.images?.length ? <MessageContentView content={message.images} /> : null}
		<ArtifactWarning meta={message.meta} />
	</section>;
}

/** Reconstruct persisted archive presentation without importing the native rasterizer. */
function SnapcompactArchiveView({ preserveData }: { preserveData: unknown }) {
	const archive = isRecord(preserveData) && isRecord(preserveData.snapcompact) ? preserveData.snapcompact : null;
	if (!archive) return null;
	const frames = recordRows(archive, "frames");
	const head = stringField(archive, "textHead");
	const tail = stringField(archive, "textTail");
	const source = stringField(archive, "text");
	const truncated = numberField(archive, "truncatedChars");
	return <section className="omp-native-archive">
		<h4>Snapcompact archive · {frames.length} frames</h4>
		{head ? <pre>{head.replace(/[\u000e\u000f]/g, "").replaceAll("\u2588", "\n")}</pre> : null}
		{frames.map((frame, index) => typeof frame.data === "string" && typeof frame.mimeType === "string"
			? <MessageContentView key={index} content={[{ type: "image", data: frame.data, mimeType: frame.mimeType }]} />
			: null)}
		{tail ? <pre>{tail.replace(/[\u000e\u000f]/g, "").replaceAll("\u2588", "\n")}</pre> : null}
		{truncated ? <p className="omp-warning">{truncated.toLocaleString()} archive characters were dropped by native compaction.</p> : null}
		{source ? <NativeDisclosure title="Full retained archive source"><pre>{source.replace(/[\u000e\u000f]/g, "").replaceAll("\u2588", "\n")}</pre></NativeDisclosure> : null}
	</section>;
}

function SummaryView({ summary, superseded = false }: { summary: SummaryMessage | Extract<ChatEntry, { type: "compaction" | "branch_summary" }>; superseded?: boolean }) {
	const compaction = "role" in summary ? summary.role === "compactionSummary" : summary.type === "compaction";
	const method = "method" in summary ? summary.method : undefined;
	const before = "tokensBefore" in summary ? summary.tokensBefore : undefined;
	const after = "tokensAfter" in summary ? summary.tokensAfter : undefined;
	const warning = "warning" in summary ? summary.warning : undefined;
	const blocks = "blocks" in summary ? summary.blocks : undefined;
	const images = "images" in summary ? summary.images : undefined;
	const label = compaction ? (method && COMPACTION_LABELS[method]) || "Compacted" : "Branch summarized";
	// As the TUI: a rule across the transcript that cuts off the summarized history, the label and amount in the middle.
	const amount = before !== undefined && before > 0 && after !== undefined ? <span className="omp-native-summary-amount"> · {fmtTokens(before)} → {fmtTokens(after)} tokens</span> : null;
	return <section className="omp-native-summary omp-native-summary--divider">
		<NativeDisclosure title={<span className="omp-native-summary-label">{label}{amount}{superseded ? " · superseded in full history" : ""}{warning ? <span className="omp-warning"> · Warning</span> : null}</span>}>
			{warning ? <p className="omp-warning">{warning}</p> : null}
			{compaction ? <p className="omp-native-muted">Summary of the earlier conversation; full history is retained.</p> : null}
			{method ? <p>Method: {method}</p> : null}
			{superseded ? <><p className="omp-native-muted">Superseded compaction summary.</p><NativeDisclosure title="Original superseded summary"><Markdown text={summary.summary} /></NativeDisclosure></> : <Markdown text={summary.summary} />}
			{"shortSummary" in summary && summary.shortSummary ? <NativeDisclosure title="Short summary"><Markdown text={summary.shortSummary} /></NativeDisclosure> : null}
			{blocks?.length ? <section><h4>Summary archive</h4><MessageContentView content={blocks} /></section> : null}
			{images?.length ? <section><h4>Summary images</h4><MessageContentView content={images} /></section> : null}
			{"preserveData" in summary && !blocks?.length ? <SnapcompactArchiveView preserveData={summary.preserveData} /> : null}
			{before !== undefined || after !== undefined ? <NativeDisclosure title="Context statistics"><p>{before !== undefined ? `${fmtTokens(before)} tokens before` : ""}{before !== undefined && after !== undefined ? " → " : ""}{after !== undefined ? `${fmtTokens(after)} tokens after` : ""}</p></NativeDisclosure> : null}
		</NativeDisclosure>
	</section>;
}

function MessageView({ message, superseded, irc }: { message: ChatMessage; superseded?: boolean; irc?: IrcDisclosure }) {
	switch (message.role) {
		// Native developer inputs seed model context, not a user transcript bubble.
		case "developer": return null;
		case "user":
			return <section className="omp-native-message omp-user">
				{message.synthetic ? <NativeDisclosure title="Agent-attributed input"><MessageContentView content={message.content} references /></NativeDisclosure> : <MessageContentView content={message.content} references />}
			</section>;
		case "custom": case "hookMessage": return <CustomMessageView message={message} irc={irc} />;
		case "bashExecution": case "pythonExecution": return <ExecutionView message={message} />;
		case "branchSummary": case "compactionSummary": return <SummaryView summary={message} superseded={superseded} />;
		case "fileMention":
			return <section className="omp-native-message omp-native-file-mentions">{message.files.map((file, index) => <section className="omp-native-file" key={index}>
				<header><strong>Read</strong> <code>{file.path}</code>{file.lineCount !== undefined ? <span> · {file.lineCount} lines</span> : null}{file.byteSize !== undefined ? <span> · {file.byteSize.toLocaleString()} bytes</span> : null}{file.skippedReason ? <span className="omp-native-badge">Skipped: {file.skippedReason === "binary" ? "binary file" : "file too large"}</span> : null}</header>
				{file.content ? <><pre className="omp-native-code">{file.content.split(/\r?\n/).slice(0, 6).join("\n")}</pre><NativeDisclosure title="Full file content"><pre className="omp-native-code">{file.content}</pre></NativeDisclosure></> : null}
				{file.image ? <MessageContentView content={[file.image]} /> : null}
			</section>)}</section>;
		case "toolResult": case "unknown": return null;
		case "assistant":
			return <AssistantContentView content={message.content} />;
	}
}

/** Non-assistant dispatch. Parent owns ordering, tool attachment routing and full-history projection. */
export function NativeMessage({ entry, model, superseded, irc }: NativeMessageProps) {
	const message = entryMessage(entry);
	if (message) {
		const body = <MessageView message={message} superseded={superseded} irc={irc} />;
		return (message.role === "custom" || message.role === "hookMessage") && Object.hasOwn(IRC_KINDS, message.customType)
			? <div data-interaction-id={`irc:${entry.id}`}>{body}</div> : body;
	}
	switch (entry.type) {
		case "compaction": case "branch_summary": return <SummaryView summary={entry} superseded={superseded} />;
		case "reset_boundary": return <div className="omp-native-divider" role="separator">Context reset · full history retained</div>;
		case "model_change": return <div className="omp-native-muted">Model changed · {model?.name && (model.id === entry.model || `${model.provider}/${model.id}` === entry.model) ? model.name : entry.model}</div>;
		case "thinking_level_change": return <div className="omp-native-muted">Thinking level changed · {thinkingLevelLabel(entry.thinkingLevel)}</div>;
		// Persisted custom metadata is not a displayed custom_message; parent folds native user_todo_edit.
		case "custom": return null;
		case "unknown": return null;
		case "message": case "custom_message": return null;
	}
}

function thinkingLevelLabel(level: string | null | undefined): string {
	const text = (level ?? "off").replaceAll("_", " ");
	return text === "xhigh" ? "Extra high" : text.charAt(0).toUpperCase() + text.slice(1);
}
