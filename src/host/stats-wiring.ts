import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import type { PtyBrokerClient } from "./pty-client";
import { resolveOmpBinary, runOmpCli } from "./native-terminal";
import { admitStatsLaunch, ensureStatsDashboard, probeStatsDashboard, statsPreloadSupported, STATS_ORIGIN, withStatsLaunchLock } from "./stats-dashboard";
import { statsWebviewHtml } from "./stats-webview";
import { isPtyProcessAlive, queryPtyProcessIdentity, waitForPtyProcessGone } from "./pty-identity";
import { stageRuntimeAssets, verifyStagedRuntimeAsset } from "../runtime-assets";

export function registerStatsDashboard(context: vscode.ExtensionContext, deps: {
	client(): Promise<PtyBrokerClient | null>;
	log(message: string): void;
}): void {
	let panel: vscode.WebviewPanel | undefined;
	let opening: Promise<void> | undefined;
	let disposed = false;
	const unchangedOpeners = new Set<string>();
	const open = async (): Promise<void> => {
		let binaryKey: string | null = null;
		const client = await deps.client();
		if (client === null) throw new Error("Background process support is unavailable. Reload the window and try Open Stats again.");
		const opened = await ensureStatsDashboard({
			client,
			withLaunchLock: work => withStatsLaunchLock(context.globalStorageUri.fsPath, work),
			brokerAlive: isPtyProcessAlive,
			async brokerGone(record) {
				const ready = await client.attachReady();
				if (ready.helper === null) return false;
				const reading = await queryPtyProcessIdentity(ready.helper, record.brokerPid);
				return reading.kind === "gone" || (reading.kind === "found" && reading.creationTime !== record.brokerCreationTime);
			},
			async retireExited(handle) {
				if (!(await handle.shutdown({ requireStopped: true })).stopped) throw new Error("The exited Stats background process could not close. Use Stop in Processes and try again.");
				const ready = await client.attachReady();
				if (ready.helper === null) throw new Error("The Stats background process could not be confirmed closed. Use Stop in Processes and try again.");
				const gone = await waitForPtyProcessGone(ready.helper, handle.brokerPid, handle.record.brokerCreationTime, 10_000);
				if (!gone.gone) throw new Error("The Stats background process is still closing. Use Stop in Processes and try again.");
			},
			async resolveLaunch() {
				const binary = await resolveOmpBinary();
				binaryKey = JSON.stringify([binary.command, binary.prefixArgs, binary.version]);
				let preload: string | null = null;
				if (!unchangedOpeners.has(binaryKey)) {
					try {
						const [asset] = await stageRuntimeAssets({
							storageDir: context.globalStorageUri.fsPath,
							sourcePaths: [vscode.Uri.joinPath(context.extensionUri, "media", "stats-opener.mjs").fsPath],
						});
						if (asset !== undefined && await verifyStagedRuntimeAsset(asset)) {
							const probe = await runOmpCli({ command: binary.command, prefixArgs: ["--preload", asset.path, ...binary.prefixArgs] }, ["--version"], 5_000, { cwd: os.homedir() });
							if (statsPreloadSupported(probe)) preload = asset.path;
						}
					} catch { deps.log("stats: browser-opener preload capability was not established"); }
				}
				if (preload !== null) deps.log("stats: browser-opener preload capability verified");
				return await admitStatsLaunch(binary, os.homedir(), preload, async () => {
					const start = await vscode.window.showInformationMessage("This OMP build opens the dashboard in your browser as well. Start it?", { modal: true }, "Start");
					if (start !== "Start") return false;
					deps.log("stats: user admitted this build's native one-time browser opening");
					return true;
				});
			},
			async observeOpener(handle) {
				try {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 250);
					await promise;
					const snapshot = await handle.snapshot();
					if (binaryKey !== null && snapshot.data.includes("OMP_DESK_STATS_OPENER_UNCHANGED") && !snapshot.data.includes("OMP_DESK_STATS_OPENER_SUPPRESSED")) unchangedOpeners.add(binaryKey);
					deps.log(snapshot.data.includes("OMP_DESK_STATS_OPENER_SUPPRESSED")
						? "stats: the exact dashboard browser opener was suppressed"
						: "stats: browser-opener suppression was not observed; native browser opening may have occurred");
				} catch { deps.log("stats: browser-opener suppression could not be observed"); }
			},
			probe: probeStatsDashboard, now: Date.now,
			wait: ms => {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, ms);
				return promise;
			},
		});
		if (!opened || disposed) return;
		if (panel !== undefined) { panel.reveal(); return; }
		const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`${STATS_ORIGIN}/`));
		if (disposed) return;
		panel = vscode.window.createWebviewPanel("omp.stats", "OMP Stats", vscode.ViewColumn.Active, {
			enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [],
		});
		panel.iconPath = new vscode.ThemeIcon("graph");
		panel.webview.html = statsWebviewHtml(uri.toString(), randomBytes(16).toString("hex"));
		panel.onDidDispose(() => { panel = undefined; });
	};
	context.subscriptions.push(
		vscode.commands.registerCommand("omp.openStats", () => {
			if (opening !== undefined) return opening;
			opening = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Opening OMP Stats", cancellable: false }, open))
				.then(() => undefined, (error: unknown) => {
					const message = error instanceof Error ? error.message : "The Stats dashboard could not be opened. See OMP Desk output.";
					deps.log(`stats: ${message}`);
					void vscode.window.showErrorMessage(`OMP: ${message}`);
				}).finally(() => { opening = undefined; void vscode.commands.executeCommand("omp.refreshProcesses"); });
			return opening;
		}),
		{ dispose: () => { disposed = true; panel?.dispose(); } },
	);
}
