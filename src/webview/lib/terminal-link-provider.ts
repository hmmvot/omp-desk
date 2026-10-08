import type { IBuffer, IBufferCellPosition, ILink, ILinkProvider } from "@xterm/xterm";
import { detectTerminalFileLinks } from "../terminal-links.ts";
import { ValidationCache } from "./link-validation-cache.ts";

/** Uses terminal cells (not JS string length) so wide glyphs and wrapped paths stay clickable. */
export function terminalFileLinkProvider(terminal: { readonly buffer: { readonly active: IBuffer }; readonly cols: number }, hooks: {
	validate(target: string): Promise<boolean>;
	activate(target: string): void;
	hover(target: string): void;
	leave(): void;
	/** Clock for cache expiry; tests inject one. */
	now?(): number;
}): ILinkProvider {
	const cache = new ValidationCache(hooks.validate, hooks.now ?? Date.now);
	// The row can repaint while its first stats are in flight; those answers are cached by
	// then, so a second look usually completes synchronously instead of dropping the link.
	const provide = (lineNumber: number, callback: (links: ILink[] | undefined) => void, attemptsLeft: number): void => {
		const buffer = terminal.buffer.active;
		let first = lineNumber - 1;
		while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
		let last = lineNumber - 1;
		while (buffer.getLine(last + 1)?.isWrapped) last++;
		let text = "";
		const positions: IBufferCellPosition[] = [];
		for (let y = first; y <= last; y++) {
			const row = buffer.getLine(y);
			if (!row) continue;
			for (let x = 0; x < row.length; x++) {
				const cell = row.getCell(x);
				if (!cell || cell.getWidth() === 0) continue;
				const chars = cell.getChars() || " ";
				for (let index = 0; index < chars.length; index++) positions.push({ x: x + 1, y: y + 1 });
				text += chars;
			}
		}
		const source = text;
		const candidates = detectTerminalFileLinks(text).filter(link => positions[link.start]!.y <= lineNumber && positions[link.end - 1]!.y >= lineNumber);
		const linksFor = (valid: (target: string) => boolean | undefined): ILink[] => {
			const links: ILink[] = [];
			for (const candidate of candidates) {
				if (valid(candidate.target) !== true) continue;
				links.push({
					text: candidate.target,
					range: { start: positions[candidate.start]!, end: positions[candidate.end - 1]! },
					activate(event) { event.preventDefault(); hooks.activate(candidate.target); },
					hover() { hooks.hover(candidate.target); },
					leave() { hooks.leave(); },
				});
			}
			return links;
		};
		// Every answer is already known: reply in this task so a repaint-driven re-query
		// swaps the link without a visible gap.
		if (candidates.every(candidate => cache.peek(candidate.target) !== undefined)) {
			callback(linksFor(target => cache.peek(target)));
			return;
		}
		// Serialize stats per row instead of dropping later references or flooding
		// the authenticated bridge's bounded outstanding-request slots.
		void (async () => {
			const answers = new Map<string, boolean>();
			for (const candidate of candidates) {
				if (!answers.has(candidate.target)) answers.set(candidate.target, await cache.resolve(candidate.target));
			}
			// Async stat must not install hotspots over output that has already changed.
			let current = "";
			for (let y = first; y <= last; y++) current += buffer.getLine(y)?.translateToString(false) ?? "";
			if (terminal.buffer.active === buffer && current === source) callback(linksFor(target => answers.get(target)));
			else if (attemptsLeft > 0) provide(lineNumber, callback, attemptsLeft - 1);
			else callback(undefined);
		})().catch(() => callback(undefined));
	};
	return { provideLinks: (lineNumber, callback) => provide(lineNumber, callback, 2) };
}
