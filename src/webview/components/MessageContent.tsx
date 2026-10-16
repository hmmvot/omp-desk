import type { ReactNode } from "react";
import { useId, useSyncExternalStore } from "react";
import type { ChatContent, MessageContent } from "../../chat/messages.ts";
import { FileBlockRows } from "./FileBlockRow.tsx";
import { Markdown } from "./Markdown.tsx";
import { AssistantReplyContext } from "./FileLinks.tsx";
import { UserImageReferencesContext } from "./ImageReference.tsx";
import { NativeDisclosure } from "./NativeDisclosure.tsx";
import { PacedMarkdown } from "./PacedMarkdown.tsx";
import { SavedImage } from "./SavedImage.tsx";
import { splitUserText } from "../lib/file-block-rows.ts";
import { getTranscriptToggles, subscribeTranscriptToggles } from "../lib/transcript-toggles.ts";

export interface MessageContentViewProps {
	content: MessageContent;
	pace?: boolean;
	streaming?: boolean;
	bypassPacing?: boolean;
	/** A user message: its `[Image #N]` markers refer to its Nth image, and every image is labelled `#N`. */
	references?: boolean;
	/** The message is something the reader may quote into the draft: its Markdown keeps the records capture needs. */
	quotable?: boolean;
	/** `false` for text the user typed: `*`, `_` and `~~` stay literal characters instead of styling the text. */
	emphasis?: boolean;
}
export interface AssistantContentViewProps { content: readonly ChatContent[]; streaming?: boolean; bypassPacing?: boolean }

/** A user's text: its prose as Markdown, as ever, and under it one closed row per attached file. A text that does not parse is the Markdown it always was. */
function UserText({ text, quotable, emphasis }: { text: string; quotable: boolean; emphasis: boolean }) {
	const { prose, blocks } = splitUserText(text);
	if (blocks.length === 0) return <Markdown text={text} quotable={quotable} emphasis={emphasis} />;
	return <><Markdown text={prose} quotable={quotable} emphasis={emphasis} /><FileBlockRows blocks={blocks} /></>;
}

/** A thinking block: closed unless the transcript's thinking toggle (`Ctrl+T`) shows thinking. */
function ThinkingDisclosure({ children }: { children: ReactNode }) {
	const toggles = useSyncExternalStore(subscribeTranscriptToggles, getTranscriptToggles);
	return <NativeDisclosure title="Thinking" className="omp-thinking" initiallyOpen={toggles.thinking} forceOpen={{ open: toggles.thinking, generation: toggles.generation }}><AssistantReplyContext.Provider value={false}>{children}</AssistantReplyContext.Provider></NativeDisclosure>;
}


function ContentBlock({ block, pace = false, streaming = false, bypassPacing = false, quotable = false, emphasis = true, references = false, imageNumber, imageAnchor }: { block: ChatContent; pace?: boolean; streaming?: boolean; bypassPacing?: boolean; quotable?: boolean; emphasis?: boolean; references?: boolean; imageNumber?: number; imageAnchor?: string }) {
	switch (block.type) {
		case "text":
			if (references) return <UserText text={block.text} quotable={quotable} emphasis={emphasis} />;
			return pace ? <PacedMarkdown text={block.text} streaming={streaming} bypass={bypassPacing} quotable={quotable} emphasis={emphasis} /> : <Markdown text={block.text} quotable={quotable} emphasis={emphasis} />;
		case "thinking":
			return block.thinking.trim().length === 0 ? null : <ThinkingDisclosure>{pace ? <PacedMarkdown text={block.thinking} streaming={streaming} bypass={bypassPacing} quotable={quotable} emphasis={emphasis} /> : <Markdown text={block.thinking} quotable={quotable} emphasis={emphasis} />}</ThinkingDisclosure>;
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

export function MessageContentView({ content, pace, streaming, bypassPacing, references = false, quotable = false, emphasis = true }: MessageContentViewProps) {
	const base = useId();
	if (typeof content === "string") return references ? <UserText text={content} quotable={quotable} emphasis={emphasis} /> : <Markdown text={content} quotable={quotable} emphasis={emphasis} />;
	let imageCount = 0;
	const blocks = content.map((block, index) => {
		const imageNumber = references && block.type === "image" ? ++imageCount : undefined;
		return <ContentBlock key={`${block.type}:${index}`} block={block} pace={pace} streaming={streaming} bypassPacing={bypassPacing} quotable={quotable} emphasis={emphasis} references={references} imageNumber={imageNumber} imageAnchor={imageNumber === undefined ? undefined : `${base}-image-${imageNumber}`} />;
	});
	const body = <div className="omp-native-content">{blocks}</div>;
	return references ? <UserImageReferencesContext.Provider value={{ count: imageCount, anchor: number => `${base}-image-${number}` }}>{body}</UserImageReferencesContext.Provider> : body;
}

export function AssistantContentView({ content, streaming, bypassPacing }: AssistantContentViewProps) {
	return <AssistantReplyContext.Provider value><MessageContentView content={content} pace streaming={streaming} bypassPacing={bypassPacing} quotable /></AssistantReplyContext.Provider>;
}
