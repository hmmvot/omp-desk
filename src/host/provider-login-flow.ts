/**
 * The provider login and logout flows (ADR-0070), over an editor-neutral UI port and a started login process.
 *
 * `vscode` is reached only through {@link LoginUi}, so every branch here runs under `node --test` against a
 * scripted OMP process. What reaches `log`: fixed sentences, provider ids that match OMP's id grammar, the
 * origin (never the path or query) of the sign-in address, and outcome names. Never: a frame, stderr, an
 * error string OMP produced, a provider's address, a credential label, instructions, or anything the user
 * typed into a prompt (a pasted code can complete a login: ADR-0017).
 */
import { webLinkUrl } from "../shared/terminal-links.ts";
import type { LoginProvider, LoginSession, LogoutAccount } from "./provider-login-rpc.ts";

export interface UiPickItem<T> {
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
	/** A mark the adapter draws before the label. */
	readonly icon?: "check" | "terminal";
	readonly value: T;
}

/** What the flows need from the editor. The VS Code implementation is `src/wiring/provider-login-ui.ts`. */
export interface LoginUi {
	/** A progress notification, with a Cancel button unless `cancellable` is false; `signal` aborts on Cancel. The returned promise is `run`'s. */
	withProgress<T>(title: string, run: (report: (message: string) => void, signal: AbortSignal) => Promise<T>, options?: { readonly cancellable?: boolean }): Promise<T>;
	/** A pick list; resolves with the chosen value, or `undefined` when dismissed or when `signal` aborts. */
	pick<T>(items: readonly UiPickItem<T>[], options: { readonly title: string; readonly placeholder: string }, signal: AbortSignal): Promise<T | undefined>;
	/** A masked input box that stays open when focus moves; resolves `undefined` when dismissed or when `signal` aborts. */
	askSecret(options: { readonly title: string; readonly prompt: string; readonly placeholder?: string }, signal: AbortSignal): Promise<string | undefined>;
	/** A modal confirmation; `true` only for the named action. */
	confirm(message: string, detail: string, action: string): Promise<boolean>;
	openExternal(url: string): Promise<boolean>;
	copy(text: string): Promise<void>;
	/** A notification; resolves with the chosen action, or `undefined` when it is dismissed. */
	notify(level: "info" | "warning" | "error", message: string, actions: readonly string[]): Promise<string | undefined>;
}

export interface LoginFlowDeps {
	readonly ui: LoginUi;
	/** Start the login process in the caller's scope. Rejects with a `LoginStartError`; aborting `signal` ends it. */
	start(signal: AbortSignal): Promise<LoginSession>;
	/** The explicit fallback: a visible `omp login [providerId]` terminal the extension reads nothing from. */
	openTerminal(providerId: string | undefined): void;
	/** A credential was added or removed: re-read model availability. */
	credentialsChanged(): void;
	log(message: string): void;
	/** Ends everything this flow has running (the window closing). */
	readonly signal: AbortSignal;
	/** Timers for the browser settle window; the real ones when omitted. */
	readonly timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

/** `terminal`: the user chose the terminal login from the picker. `declined`: the provider needs input VS Code does not take (an API key), and the notice offers the terminal. */
export type LoginOutcome = "signed-in" | "cancelled" | "terminal" | "declined" | "failed";

/** The one line that tells where API keys go; OMP's own `/login` takes them (slash-commands/builtin-session.ts). */
export const API_KEY_HINT = "API-key providers: run `omp` in a terminal and use /login";
const TERMINAL_ACTION = "Open Terminal Login";
const GENERIC_FAILURE_ACTION = "Try in Terminal";

/**
 * What OMP says when it wants a pasted authorization code or redirect URL (pi-ai `auth/oauth.ts`, `cli/oauth-terminal.ts`).
 * Every other input prompt a login sends (OMP 18.10.3: "Paste your X API key", a token, an account id) is not a browser sign-in:
 * API keys are entered in a terminal OMP, so such a prompt ends the login before anything was typed.
 */
const PASTED_CODE_PROMPT = /authori[sz]ation code|redirect url/i;

/**
 * OMP sends the sign-in address first and, for a provider that takes a key, the key prompt in the same tick. The browser is
 * opened once a pasted-code prompt arrives, or when no prompt has followed after this long: a provider that takes a key
 * never opens its dashboard page for nothing.
 */
export const OPEN_SETTLE_MS = 400;

const REAL_TIMERS = { setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms), clearTimeout: (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout) };

