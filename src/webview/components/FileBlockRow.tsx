import type { ReactNode } from "react";
import { useMemo } from "react";
import type { FileBlock } from "../../shared/file-blocks.ts";
import { formatBytes, groupedCount } from "../../shared/file-size.ts";
import { lineCount, utf8Length } from "../lib/file-block-rows.ts";
import { CopyButton } from "./CopyButton.tsx";
import { NativeDisclosure } from "./NativeDisclosure.tsx";
import { CodePreview } from "./tool-renderer-primitives.tsx";

/**
 * The text of an opened row: the file's own lines on the code renderer the tool cards use, so a text within the highlight caps is
 * coloured whole (by the language of the file's name), a longer one in aligned chunks, and any other text stays plain. It mounts
 * only while the row is open, which is what keeps a message with a 200 000-character file free until the reader asks for it.
 */
function FileBlockBody({ block }: { block: FileBlock }): ReactNode {
	if (block.content === "") return <p className="omp-native-muted">Empty file</p>;
	// A final newline ends the last line; shown as a row of its own it would be a line the file does not have.
	const text = block.content.endsWith("\n") ? block.content.slice(0, -1) : block.content;
	if (text === "") return <p className="omp-native-muted">One empty line</p>;
	return <div className="omp-file-row-body"><CodePreview text={text} expanded path={block.name} /></div>;
}

/** One attached file of a sent message: closed until opened, with its own Copy for the file's content. */
export function FileBlockRow({ block }: { block: FileBlock }): ReactNode {
	const summary = useMemo(() => {
		const lines = lineCount(block.content);
		return `${groupedCount(lines)} ${lines === 1 ? "line" : "lines"} · ${formatBytes(utf8Length(block.content))}`;
	}, [block.content]);
	const head = <span className="omp-file-row-head" title={block.label ?? "no path"}>
		<span className="codicon codicon-file" aria-hidden="true" />
		<span className="omp-file-row-name">{block.name}</span>
		<span className="omp-file-row-meta">{summary}</span>
	</span>;
	// The Copy button is the row's sibling, not part of the summary: a button inside a summary is a control nested in a control.
	return <div className="omp-file-row" data-file-number={block.number}>
		<NativeDisclosure className="omp-file-row-disclosure" title={head}><FileBlockBody block={block} /></NativeDisclosure>
		{block.content !== "" && <CopyButton text={block.content} label={`Copy ${block.name}`} className="omp-file-row-copy" />}
	</div>;
}

/** The rows of a message's file blocks, in block order. */
export function FileBlockRows({ blocks }: { blocks: readonly FileBlock[] }): ReactNode {
	return <div className="omp-file-rows">{blocks.map(block => <FileBlockRow key={block.number} block={block} />)}</div>;
}
