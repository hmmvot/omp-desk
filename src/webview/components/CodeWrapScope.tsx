import type { ReactNode } from "react";
import { createContext, useContext } from "react";

/** The name of the transcript row (and content block) whose code blocks are being drawn; `null` outside one ({@link ../lib/code-wrap}). */
export const CodeWrapScopeContext = createContext<string | null>(null);

/** Names everything below as `id` inside the scope above, so the wrap choice of a block outlives the row's unmount. */
export function CodeWrapScope({ id, children }: { id: string; children: ReactNode }): ReactNode {
	const parent = useContext(CodeWrapScopeContext);
	return <CodeWrapScopeContext.Provider value={parent === null ? id : `${parent}/${id}`}>{children}</CodeWrapScopeContext.Provider>;
}
