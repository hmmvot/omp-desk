/**
 * OMP Desk — tell the user when VS Code's own updater ended the session processes.
 *
 * Every session runs in an OMP process that a detached broker keeps alive when VS Code closes. A Terminal, folder-shell or Stats
 * broker, and a Chat broker that could not use Bun (ADR-0074), is this extension's Electron started as plain Node, so its image is
 * VS Code's own `Code.exe`. "Restart to Update" runs Inno Updater, which waits about 30 s for every `Code.exe` of the install to
 * exit, then terminates the ones still running (observed 2026-10-13: five brokers and the stats broker, VS Code 1.141.0 to
 * 1.141.1). The OMP process of each ends with its broker, so the next window relaunches the session from its file instead of
 * re-adopting it. A Chat broker on the session's `bun.exe` is not a `Code.exe` and is not in that list.
 *
 * Desk cannot prevent that, but it can recognise it: the updater writes `vscode-inno-updater-<epoch seconds>.log` in the temp
 * directory and names every pid it terminated, and the broker descriptors in Desk's storage carry the pids of the brokers. A
 * descriptor whose broker pid is in the terminated list was ended by the updater, not by Desk and not by a crash.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** What an updater log says it terminated. */
export interface UpdaterTermination {
	/** The updater's own wall-clock stamp of the termination (`Oct 13 23:03:24`), as printed. */
	readonly stamp: string;
	readonly pids: readonly number[];
}

const TERMINATING = /^(\w{3} \d{1,2} \d\d:\d\d:\d\d)\.\d+ INFO Code\.exe, pid (\d+) is still running, attempting termination$/;

/** The processes one updater log terminated, or `null` when it terminated none (a normal update closes VS Code in time). */
export function parseUpdaterLog(text: string): UpdaterTermination | null {
	const pids: number[] = [];
	let stamp = "";
	for (const line of text.split(/\r?\n/)) {
		const match = TERMINATING.exec(line);
		if (match === null) continue;
		if (stamp === "") stamp = match[1] as string;
		pids.push(Number(match[2]));
	}
	return pids.length === 0 ? null : { stamp, pids };
}

/** One broker descriptor of Desk's storage, reduced to what the notice needs. */
export interface BrokerDescriptor {
	readonly brokerPid: number;
	readonly title: string | null;
	readonly kind: string | null;
}

export interface UpdaterNoticePort {
	/** Names of the files in the temp directory that start with `vscode-inno-updater-`. */
	updaterLogNames(): Promise<readonly string[]>;
	readUpdaterLog(name: string): Promise<string | null>;
	brokerDescriptors(): Promise<readonly BrokerDescriptor[]>;
	/** The updater log this profile already announced, or `null`. */
	announced(): string | null;
	markAnnounced(name: string): Promise<void>;
	/** Milliseconds since the epoch. */
	now(): number;
	log(line: string): void;
	notify(message: string): void;
}

/** An updater log older than this is not about the windows that just opened. */
export const UPDATER_NOTICE_MAX_AGE_MS = 30 * 60_000;

const LOG_NAME = /^vscode-inno-updater-(\d+)\.log$/;

/**
 * Look for a recent updater log that terminated one of this extension's brokers; log it and tell the user once. Never throws.
 */
export async function announceUpdaterTerminations(port: UpdaterNoticePort): Promise<void> {
	try {
		const recent = (await port.updaterLogNames())
			.map(name => ({ name, startedAt: Number(LOG_NAME.exec(name)?.[1] ?? Number.NaN) * 1000 }))
			.filter(entry => Number.isFinite(entry.startedAt) && port.now() - entry.startedAt <= UPDATER_NOTICE_MAX_AGE_MS)
			.sort((a, b) => b.startedAt - a.startedAt);
		for (const entry of recent) {
			if (port.announced() === entry.name) return;
			const text = await port.readUpdaterLog(entry.name);
			const ended = text === null ? null : parseUpdaterLog(text);
			if (ended === null) continue;
			const killed = new Set(ended.pids);
			const ours = (await port.brokerDescriptors()).filter(descriptor => killed.has(descriptor.brokerPid));
			if (ours.length === 0) continue;
			const sessions = ours.filter(descriptor => descriptor.kind === "managed-rpc" || descriptor.kind === "managed-omp").length;
			port.log(`VS Code's updater (${entry.name}) terminated ${ended.pids.length} Code.exe processes at ${ended.stamp}, ${ours.length} of them background processes of this extension (pids ${ours.map(descriptor => descriptor.brokerPid).join(", ")}); the OMP processes they kept ended with them`);
			await port.markAnnounced(entry.name);
			port.notify(
				`VS Code's update ended ${sessions === 0 ? "OMP Desk's background processes" : `the ${sessions === 1 ? "process" : `${sessions} processes`} of the sessions that were running`} at ${ended.stamp.slice(-8)}: the installer stops every Code.exe of the install, and these hosts ran as Code.exe. ` +
				"Sessions that were running are resumed from their files; a turn in progress and its sub-agents did not survive. Chats whose background process runs on Bun are not stopped by an update.",
			);
			return;
		}
	} catch (error) {
		port.log(`updater notice: not checked: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The directories the notice reads: the temp directory (where Inno Updater logs) and the broker descriptors' folder. */
export interface UpdaterNoticeDirs {
	readonly tempDir: string;
	readonly ptyDir: string;
}

/** The file-system half of the port; the caller supplies what VS Code holds (the announced marker, the user notice, the log). */
export function updaterNoticeFiles(dirs: UpdaterNoticeDirs): Pick<UpdaterNoticePort, "updaterLogNames" | "readUpdaterLog" | "brokerDescriptors" | "now"> {
	return {
		updaterLogNames: async () => (await readdir(dirs.tempDir)).filter(name => LOG_NAME.test(name)),
		readUpdaterLog: name => readFile(path.join(dirs.tempDir, name), "utf8").catch(() => null),
		brokerDescriptors: async () => {
			const names = (await readdir(dirs.ptyDir).catch(() => [])).filter(name => /^pty-[0-9a-f]+\.json$/.test(name));
			const found: BrokerDescriptor[] = [];
			for (const name of names) {
				try {
					const record = JSON.parse(await readFile(path.join(dirs.ptyDir, name), "utf8")) as Record<string, unknown>;
					if (typeof record.brokerPid !== "number") continue;
					found.push({
						brokerPid: record.brokerPid,
						title: typeof record.title === "string" ? record.title : null,
						kind: typeof record.kind === "string" ? record.kind : null,
					});
				} catch {
					// A descriptor that is being written or is not ours is not evidence of anything.
				}
			}
			return found;
		},
		now: () => Date.now(),
	};
}
