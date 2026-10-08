import type { ReactNode } from "react";
import { useId, useState } from "react";
import type { ChatContent, MessageContent } from "../../chat/messages.ts";
import { Markdown } from "./Markdown.tsx";
import { UserImageReferencesContext } from "./ImageReference.tsx";
import { PacedMarkdown } from "./PacedMarkdown.tsx";
import { SavedImage } from "./SavedImage.tsx";

export interface MessageContentViewProps {
	content: MessageContent;
	pace?: boolean;
	streaming?: boolean;
	bypassPacing?: boolean;
	/** A user message: its `[Image #N]` markers refer to its Nth image, and every image is labelled `#N`. */
	references?: boolean;
}
export interface AssistantContentViewProps { content: readonly ChatContent[]; streaming?: boolean; bypassPacing?: boolean }
export interface NativeDisclosureProps { title: ReactNode; children: ReactNode; className?: string }

/** Materialize large Markdown and archive bodies only on disclosure. */
export function NativeDisclosure({ title, children, className = "" }: NativeDisclosureProps) {
	const [open, setOpen] = useState(false);
	return <details className={`omp-native-disclosure ${className}`} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => {
		if (event.key !== "Escape" || !event.currentTarget.open || !event.currentTarget.contains(document.activeElement)) return;
		event.preventDefault(); event.stopPropagation(); event.currentTarget.querySelector<HTMLElement>(":scope > summary")?.focus(); event.currentTarget.open = false;
	}}>
		<summary>{title}</summary>
		{open ? children : null}
	</details>;
}


function ContentBlock({ block, pace = false, streaming = false, bypassPacing = false, imageNumber, imageAnchor }: { block: ChatContent; pace?: boolean; streaming?: boolean; bypassPacing?: boolean; imageNumber?: number; imageAnchor?: string }) {
	switch (block.type) {
		case "text":
			return pace ? <PacedMarkdown text={block.text} streaming={streaming} bypass={bypassPacing} /> : <Markdown text={block.text} />;
		case "thinking":
			return block.thinking.trim().length === 0 ? null : <NativeDisclosure title="Thinking" className="omp-thinking">{pace ? <PacedMarkdown text={block.thinking} streaming={streaming} bypass={bypassPacing} /> : <Markdown text={block.thinking} />}</NativeDisclosure>;
		case "redactedThinking": return null;
		case "image":
			return <figure className="omp-native-image" id={imageAnchor} tabIndex={imageAnchor === undefined ? undefined : -1} data-image-number={imageNumber}>
				<SavedImage mimeType={block.mimeType} data={block.data} alt={imageNumber === undefined ? "Message attachment" : `Image #${imageNumber}`} style={{ maxWidth: "100%", height: "auto" }} />
				{imageNumber !== undefined && <figcaption className="omp-native-image-label">#{imageNumber}</figcaption>}
			</figure>;
		case "fallback": case "anthropicServerTool": case "toolCall": case "unknown":
			return null;
		default:
			return null;
	}
}

export function MessageContentView({ content, pace, streaming, bypassPacing, references = false }: MessageContentViewProps) {
	const base = useId();
	if (typeof content === "string") return <Markdown text={content} />;
	let imageCount = 0;
	const blocks = content.map((block, index) => {
		const imageNumber = references && block.type === "image" ? ++imageCount : undefined;
		return <ContentBlock key={`${block.type}:${index}`} block={block} pace={pace} streaming={streaming} bypassPacing={bypassPacing} imageNumber={imageNumber} imageAnchor={imageNumber === undefined ? undefined : `${base}-image-${imageNumber}`} />;
	});
	const body = <div className="omp-native-content">{blocks}</div>;
	return references ? <UserImageReferencesContext.Provider value={{ count: imageCount, anchor: number => `${base}-image-${number}` }}>{body}</UserImageReferencesContext.Provider> : body;
}

export function AssistantContentView({ content, streaming, bypassPacing }: AssistantContentViewProps) {
	return <MessageContentView content={content} pace streaming={streaming} bypassPacing={bypassPacing} />;
}
