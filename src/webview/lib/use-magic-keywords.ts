import { useLayoutEffect, type RefObject } from "react";
import { mayHoldMagicKeyword, mountBubbleKeywords } from "./magic-keyword-views.ts";

/**
 * Paints the magic keywords OMP acts on in the sent message that `ref` holds (`magic-keyword-views.ts`), without changing its DOM.
 * `text` is what the message says, the cheap test of whether there is anything to look for: a message with no keyword word in it
 * mounts nothing. `null` is a message that is not the user's own prompt (agent-attributed input), which OMP's bubbles do not paint
 * either. A layout effect, so a keyword is painted in the frame its message first shows.
 */
export function useMagicKeywords(ref: RefObject<HTMLElement | null>, text: string | null): void {
	const raw = text !== null && mayHoldMagicKeyword(text) ? text : null;
	useLayoutEffect(() => {
		const root = ref.current;
		if (raw === null || root === null) return undefined;
		return mountBubbleKeywords(root, raw);
	}, [ref, raw]);
}