type ProviderChoice = { readonly kind: "provider"; readonly provider: LoginProvider } | { readonly kind: "terminal" };

/**
 * A warning with one terminal action. Not awaited: a notification that auto-hides stays pending until the user finds it,
 * and the window's guard and the OMP process must not wait for that.
 */
function offerTerminal(deps: LoginFlowDeps, message: string, action: string, providerId: string | undefined): void {
	void deps.ui.notify("warning", message, [action]).then(picked => { if (picked === action) deps.openTerminal(providerId); }).catch(() => undefined);
}

/** A provider id is logged only when it matches OMP's id grammar; an extension-registered id of any other shape is not. */
function safeId(id: string): string {
	return /^[A-Za-z0-9._-]{1,80}$/.test(id) ? id : "?";
}

interface Started {
	readonly session: LoginSession;
	readonly providers: readonly LoginProvider[];
}

/** Start OMP and read its providers under one cancellable progress notification. `null`: cancelled or failed (already reported). */
async function startAndList(deps: LoginFlowDeps, title: string): Promise<Started | null | "cancelled"> {
	const cancelled = new AbortController();
	let session: LoginSession | null = null;
	try {
		return await deps.ui.withProgress(title, async (report, signal) => {
			report("Starting OMP…");
			const abort = AbortSignal.any([signal, deps.signal]);
			abort.addEventListener("abort", () => cancelled.abort(), { once: true });
			session = await deps.start(abort);
			const providers = await session.providers();
			if (abort.aborted) throw new Error("cancelled");
			return { session, providers };
		});
	} catch {
		(session as LoginSession | null)?.dispose();
		if (cancelled.signal.aborted || deps.signal.aborted) return "cancelled";
		deps.log("provider login: OMP could not be started or did not list its providers");
		offerTerminal(deps, "OMP could not be started for provider login.", TERMINAL_ACTION, undefined);
		return null;
	}
}

/** Sign in to one OAuth provider; every outcome is reported to the user here. */
export async function runProviderLogin(deps: LoginFlowDeps, options: { readonly providerId?: string } = {}): Promise<LoginOutcome> {
	const started = await startAndList(deps, "Log In to Provider");
	if (started === "cancelled") return "cancelled";
	if (started === null) return "failed";
	const { session, providers } = started;
	try {
		const preselected = options.providerId === undefined ? undefined : providers.find(provider => provider.available && provider.id === options.providerId);
		if (preselected !== undefined) return await signIn(deps, session, preselected);
		const items: UiPickItem<ProviderChoice>[] = providers.filter(provider => provider.available).map(provider => ({
			label: provider.name,
			description: provider.authenticated ? `signed in · ${provider.id}` : provider.id,
			...(provider.authenticated ? { icon: "check" as const } : {}),
			value: { kind: "provider", provider },
		}));
		items.push({ label: "Other providers", description: API_KEY_HINT, icon: "terminal", value: { kind: "terminal" } });
		const choice = await deps.ui.pick(items, { title: "Log In to Provider", placeholder: `Sign in to an OAuth provider · ${API_KEY_HINT}` }, deps.signal);
		if (choice === undefined) return "cancelled";
		if (choice.kind === "terminal") {
			deps.log("provider login: the user chose the terminal login");
			deps.openTerminal(undefined);
			return "terminal";
		}
		return await signIn(deps, session, choice.provider);
	} finally {
		await session.close();
	}
}

