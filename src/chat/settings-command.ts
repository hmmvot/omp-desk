export type SettingsKind = "models" | "agents";
/** What a settings command opens: Models or Agents, or the full OMP settings editor (`/settings`). */
export type NativeSettingsTarget = SettingsKind | "omp";

/**
 * Bare model aliases and the TUI-only agents and settings commands open native configuration instead of
 * prompting. `/settings` is OMP's terminal settings menu and takes no arguments, so only the bare command
 * is intercepted here; with arguments it reaches the terminal-only guidance, which opens the same editor.
 */
export function nativeSettingsCommand(text: string): NativeSettingsTarget | null {
	if (/^\s*\/models?\s*$/i.test(text)) return "models";
	if (/^\s*\/settings\s*$/i.test(text)) return "omp";
	return /^\s*\/agents(?:\s[\s\S]*)?$/i.test(text) ? "agents" : null;
}
