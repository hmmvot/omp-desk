/**
 * What the provider-error frame of a failed reply says. `errorStatus` is the HTTP status OMP's providers record beside
 * `errorMessage` (pi-ai `AssistantMessage.errorStatus`), so the page never has to scrape it out of the message text; a message
 * without one (an older session, a network failure, a provider that reports none) simply has no status chip.
 */
import type { AssistantMessage } from "./messages.ts";

/** The recorded HTTP status of a failed request, or `undefined` when there is none or it is not a status code. */
export function errorStatusOf(message: AssistantMessage): number | undefined {
	const status: unknown = "errorStatus" in message ? message.errorStatus : undefined;
	return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** The error as it is copied: the status, then the provider's own message, in one text. */
export function copyableError(message: AssistantMessage): string {
	const status = errorStatusOf(message);
	const body = message.errorMessage?.trim() ?? "";
	if (status === undefined) return body.length > 0 ? body : "Provider error";
	return body.length > 0 ? `HTTP ${status}: ${body}` : `Provider error (HTTP ${status})`;
}

/** Past this a provider's message (often a JSON body or a stack) is cut to a few lines until the reader asks for all of it. */
export const LONG_ERROR_CHARACTERS = 240;
export const LONG_ERROR_LINES = 3;

export function isLongError(text: string): boolean {
	return text.length > LONG_ERROR_CHARACTERS || text.split("\n").length > LONG_ERROR_LINES;
}