async function signIn(deps: LoginFlowDeps, session: LoginSession, provider: LoginProvider): Promise<LoginOutcome> {
	const id = safeId(provider.id);
	const timers = deps.timers ?? REAL_TIMERS;
	let userCancelled = false;
	let unsafeAddress = false;
	let declined = false;
	/** The sign-in address OMP sent, held until it is clear no key prompt follows it. */
	const held: { current: { address: string; instructions: string | undefined; timer: unknown } | null } = { current: null };
	const result = await deps.ui.withProgress(`Signing in to ${provider.name}`, async (report, signal) => {
		const abort = AbortSignal.any([signal, deps.signal]);
		abort.addEventListener("abort", () => { userCancelled = true; session.dispose(); }, { once: true });
		report("Starting the sign-in…");
		deps.log(`provider login: signing in to ${id}`);
		const openBrowser = (): void => {
			const pending = held.current;
			if (pending === null) return;
			held.current = null;
			timers.clearTimeout(pending.timer);
			const url = new URL(pending.address);
			deps.log(`provider login: opening ${url.origin} in the external browser`);
			report(`Complete the sign-in in your browser (${url.host}).${pending.instructions === undefined ? "" : ` ${pending.instructions}`}`);
			void deps.ui.openExternal(pending.address).then(async opened => {
				if (opened || session.closed) return;
				deps.log("provider login: the browser could not be opened");
				const picked = await deps.ui.notify("warning", "The browser could not be opened. Copy the sign-in link and open it yourself.", ["Copy Link"]);
				if (picked === "Copy Link") await deps.ui.copy(pending.address);
			}).catch(() => undefined);
		};
		try {
			return await session.login(provider.id, {
				openUrl: request => {
					const address = webLinkUrl(request.url);
					if (address === null) {
						unsafeAddress = true;
						deps.log("provider login: OMP asked to open an address that is not a web link; nothing was opened");
						session.dispose();
						return;
					}
					if (held.current !== null) timers.clearTimeout(held.current.timer);
					held.current = { address, instructions: request.instructions, timer: timers.setTimeout(openBrowser, OPEN_SETTLE_MS) };
				},
				prompt: (prompt, promptSignal) => {
					if (!PASTED_CODE_PROMPT.test(prompt.title)) {
						declined = true;
						deps.log(`provider login: ${id} asks for input other than a pasted sign-in code`);
						session.dispose();
						return Promise.resolve(undefined);
					}
					openBrowser();
					return deps.ui.askSecret({
						title: `Log In to ${provider.name}`,
						prompt: prompt.title,
						...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
					}, promptSignal);
				},
				progress: report,
				cancelled: () => { userCancelled = true; session.dispose(); },
			});
		} finally {
			if (held.current !== null) timers.clearTimeout(held.current.timer);
			held.current = null;
		}
	});
	const cancelled = userCancelled || deps.signal.aborted;
	// OMP stores a credential before it refreshes the provider online, so a login that ended any other way after it was
	// started can still have left one: the models are re-read unless OMP refused or the flow declined before anything was stored.
	if (result.kind === "signed-in" || (!declined && (result.kind === "failed" || result.kind === "closed"))) deps.credentialsChanged();
	if (result.kind === "signed-in") {
		deps.log(`provider login: signed in to ${id}`);
		void deps.ui.notify("info", `Signed in to ${provider.name}.`, []);
		return "signed-in";
	}
	if (declined || result.kind === "refused") {
		deps.log(`provider login: ${id} needs input this window cannot take`);
		offerTerminal(deps, `${provider.name} cannot sign in from VS Code: it asks for something other than a browser sign-in. ${API_KEY_HINT}.`, TERMINAL_ACTION, provider.id);
		return "declined";
	}
	if (result.kind === "unknown-provider") {
		deps.log(`provider login: OMP does not know ${id}`);
		void deps.ui.notify("warning", `OMP no longer lists ${provider.name}.`, []);
		return "failed";
	}
	if (cancelled) {
		deps.log(`provider login: ${id} was cancelled`);
		return "cancelled";
	}
	deps.log(`provider login: signing in to ${id} did not complete`);
	const message = unsafeAddress
		? `Signing in to ${provider.name} did not complete: OMP gave an address that is not a web link, so nothing was opened.`
		: `Signing in to ${provider.name} did not complete.`;
	offerTerminal(deps, message, GENERIC_FAILURE_ACTION, provider.id);
	return "failed";
}

