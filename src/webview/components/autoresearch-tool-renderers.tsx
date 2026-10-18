import type { ReactNode } from "react";
import { experimentTone, firstLine, formatMetric, HARNESS_COMMAND, isExperimentStatus, readExperimentProgress, readExperimentRun, readLoggedExperiment } from "../../chat/autoresearch";
import type { ExperimentTone } from "../../chat/autoresearch";
import { FileLink } from "./FileLinks";
import { JsonOutput, LimitedList, Section, string, TextPreview } from "./tool-renderer-primitives";
import type { ToolRenderContext, ToolSemanticView } from "./tool-render-types";

/**
 * OMP's autoresearch tools as its terminal UI shows them (`pi-tui/src/tools/autoresearch.ts`): `log_experiment` as its
 * disposition, description and metric against the baseline, `run_experiment` as PASS, FAIL or TIMEOUT with the duration and
 * the tail of the benchmark's output, `init_experiment` and `update_notes` by what they say. A result without the
 * expected details shows its text, an error in the error colour.
 */
const TONE_CLASS: Readonly<Record<ExperimentTone, string>> = { success: "omp-native-selected", warning: "omp-native-warning", error: "omp-native-error" };

function visibleArgs(c: ToolRenderContext): Record<string, unknown> {
	return Object.fromEntries(Object.entries(c.args).filter(([key, value]) => value != null && key !== "i" && key !== "__partialJson"));
}

function ArgsSection({ args, expanded }: { args: Record<string, unknown>; expanded: boolean }): ReactNode {
	return Object.keys(args).length > 0 ? <Section title="Args"><JsonOutput value={args} expanded={expanded} omitAbsent id="args" /></Section> : null;
}

/** What a tool without (usable) details said: its text, red for an error. */
function ResultText({ c }: { c: ToolRenderContext }): ReactNode {
	if (!c.hasResult || c.text.trim() === "") return null;
	return c.isError ? <div className="omp-native-error omp-tool-wrap">{c.text.trim()}</div> : <TextPreview text={c.text} expanded={c.expanded} />;
}

function init(c: ToolRenderContext): ToolSemanticView {
	return { title: "Init experiment", icon: "beaker", family: "autoresearch", target: firstLine(c.args.name) || undefined, tone: c.isError ? "error" : undefined,
		body: <><ResultText c={c} /><ArgsSection args={visibleArgs(c)} expanded={c.expanded} /></> };
}

function log(c: ToolRenderContext): ToolSemanticView {
	const logged = c.isError ? null : readLoggedExperiment(c.details);
	const status = isExperimentStatus(c.args.status) ? c.args.status : logged?.status;
	const tone = status === undefined ? undefined : experimentTone(status);
	const description = firstLine(c.args.description) || firstLine(logged?.description);
	const facts = logged === null ? [] : [
		logged.metric === null ? "" : `${logged.metricName}=${formatMetric(logged.metric, logged.metricUnit)}`,
		logged.baseline === null ? "" : `baseline ${formatMetric(logged.baseline, logged.metricUnit)}`,
		logged.confidence === null ? "" : `conf ${logged.confidence.toFixed(1)}x`,
		logged.scopeDeviations.length > 0 ? `deviations:${logged.scopeDeviations.length}` : "",
	].filter(Boolean);
	// The disposition leads the head as a word (colour never carries it alone): the description may be long and is cut at the head's end.
	return { title: status === undefined ? "Log experiment" : `Log experiment · ${status}`, icon: "beaker", family: "autoresearch", target: description || undefined, meta: facts,
		tone: c.isError || logged !== null && tone === "error" ? "error" : logged !== null && tone === "warning" ? "warning" : undefined,
		body: <>
			{logged === null ? <ResultText c={c} /> : <>
				<div className="omp-native-job-head"><strong className={TONE_CLASS[experimentTone(logged.status)]}>{logged.status.toUpperCase()}</strong><span>{logged.description}</span></div>
				<dl className="omp-tool-kv">
					{logged.metric !== null && <><dt>{logged.metricName}</dt><dd>{formatMetric(logged.metric, logged.metricUnit)}</dd></>}
					{logged.baseline !== null && <><dt>baseline</dt><dd>{formatMetric(logged.baseline, logged.metricUnit)}</dd></>}
					{logged.confidence !== null && <><dt>confidence</dt><dd>{logged.confidence.toFixed(1)}x</dd></>}
					{logged.scopeDeviations.length > 0 && <><dt>deviations</dt><dd className="omp-native-warning">{logged.scopeDeviations.length}</dd></>}
				</dl>
				{logged.scopeDeviations.length > 0 && <Section title="Scope deviations"><LimitedList items={logged.scopeDeviations} expanded={c.expanded} render={path => <span className="omp-native-path">{path}</span>} /></Section>}
			</>}
			<ArgsSection args={visibleArgs(c)} expanded={c.expanded} />
		</> };
}

function run(c: ToolRenderContext): ToolSemanticView {
	const elapsed = c.isError ? null : readExperimentProgress(c.details);
	const finished = c.isError || elapsed !== null ? null : readExperimentRun(c.details);
	const running = elapsed !== null;
	return { title: "Run experiment", icon: "beaker", family: "autoresearch", target: HARNESS_COMMAND, tone: c.isError || finished?.tone === "error" ? "error" : running ? "warning" : undefined,
		inline: running ? <span className="omp-native-warning">Running {elapsed}…</span> : finished === null ? undefined : <span className={TONE_CLASS[finished.tone]}>{finished.label} {finished.summary}</span>,
		body: <>
			{running && <div className="omp-native-warning"><span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> Running {elapsed}…</div>}
			{running && c.text.trim() !== "" && <TextPreview text={c.text} expanded={c.expanded} tail />}
			{finished !== null && <>
				<strong className={TONE_CLASS[finished.tone]}>{finished.label}</strong> <span className={TONE_CLASS[finished.tone]}>{finished.summary}</span>
				{finished.tailOutput.trim() !== "" && <TextPreview text={finished.tailOutput} expanded={c.expanded} tail />}
				{finished.truncated && finished.fullOutputPath !== "" && <div className="omp-native-warning omp-native-path">Full output: <FileLink target={finished.fullOutputPath}>{finished.fullOutputPath}</FileLink></div>}
			</>}
			{!running && finished === null && <ResultText c={c} />}
			<ArgsSection args={visibleArgs(c)} expanded={c.expanded} />
		</> };
}

function notes(c: ToolRenderContext): ToolSemanticView {
	// OMP appends a non-blank `append_idea` and ignores `body` then; otherwise `body` replaces the notes.
	const idea = string(c.args.append_idea).trim();
	const body = string(c.args.body);
	return { title: "Update notes", icon: "notebook", family: "autoresearch", target: firstLine(idea || body.slice(0, 100)) || undefined, tone: c.isError ? "error" : undefined,
		body: <>
			{idea !== "" ? <Section title="Idea"><TextPreview text={idea} expanded={c.expanded} prose /></Section> : body !== "" && <Section title="Notes"><TextPreview text={body} expanded={c.expanded} prose /></Section>}
			<ResultText c={c} />
		</> };
}

export const autoresearchToolRenderers: Record<string, (context: ToolRenderContext) => ToolSemanticView> = {
	init_experiment: init, log_experiment: log, run_experiment: run, update_notes: notes,
};
