/**
 * The composer's input element: a `contenteditable` div owned by a {@link DraftSurface}
 * (docs/designs/2026-10-15-composer-contenteditable-surface.md).
 *
 * React renders the element with a class and nothing else: no children, no attributes that change while the user types.
 * The surface renders the draft into it and owns its attributes (`configure`), so no React commit can write into the DOM
 * an IME composition is using.
 */
import type { MutableRefObject, ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { DraftSurface, type SurfaceConfig, type SurfaceOptions } from "../lib/draft-surface";

export function DraftEditor({ surfaceRef, text, config, options }: {
	/** Set to the surface while the element is mounted, `null` otherwise. */
	surfaceRef: MutableRefObject<DraftSurface | null>;
	/** The draft: seeds the surface when it is created. Later changes reach it through `writeDraft`, never through this prop. */
	text: string;
	config: SurfaceConfig;
	/** Handlers; the latest of each is read when it is called. */
	options: SurfaceOptions;
}): ReactNode {
	const elementRef = useRef<HTMLDivElement | null>(null);
	const latest = useRef({ text, config, options });
	latest.current = { text, config, options };
	const applied = useRef<SurfaceConfig | null>(null);

	useLayoutEffect(() => {
		const element = elementRef.current;
		if (element === null) return;
		const surface = new DraftSurface(element, {
			isKnownReference: (kind, number, name) => latest.current.options.isKnownReference(kind, number, name),
			resolveCommand: name => latest.current.options.resolveCommand(name),
			onEdit: value => latest.current.options.onEdit(value),
			onSelection: () => latest.current.options.onSelection(),
			onKeyDown: event => latest.current.options.onKeyDown(event),
			onWindowOpen: () => latest.current.options.onWindowOpen(),
			onSettled: () => latest.current.options.onSettled(),
			handlePaste: event => latest.current.options.handlePaste(event),
			isAttachmentDrag: transfer => latest.current.options.isAttachmentDrag(transfer),
		});
		surface.seed(latest.current.text);
		surface.configure(latest.current.config);
		applied.current = latest.current.config;
		surfaceRef.current = surface;
		return () => {
			// Settles an open composition while the element still has its DOM, then lets go.
			surface.dispose();
			surfaceRef.current = null;
			applied.current = null;
		};
	}, [surfaceRef]);

	useLayoutEffect(() => {
		const previous = applied.current;
		if (previous === null || (previous.editable === config.editable && previous.placeholder === config.placeholder && previous.describedBy === config.describedBy && previous.controls === config.controls && previous.activeDescendant === config.activeDescendant)) return;
		applied.current = config;
		surfaceRef.current?.configure(config);
	});

	return <div ref={elementRef} className="omp-composer-input" />;
}
