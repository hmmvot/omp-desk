/**
 * The composer's handle on the Draft (docs/designs/2026-10-23-composer-draft-module.md, section 3): one cell per mounted composer, the
 * port that lets it reach the editing surface, and the state React renders from. The cell is plain TypeScript; this hook only gives it a
 * lifetime (it is disposed with the component) and subscribes the component to it.
 */
import type { MutableRefObject } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createDraftCell, type DraftCell, type DraftCellState } from "./draft/draft.ts";
import { createSurfacePort, type SurfacePort } from "./draft-write.ts";
import type { DraftSurface } from "./draft-surface.ts";

export interface DraftHandle {
	readonly cell: DraftCell;
	/** The port over the mounted surface; `DraftEditor` fills {@link DraftHandle.surfaceRef}. */
	readonly port: SurfacePort;
	/** The editing surface while its element is mounted, `null` otherwise. */
	readonly surfaceRef: MutableRefObject<DraftSurface | null>;
}

/** The cell of this composer and what it renders from: the draft, the caret and whether the hand-off holds the draft. */
export function useDraft(): DraftHandle & { readonly state: DraftCellState } {
	const surfaceRef = useRef<DraftSurface | null>(null);
	const [handle] = useState<DraftHandle>(() => {
		const port = createSurfacePort(() => surfaceRef.current);
		return { cell: createDraftCell(port), port, surfaceRef };
	});
	const { cell } = handle;
	const state = useSyncExternalStore(cell.subscribe, cell.getState);
	// Draft base64 and previews live only in the cell's value; dropping the cell with the component is what releases them.
	useEffect(() => () => cell.dispose(), [cell]);
	return { ...handle, state };
}
