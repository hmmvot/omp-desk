import type { JsonValue, SettingGroupView, Target, WorkspaceFacts } from "./model.ts";

/** Page to host. Every action carries a request id the result echoes. */
export type DeskSettingsAction =
	| { readonly action: "ready"; readonly requestId: string }
	/** Write `value` for `key`; `target` is the layer the user chose, absent for the default layer. */
	| { readonly action: "set"; readonly requestId: string; readonly key: string; readonly value: JsonValue; readonly target?: Target }
	/** Clear the setting's user and workspace values so its default applies again. */
	| { readonly action: "reset"; readonly requestId: string; readonly key: string }
	/** Open the Settings editor filtered to the one setting. */
	| { readonly action: "open-editor"; readonly requestId: string; readonly key: string }
	/** Open the settings.json that holds the value (the workspace's when it overrides), revealing the key. */
	| { readonly action: "open-json"; readonly requestId: string; readonly key: string };

/** Host to page. */
export type DeskSettingsMessage =
	| { readonly type: "settings:state"; readonly groups: readonly SettingGroupView[]; readonly workspace: WorkspaceFacts }
	| { readonly type: "settings:result"; readonly requestId: string; readonly key: string; readonly ok: boolean; readonly message: string };
