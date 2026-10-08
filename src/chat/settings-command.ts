export type SettingsKind = "models" | "agents";

/** Bare model aliases and the TUI-only agents command open native configuration instead of prompting. */
export function nativeSettingsCommand(text: string): SettingsKind | null {
	if (/^\s*\/models?\s*$/i.test(text)) return "models";
	return /^\s*\/agents(?:\s[\s\S]*)?$/i.test(text) ? "agents" : null;
}