/** Remove one stored credential: a provider, then one of its accounts, then a confirmation. */
export async function runProviderLogout(deps: LoginFlowDeps): Promise<"logged-out" | "cancelled" | "failed" | "nothing"> {
	const started = await startAndList(deps, "Log Out of Provider");
	if (started === "cancelled") return "cancelled";
	if (started === null) return "failed";
	const { session, providers } = started;
	try {
		const signedIn = providers.filter(provider => provider.authenticated);
		if (signedIn.length === 0) {
			void deps.ui.notify("info", "No provider is signed in. A key OMP reads from an environment variable or its configuration is removed at that source.", []);
			return "nothing";
		}
		const provider = await deps.ui.pick(
			signedIn.map(entry => ({ label: entry.name, description: entry.id, value: entry })),
			{ title: "Log Out of Provider", placeholder: "Provider to remove a stored sign-in from" },
			deps.signal,
		);
		if (provider === undefined) return "cancelled";
		const id = safeId(provider.id);
		let accounts: LogoutAccount[];
		try {
			accounts = await deps.ui.withProgress("Log Out of Provider", async report => {
				report(`Reading the stored accounts of ${provider.name}…`);
				return await session.logoutAccounts(provider.id);
			}, { cancellable: false });
		} catch {
			deps.log(`provider login: the stored accounts of ${id} could not be read`);
			void deps.ui.notify("warning", `The stored accounts of ${provider.name} could not be read.`, []);
			return "failed";
		}
		if (accounts.length === 0) {
			void deps.ui.notify("info", `${provider.name} has no stored credential: it signs in through an environment variable or OMP's configuration, which is removed at that source.`, []);
			return "nothing";
		}
		const account = await deps.ui.pick(
			accounts.map(entry => ({
				label: entry.label.length > 0 ? entry.label : `Credential ${entry.credentialId}`,
				description: `${entry.type === "oauth" ? "OAuth" : "API key"}${entry.active ? " · active" : ""}`,
				...(entry.detail.length > 0 ? { detail: entry.detail } : {}),
				value: entry,
			})),
			{ title: `Log Out of ${provider.name}`, placeholder: "Account to log out" },
			deps.signal,
		);
		if (account === undefined) return "cancelled";
		const who = account.label.length > 0 ? account.label : `credential ${account.credentialId}`;
		const confirmed = await deps.ui.confirm(
			`Log out of ${provider.name}?`,
			`${who}${account.detail.length > 0 ? `\n${account.detail}` : ""}\n\nThis removes the stored credential from OMP. Sessions that use it stop being able to call this provider.`,
			"Log Out",
		);
		if (!confirmed) return "cancelled";
		try {
			const removed = await deps.ui.withProgress("Log Out of Provider", async report => {
				report(`Removing the credential of ${provider.name}…`);
				return await session.logout(provider.id, account.credentialId);
			}, { cancellable: false });
			deps.log(`provider login: removed a stored credential of ${id}`);
			deps.credentialsChanged();
			// An account label is chosen by whoever owns the account: no markup characters in a notification.
			const plain = (text: string): string => text.replace(/[\[\]]/g, " ");
			void deps.ui.notify("info", `Logged out of ${provider.name} (${plain(who)}).${removed.remainingSource === undefined ? "" : ` ${provider.name} still signs in through ${plain(removed.remainingSource)}.`}`, []);
			return "logged-out";
		} catch {
			deps.log(`provider login: a stored credential of ${id} could not be removed`);
			// A timed-out or closed request may still have removed it.
			deps.credentialsChanged();
			void deps.ui.notify("warning", `The credential of ${provider.name} could not be removed.`, []);
			return "failed";
		}
	} finally {
		await session.close();
	}
}
