/**
 * `set_host_tools` for one `RpcSession` (design section 1, "Registration").
 *
 * Registration is per OMP process and replaces the whole set. `sync()` sends the provider's current tools and only
 * treats them as available once OMP answers with a successful response whose `toolNames` contains every expected
 * name. A rejection makes the tools unavailable for this session (ordinary Chat keeps working); an unanswered
 * request leaves availability unknown and every host call refused until a later registration succeeds. Calls are
 * serialized and coalesced: a settings change that lands while a registration is in flight triggers exactly one more
 * pass with the newest set.
 */

import { isRecord } from "../../shared/guards.ts";
import type { Logger } from "../../shared/logger.ts";
import type { RpcHostToolDefinition } from "../../protocol/rpc.ts";
import type { HostToolCalls } from "./host-tool-calls.ts";
import type { HostToolProvider } from "./host-tool.ts";

export type HostToolAvailability = "none" | "registered" | "rejected" | "unknown";

/** What one `set_host_tools` command came to; mapped by the session from its command outcome. */
export type HostToolSendOutcome =
	| { readonly status: "accepted"; readonly toolNames: unknown }
	| { readonly status: "refused" }
	| { readonly status: "unconfirmed" };

export interface HostToolRegistrationDeps {
	readonly provider: HostToolProvider;
	readonly calls: HostToolCalls;
	send(tools: readonly RpcHostToolDefinition[]): Promise<HostToolSendOutcome>;
	/** Whether the session can still send a command (not disposed, not ended). */
	canSend(): boolean;
	readonly log: Logger;
}

export class HostToolRegistration {
	readonly #deps: HostToolRegistrationDeps;
	#availability: HostToolAvailability = "none";
	/** The last successful registration carried tools, so an empty set must still be sent to remove them. */
	#holdsTools = false;
	#running: Promise<void> | null = null;
	#again = false;

	constructor(deps: HostToolRegistrationDeps) {
		this.#deps = deps;
	}

	get availability(): HostToolAvailability {
		return this.#availability;
	}

	/** Register the provider's current tools; resolves once the newest set has been decided. */
	sync(): Promise<void> {
		if (this.#running !== null) {
			this.#again = true;
			return this.#running;
		}
		this.#running = (async (): Promise<void> => {
			do {
				this.#again = false;
				await this.#once();
			} while (this.#again && this.#deps.canSend());
		})().finally(() => {
			this.#running = null;
		});
		return this.#running;
	}

	/** The tools changed while the session cannot send commands yet: only stop what the new set no longer allows. */
	retractOnly(): void {
		this.#deps.calls.retract(new Set(this.#deps.provider.tools().map(tool => tool.name)));
	}

	async #once(): Promise<void> {
		const tools = this.#deps.provider.tools();
		const names = new Set(tools.map(tool => tool.name));
		this.#deps.calls.retract(names);
		if (tools.length === 0 && !this.#holdsTools) {
			this.#availability = "none";
			return;
		}
		if (!this.#deps.canSend()) return;
		const wire = tools.map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, loadMode: tool.loadMode }));
		const outcome = await this.#deps.send(wire);
		if (outcome.status === "accepted" && confirms(outcome.toolNames, names)) {
			this.#deps.calls.setRegistered(names);
			this.#holdsTools = names.size > 0;
			this.#availability = names.size > 0 ? "registered" : "none";
			return;
		}
		this.#deps.calls.setRegistered(new Set());
		if (outcome.status === "unconfirmed") {
			this.#availability = "unknown";
			this.#deps.log.warn("OMP did not answer set_host_tools; Desk's host tools stay unavailable until a registration succeeds.");
			return;
		}
		this.#availability = "rejected";
		this.#deps.log.warn("OMP rejected set_host_tools or answered without the expected tool names; Desk's host tools are unavailable in this session.");
	}
}

function confirms(toolNames: unknown, expected: ReadonlySet<string>): boolean {
	if (!Array.isArray(toolNames)) return false;
	const names = new Set(toolNames.filter((name): name is string => typeof name === "string"));
	for (const name of expected) if (!names.has(name)) return false;
	return true;
}

/** Reads `{ toolNames }` out of a `set_host_tools` response's data. */
export function toolNamesOf(data: unknown): unknown {
	return isRecord(data) ? data.toolNames : undefined;
}
