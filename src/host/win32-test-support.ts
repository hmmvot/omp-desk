/**
 * Test support for the real-Windows tests of `win32-native.ts`: the addon as the build ships it
 * (the optional koffi package of this machine's architecture, as a staged asset) and a child
 * process that holds a real named kernel object. Only tests import this file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { StagedRuntimeAsset } from "./runtime-assets.ts";

/** The installed `koffi.node` for this process's architecture, with the digest staging would record. */
export async function installedAddonAsset(): Promise<StagedRuntimeAsset> {
	const file = fileURLToPath(
		new URL(`../../node_modules/@koromix/koffi-win32-${process.arch}/win32_${process.arch}/koffi.node`, import.meta.url),
	);
	return { path: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
}

const CREATE_CALLS = {
	mutex: { prototype: "void* __stdcall CreateMutexW(void* attributes, bool owner, str16 name)", call: "create(null, false, name)" },
	event: { prototype: "void* __stdcall CreateEventW(void* attributes, bool manual, bool initial, str16 name)", call: "create(null, true, false, name)" },
} as const;

/**
 * Start a Node child that creates the named mutex (never owning it), or with `kind: "event"` a named event
 * (another kind of object under the same name), and waits for its stdin to end.
 * Resolves once the object exists. Ending the stdin lets the child exit, which destroys the object.
 */
export async function holdMutex(objectName: string, kind: keyof typeof CREATE_CALLS = "mutex"): Promise<ChildProcess> {
	const addon = await installedAddonAsset();
	const { prototype, call } = CREATE_CALLS[kind];
	const script = `
		const holder = { exports: {} };
		process.dlopen(holder, ${JSON.stringify(addon.path)});
		const create = holder.exports.load("kernel32.dll").func(${JSON.stringify(prototype)});
		const name = ${JSON.stringify(objectName)};
		const handle = ${call};
		if (handle === null) { console.error("create failed"); process.exit(2); }
		console.log("ready");
		process.stdin.resume();
		process.stdin.on("end", () => process.exit(0));
	`;
	const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
	await new Promise<void>((resolve, reject) => {
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", chunk => {
			if (String(chunk).includes("ready")) resolve();
		});
		child.once("error", reject);
		child.once("exit", () => reject(new Error("the object holder exited early")));
	});
	return child;
}

/** End a {@link holdMutex} child and wait until its object is gone. */
export async function releaseMutex(child: ChildProcess): Promise<void> {
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.stdin!.end();
	await exited;
}
