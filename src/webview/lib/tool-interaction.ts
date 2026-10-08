import type { ToolRun } from "../../chat/tool-overview";
import { overviewMemberId } from "../../chat/tool-overview";

interface TextPoint { callId: string; offset: number }
interface FocusPoint { callId: string; body: boolean; path: readonly number[] }
export interface ToolInteraction {
	focus: FocusPoint | null;
	selection: { anchor: TextPoint; focus: TextPoint } | null;
	/** Only body interactions force detail disclosure; a focused header stays closed. */
	calls: ReadonlyMap<string, boolean>;
}
const toolFor = (node: Node | null): HTMLElement | null => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-tool-call-id], [data-interaction-id]") ?? null;
const interactionId = (node: HTMLElement | null): string | undefined => node?.dataset.toolCallId ?? node?.dataset.interactionId;
function textPoint(node: Node | null, offset: number): TextPoint | null {
	const tool = toolFor(node), body = tool?.querySelector(".omp-tool-body"), callId = interactionId(tool);
	if (!node || !body?.contains(node) || !callId) return null;
	const range = document.createRange(); range.setStart(body, 0); range.setEnd(node, offset);
	return { callId, offset: range.toString().length };
}
function elementPath(root: Element, element: Element): number[] {
	const path: number[] = [];
	for (let child = element; child !== root && child.parentElement; child = child.parentElement) path.unshift([...child.parentElement.children].indexOf(child));
	return path;
}
/** Capture logical tool interaction before density or disclosure changes hide a call. */
export function captureToolInteraction(root: HTMLElement, runs: readonly ToolRun[]): ToolInteraction {
	const calls = new Map<string, boolean>(); let focus: FocusPoint | null = null;
	const active = document.activeElement;
	if (active instanceof HTMLElement && root.contains(active)) {
		const tool = toolFor(active), body = tool?.querySelector(".omp-tool-body"), callId = interactionId(tool);
		if (callId) {
			const inBody = Boolean(body?.contains(active));
			focus = { callId, body: inBody, path: inBody ? elementPath(body!, active) : [] };
			calls.set(focus.callId, inBody);
		} else {
			const group = active.closest<HTMLElement>(".omp-tool-overview");
			const first = runs.find(run => run.id === group?.dataset.sourceId)?.members[0];
			if (first) { focus = { callId: overviewMemberId(first), body: false, path: [] }; calls.set(focus.callId, false); }
		}
	}
	const native = document.getSelection();
	const anchor = native && !native.isCollapsed && root.contains(native.anchorNode) ? textPoint(native.anchorNode, native.anchorOffset) : null;
	const end = native && !native.isCollapsed && root.contains(native.focusNode) ? textPoint(native.focusNode, native.focusOffset) : null;
	const selection = anchor && end ? { anchor, focus: end } : null;
	if (selection) { calls.set(selection.anchor.callId, true); calls.set(selection.focus.callId, true); }
	return { focus, selection, calls };
}
function locateText(body: Element, offset: number): [Node, number] | null {
	const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let node: Node | null;
	while ((node = walker.nextNode())) { const length = node.textContent?.length ?? 0; if (offset <= length) return [node, offset]; offset -= length; }
	return null;
}
/** Restore logical offsets, not stale nodes or React-generated disclosure ids. */
export function restoreToolInteraction(root: HTMLElement, interaction: ToolInteraction): void {
	const tools = new Map([...root.querySelectorAll<HTMLElement>("[data-tool-call-id], [data-interaction-id]")].map(tool => [interactionId(tool)!, tool]));
	if (interaction.focus) {
		const point = interaction.focus, tool = tools.get(point.callId);
		let target = tool?.querySelector<HTMLElement>(point.body ? ".omp-tool-body" : ".omp-tool-head");
		for (const index of point.path) target = target?.children[index] as HTMLElement | undefined;
		(target ?? tool?.querySelector<HTMLElement>(".omp-tool-head"))?.focus({ preventScroll: true });
	}
	if (interaction.selection) {
		const { anchor, focus } = interaction.selection;
		const startBody = tools.get(anchor.callId)?.querySelector(".omp-tool-body"), endBody = tools.get(focus.callId)?.querySelector(".omp-tool-body");
		const start = startBody ? locateText(startBody, anchor.offset) : null, end = endBody ? locateText(endBody, focus.offset) : null;
		if (start && end) document.getSelection()?.setBaseAndExtent(...start, ...end);
	}
}
/** The exception ends as soon as its native focus/selection leaves those calls. */
export function heldToolInteractions(root: HTMLElement, calls: ReadonlyMap<string, boolean>): ReadonlyMap<string, boolean> {
	const next = new Map<string, boolean>(), selection = document.getSelection();
	const nodes = [document.activeElement, selection && !selection.isCollapsed ? selection.anchorNode : null, selection && !selection.isCollapsed ? selection.focusNode : null];
	for (const node of nodes) { const tool = toolFor(node), id = interactionId(tool); if (tool && root.contains(tool) && id && calls.has(id)) next.set(id, calls.get(id)!); }
	return next;
}
