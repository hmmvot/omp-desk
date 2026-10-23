/**
 * The real {@link FieldPort}: the Draft's writes (docs/designs/2026-10-23-composer-draft-module.md, section 3) as calls of the editing
 * surface of ADR-0077. The surface stays the field adapter: it owns the string in the DOM, the selection and the text-only undo history;
 * this file only says which of its calls each write is.
 */
import type { FieldPort, Selection, Write } from "./draft/draft.ts";
import type { DraftSurface } from "./draft-surface.ts";

export interface SurfacePort extends FieldPort {
	/** A surface was mounted: a freeze received while none was attached applies now (a field that mounts while the hand-off holds the draft starts frozen). */
	adopt(): void;
}

/** The port over whatever surface `surface()` returns now; `null` is a field that is not mounted (a dialog replaced it). */
export function createSurfacePort(surface: () => DraftSurface | null): SurfacePort {
	let frozen = false;
	return {
		mounted: () => surface() !== null,
		composing: () => surface()?.composing ?? false,
		selection(): Selection {
			const field = surface();
			return field === null ? { anchor: 0, focus: 0 } : { anchor: field.selectionStart, focus: field.selectionEnd };
		},
		write(write: Write): boolean {
			const field = surface();
			if (field === null) return true;
			switch (write.kind) {
				case "text":
					// The surface drops a text while frozen; the cell must know, so its value does not claim a text the field never took.
					if (field.frozen) return false;
					field.setText(write.text, write.caret === undefined ? { history: write.history } : { caret: write.caret, history: write.history });
					if (write.focus) field.focus();
					return true;
				case "edit":
					if (write.focus) field.focus();
					return field.apply(write.edit, write.as);
				case "remove":
					if (write.focus) field.focus();
					return field.removeRanges(write.ranges);
				case "caret":
					if (write.focus) field.focus();
					field.setSelectionRange(write.at, write.at);
					return true;
			}
		},
		redraw: () => surface()?.refresh(),
		freeze() {
			frozen = true;
			surface()?.freeze();
		},
		thaw() {
			frozen = false;
			surface()?.thaw();
		},
		adopt() {
			if (frozen) surface()?.freeze();
		},
	};
}
