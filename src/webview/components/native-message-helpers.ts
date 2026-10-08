import type { MessageContent } from "../../chat/messages.ts";
import { isRecord } from "../../guards.ts";

export interface LateDiagnosticsFile {
	path?: string;
	summary?: string;
	errored?: boolean;
	messages?: readonly string[];
}

/** Native attachment identity is the file path, not a guessed tool-call id. */
export function lateDiagnosticsFiles(details: unknown): readonly LateDiagnosticsFile[] {
	if (!isRecord(details) || !Array.isArray(details.files)) return [];
	return details.files.filter((file): file is LateDiagnosticsFile => isRecord(file)
		&& (file.path === undefined || typeof file.path === "string")
		&& (file.summary === undefined || typeof file.summary === "string")
		&& (file.errored === undefined || typeof file.errored === "boolean")
		&& (file.messages === undefined || (Array.isArray(file.messages) && file.messages.every(message => typeof message === "string"))));
}

export function nativeText(content: MessageContent): string {
	return typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

export function stringField(data: unknown, key: string): string | undefined {
	return isRecord(data) && typeof data[key] === "string" ? data[key] : undefined;
}

export function numberField(data: unknown, key: string): number | undefined {
	return isRecord(data) && typeof data[key] === "number" && Number.isFinite(data[key]) ? data[key] : undefined;
}

export function recordRows(data: unknown, key: string): readonly Record<string, unknown>[] {
	return isRecord(data) && Array.isArray(data[key]) ? data[key].filter(isRecord) : [];
}
