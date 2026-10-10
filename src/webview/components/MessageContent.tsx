import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ChatContent, MessageContent } from "../../chat/messages.ts";
import { Markdown } from "./Markdown.tsx";
import { SymbolLinksEligibleContext } from "./FileLinks.tsx";
import { UserImageReferencesContext } from "./ImageReference.tsx";
import { PacedMarkdown } from "./PacedMarkdown.tsx";
import { SavedImage } from "./SavedImage.tsx";
import { getTranscriptToggles, subscribeTranscriptToggles } from "../lib/transcript-toggles.ts";

export interface MessageContentViewProps {
	content: MessageContent;
	pace?: boolean;
	streaming?: boolean;
	bypassPacing?: boolean;
	/** A user message: its `[Image #N]` markers refer to its Nth image, and every image is labelled `#N`. */
	references?: boolean;
}
export interface AssistantContentViewProps { content: readonly ChatContent[]; streaming?: boolean; bypassPacing?: boolean }
export interface NativeDisclosureProps { title: ReactNode; children: ReactNode; className?: string; initiallyOpen?: boolean; forceOpen?: { open: boolean; generation: number } }

/** Materialize large Markdown and archive bodies only on disclosure. */
export function NativeDisclosure({ title, children, className = "", initiallyOpen = false, forceOpen }: NativeDisclosureProps) {
	const [open, setOpen] = useState(initiallyOpen);
	const ref = useRef<HTMLDetailsElement | null>(null);
	const applied = useRef(forceOpen?.generation);
	// A global press (the thinking toggle) opens or closes this block once; the user's own clicks win afterwards.
	useEffect(() => {
		if (forceOpen === undefined || applied.current === forceOpen.generation) return;
		applied.current = forceOpen.generation;
		if (ref.current !== null) ref.current.open = forceOpen.open;
		setOpen(forceOpen.open);
	}, [forceOpen?.generation, forceOpen?.open]);
	return <details ref={ref} open={initiallyOpen || undefined} className={`omp-native-disclosure ${className}`} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => {
		if (event.key !== "Escape" || !event.currentTarget.open || !event.currentTarget.contains(document.activeElement)) return;
		event.preventDefault(); event.stopPropagation(); event.currentTarget.querySelector<HTMLElement>(":scope > summary")?.focus(); event.currentTarget.open = false;
	}}>
		<summary>{title}</summary>
		{open ? children : null}
	</details>;
}

/** A thinking block: closed unless the transcript's thinking toggle (`Ctrl+T`) shows thinking. */
function ThinkingDisclosure({ children }: { children: ReactNode }) {
	const toggles = useSyncExternalStore(subscribeTranscriptToggles, getTranscriptToggles);
	return <NativeDisclosure title="Thinking" className="omp-thinking" initiallyOpen={toggles.thinking} forceOpen={{ open: toggles.thinking, generation: toggles.generation }}><SymbolLinksEligibleContext.Provider value={false}>{children}</SymbolLinksEligibleContext.Provider></NativeDisclosure>;
}


function ContentBlock({ block, pace = false, streaming = false, bypassPacing = false, imageNumber, imageAnchor }: { block: ChatContent; pace?: boolean; streaming?: boolean; bypassPacing?: boolean; imageNumber?: number; imageAnchor?: string }) {
	switch (block.type) {
		case "text":
			return pace ? <PacedMarkdown text={block.text} streaming={streaming} bypass={bypassPacing} /> : <Markdown text={block.text} />;
		case "thinking":
			return block.thinking.trim().length === 0 ? null : <ThinkingDisclosure>{pace ? <PacedMarkdown text={block.thinking} streaming={streaming} bypass={bypassPacing} /> : <Markdown text={block.thinking} />}</ThinkingDisclosure>;
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
	return <SymbolLinksEligibleContext.Provider value><MessageContentView content={content} pace streaming={streaming} bypassPacing={bypassPacing} /></SymbolLinksEligibleContext.Provider>;
}
