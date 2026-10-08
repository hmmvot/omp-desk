/**
 * A `[Image #N, WxH]` marker inside a user message, shown as a reference to the Nth
 * thumbnail of that same message.
 *
 * The marker grammar is the OMP TUI's, which pairs the Nth marker with the Nth image of the
 * message (`composer-attachments`), so the reference is positional: it resolves only inside a
 * user message that provides {@link UserImageReferencesContext}. Anywhere else — assistant
 * prose, a tool result, a marker whose number has no image — the original text is shown
 * unchanged, never a link to nothing.
 */
import { createContext, useContext } from "react";

export interface UserImageReferences {
	/** How many images the message carries; `#N` beyond it is plain text. */
	readonly count: number;
	/** DOM id of the Nth thumbnail. */
	anchor(number: number): string;
}

export const UserImageReferencesContext = createContext<UserImageReferences | null>(null);

export function ImageReferenceToken({ number, label }: { number: number; label: string }) {
	const references = useContext(UserImageReferencesContext);
	if (references === null || number > references.count) return <>{label}</>;
	return (
		<button
			type="button"
			className="omp-image-ref"
			title={`${label} — show attached image #${number}`}
			aria-label={`Image #${number}`}
			onClick={() => {
				const target = document.getElementById(references.anchor(number));
				target?.scrollIntoView({ block: "nearest" });
				target?.focus({ preventScroll: true });
			}}
		>
			<span className="codicon codicon-file-media" aria-hidden="true" />
			Image #{number}
		</button>
	);
}
