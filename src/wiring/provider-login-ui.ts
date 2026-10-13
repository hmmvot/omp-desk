import type * as vscode from "vscode";
import type { LoginUi, UiPickItem } from "../host/provider-login-flow.ts";

/** The members of the editor API the login flows use; the extension passes `vscode`, a test passes a double. */
export type LoginUiApi = Pick<typeof vscode, "window" | "env" | "Uri" | "ProgressLocation" | "CancellationTokenSource">;

const ICONS: Record<NonNullable<UiPickItem<unknown>["icon"]>, string> = { check: "$(check) ", terminal: "$(terminal) " };

/**
 * The editor side of the provider login (ADR-0070): one progress notification with Cancel per phase, pick lists
 * that close when the flow's signal aborts, a masked input box that stays open when focus moves, the system
 * browser through `env.openExternal`, and modal confirmation. No text typed into the input box is kept here.
 */
export function createLoginUi(api: LoginUiApi): LoginUi {
	/** A token that cancels with `signal`; `release` stops listening once the dialog is done. */
	const linked = (signal: AbortSignal): { readonly token: vscode.CancellationToken; release(): void } => {
		const source = new api.CancellationTokenSource();
		const cancel = (): void => source.cancel();
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
		return { token: source.token, release: () => { signal.removeEventListener("abort", cancel); source.dispose(); } };
	};
	return {
		withProgress: (title, run, options) => Promise.resolve(api.window.withProgress({ location: api.ProgressLocation.Notification, title, cancellable: options?.cancellable !== false }, async (progress, token) => {
			const abort = new AbortController();
			if (token.isCancellationRequested) abort.abort();
			const subscription = token.onCancellationRequested(() => abort.abort());
			try {
				return await run(message => progress.report({ message }), abort.signal);
			} finally {
				subscription.dispose();
			}
		})),
		async pick<T>(items: readonly UiPickItem<T>[], options: { readonly title: string; readonly placeholder: string }, signal: AbortSignal): Promise<T | undefined> {
			const entries = items.map(item => ({
				label: `${item.icon === undefined ? "" : ICONS[item.icon]}${item.label}`,
				...(item.description === undefined ? {} : { description: item.description }),
				...(item.detail === undefined ? {} : { detail: item.detail }),
				value: item.value,
			}));
			const { token, release } = linked(signal);
			try {
				const picked = await api.window.showQuickPick(entries, { title: options.title, placeHolder: options.placeholder, ignoreFocusOut: true, matchOnDescription: true }, token);
				return picked?.value;
			} finally {
				release();
			}
		},
		async askSecret(options, signal) {
			const { token, release } = linked(signal);
			try {
				return await api.window.showInputBox({
					title: options.title,
					prompt: options.prompt,
					...(options.placeholder === undefined ? {} : { placeHolder: options.placeholder }),
					password: true,
					ignoreFocusOut: true,
				}, token);
			} finally {
				release();
			}
		},
		async confirm(message, detail, action) {
			return (await api.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
		},
		async openExternal(url) {
			try {
				return await api.env.openExternal(api.Uri.parse(url, true));
			} catch {
				return false;
			}
		},
		async copy(text) {
			await api.env.clipboard.writeText(text);
		},
		notify: (level, message, actions) => (level === "info" ? api.window.showInformationMessage(message, ...actions)
			: level === "warning" ? api.window.showWarningMessage(message, ...actions)
				: api.window.showErrorMessage(message, ...actions)) as Promise<string | undefined>,
	};
}
