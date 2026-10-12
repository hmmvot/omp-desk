import {
	buildView,
	checkValue,
	chooseTarget,
	groupViews,
	hasFolderLayer,
	resetTargets,
	sameValue,
} from "./model.ts";
import type { ConfigLayers, JsonValue, SettingDescriptor, Target, WorkspaceFacts } from "./model.ts";
import type { DeskSettingsMessage } from "./protocol.ts";

/** What the controller needs from VS Code. Tests substitute a fake; `view.ts` binds the real configuration API. */
export interface DeskSettingsPort {
	/** The default, user and workspace layers of a setting, as `WorkspaceConfiguration.inspect` reports them. */
	inspect(key: string): ConfigLayers;
	/** The value in effect for Desk's own reads (no resource), which merges object values across layers. */
	effective(key: string): JsonValue | undefined;
	/** Names of the open folders whose folder layer holds a value for `key`. */
	folderValues(key: string): readonly string[];
	/** Write one layer; `undefined` removes the value. */
	update(key: string, value: JsonValue | undefined, target: Target): Promise<void>;
	workspace(): WorkspaceFacts;
	openSettingsEditor(key: string): Promise<void>;
	openSettingsJson(key: string, target: Target, edit: boolean): Promise<void>;
}

type StateMessage = Extract<DeskSettingsMessage, { type: "settings:state" }>;
type ResultMessage = Extract<DeskSettingsMessage, { type: "settings:result" }>;

const REQUEST_ID = /^[\w-]{1,80}$/;
const LAYER_NAMES: Record<Target, string> = { user: "User", workspace: "Workspace" };

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * The Settings view's host side: projects every contributed setting with its layers, and turns the
 * page's few actions into configuration writes. It trusts nothing from the page: a key must be one of
 * the contributed settings, a value must pass the schema again, and a layer must be one the setting's
 * scope and the window can hold.
 */
export class DeskSettingsController {
	readonly #byKey = new Map<string, SettingDescriptor>();
	/** Writes run one after another so a read-back always sees the previous write. */
	#queue: Promise<unknown> = Promise.resolve();

	readonly descriptors: readonly SettingDescriptor[];
	readonly port: DeskSettingsPort;
	readonly log: (message: string) => void;

	constructor(descriptors: readonly SettingDescriptor[], port: DeskSettingsPort, log: (message: string) => void) {
		this.descriptors = descriptors;
		this.port = port;
		this.log = log;
		for (const descriptor of descriptors) this.#byKey.set(descriptor.key, descriptor);
	}

	state(): StateMessage {
		const workspace = this.port.workspace();
		const entries = this.descriptors.map(descriptor => {
			const layers = this.port.inspect(descriptor.key);
			const folders = hasFolderLayer(descriptor) && workspace.available ? this.port.folderValues(descriptor.key) : [];
			return { descriptor, view: buildView(descriptor, layers, this.port.effective(descriptor.key), workspace, folders) };
		});
		return { type: "settings:state", groups: groupViews(entries), workspace };
	}

	/** Perform one page action. `ready` has no result; the caller answers it with the state. */
	async handle(raw: unknown): Promise<ResultMessage | null> {
		if (typeof raw !== "object" || raw === null) return null;
		const message = raw as Record<string, unknown>;
		const requestId = message.requestId;
		if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) || typeof message.action !== "string") return null;
		if (message.action === "ready") return null;
		const key = message.key;
		const descriptor = typeof key === "string" ? this.#byKey.get(key) : undefined;
		const fail = (text: string): ResultMessage => ({ type: "settings:result", requestId, key: typeof key === "string" ? key : "", ok: false, message: text });
		if (descriptor === undefined) return fail("That is not a setting of OMP Desk.");
		switch (message.action) {
			case "set": return this.#enqueue(() => this.#set(requestId, descriptor, message.value, message.target));
			case "reset": return this.#enqueue(() => this.#reset(requestId, descriptor));
			case "open-editor":
				return this.#open(requestId, descriptor, () => this.port.openSettingsEditor(descriptor.key));
			case "open-json": {
				const layers = this.port.inspect(descriptor.key);
				const target = chooseTarget(descriptor, layers, this.port.workspace(), undefined);
				const resolved: Target = target.ok ? target.target : "user";
				return this.#open(requestId, descriptor, () => this.port.openSettingsJson(descriptor.key, resolved, descriptor.control.kind === "json"));
			}
			default: return fail("Unknown action.");
		}
	}

	#enqueue(task: () => Promise<ResultMessage>): Promise<ResultMessage> {
		const run = this.#queue.then(task, task);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #open(requestId: string, descriptor: SettingDescriptor, open: () => Promise<void>): Promise<ResultMessage> {
		try {
			await open();
			return { type: "settings:result", requestId, key: descriptor.key, ok: true, message: "" };
		} catch (error) {
			this.log(`settings view: could not open ${descriptor.key}: ${errorText(error)}`);
			return { type: "settings:result", requestId, key: descriptor.key, ok: false, message: `Could not open it: ${errorText(error)}` };
		}
	}

	async #set(requestId: string, descriptor: SettingDescriptor, value: unknown, requested: unknown): Promise<ResultMessage> {
		const result = (ok: boolean, message: string): ResultMessage => ({ type: "settings:result", requestId, key: descriptor.key, ok, message });
		const checked = checkValue(descriptor.control, value);
		if (!checked.ok) return result(false, checked.message);
		const workspace = this.port.workspace();
		const layers = this.port.inspect(descriptor.key);
		const chosen = chooseTarget(descriptor, layers, workspace, requested);
		if (!chosen.ok) return result(false, chosen.message);
		const layer = LAYER_NAMES[chosen.target];
		try {
			await this.port.update(descriptor.key, checked.value, chosen.target);
		} catch (error) {
			this.log(`settings view: writing ${descriptor.key} to ${layer} settings failed: ${errorText(error)}`);
			return result(false, `Could not save to ${layer} settings: ${errorText(error)}`);
		}
		this.log(`settings view: ${descriptor.key} = ${JSON.stringify(checked.value)} saved to ${layer} settings`);
		const after = this.port.inspect(descriptor.key);
		const inEffect = this.port.effective(descriptor.key);
		if (sameValue(inEffect, checked.value)) return result(true, `Saved to ${layer} settings.`);
		const overridden = chosen.target === "user" && descriptor.workspaceWritable && workspace.available && after.workspaceValue !== undefined;
		return result(true, overridden
			? "Saved to User settings, but this workspace's own value overrides it here."
			: `Saved to ${layer} settings; VS Code reports a different value in effect.`);
	}

	async #reset(requestId: string, descriptor: SettingDescriptor): Promise<ResultMessage> {
		const result = (ok: boolean, message: string): ResultMessage => ({ type: "settings:result", requestId, key: descriptor.key, ok, message });
		const layers = this.port.inspect(descriptor.key);
		const targets = resetTargets(descriptor, layers, this.port.workspace());
		if (targets.length === 0) return result(true, "Already the default.");
		const cleared: string[] = [];
		for (const target of targets) {
			try {
				await this.port.update(descriptor.key, undefined, target);
				cleared.push(LAYER_NAMES[target]);
			} catch (error) {
				this.log(`settings view: resetting ${descriptor.key} in ${LAYER_NAMES[target]} settings failed: ${errorText(error)}`);
				return result(false, `Could not reset in ${LAYER_NAMES[target]} settings: ${errorText(error)}${cleared.length > 0 ? ` (${cleared.join(" and ")} settings were cleared.)` : ""}`);
			}
		}
		this.log(`settings view: ${descriptor.key} reset (cleared ${cleared.join(" and ")} settings)`);
		const clearedText = `cleared ${cleared.join(" and ")} settings`;
		// The queue excludes neither another window nor a hand edit, so what is in effect is read back before the default is claimed.
		const defaultValue = this.port.inspect(descriptor.key).defaultValue;
		return sameValue(this.port.effective(descriptor.key), defaultValue)
			? result(true, `Reset to the default (${clearedText}).`)
			: result(true, `Cleared ${cleared.join(" and ")} settings; VS Code reports a different value in effect.`);
	}
}
