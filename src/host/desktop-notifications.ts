import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { notificationLine } from "./notification-text.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

export interface DesktopNotification {
	readonly title: string;
	readonly body: string;
	readonly launchUri: string;
}

export interface DesktopNotificationIdentity {
	readonly appId: string;
	readonly tag: string;
	readonly group: string;
}

/** Registered Start application identity, proved against Windows toast history. */
export const WINDOWS_TOAST_APP_ID = "Microsoft.VisualStudioCode";
export const WINDOWS_TOAST_GROUP = "omp-vscode";


function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, character => {
		switch (character) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			case "\"": return "&quot;";
			default: return "&apos;";
		}
	});
}

/** Terminal/user text stays text even if it contains markup or PowerShell syntax. */
export function desktopToastXml(notification: DesktopNotification): string {
	return `<toast activationType="protocol" launch="${escapeXml(notification.launchUri)}"><visual><binding template="ToastGeneric"><text>${escapeXml(notificationLine(notification.title, 120) || "Untitled session")}</text><text>${escapeXml(notificationLine(notification.body))}</text></binding></visual></toast>`;
}

// This is executable source, not a template for event data. EncodedCommand avoids
// Windows PowerShell's legacy decoding of UTF-8 script files; stdin is explicit UTF-8.
const WINDOWS_TOAST_SCRIPT = `$ErrorActionPreference = 'Stop'
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false, $true), $false)
try { $request = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml($request.xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = $request.tag
$toast.Group = $request.group
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($request.appId).Show($toast)
`;

const ENCODED_TOAST_SCRIPT = Buffer.from(WINDOWS_TOAST_SCRIPT, "utf16le").toString("base64");

/** Submit to Windows only; a successful return is submission, not presentation proof. */
export async function sendDesktopNotification(
	notification: DesktopNotification,
	log: (message: string) => void,
): Promise<DesktopNotificationIdentity | null> {
	if (process.platform !== "win32") {
		log("Desktop notifications are unavailable on this platform (Windows only).");
		return null;
	}
	const identity: DesktopNotificationIdentity = {
		appId: WINDOWS_TOAST_APP_ID,
		tag: randomUUID().replaceAll("-", "").slice(0, 16),
		group: WINDOWS_TOAST_GROUP,
	};
	await new Promise<void>((resolve, reject) => {
		const child = spawn(windowsPowerShellExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_TOAST_SCRIPT], {
			windowsHide: true,
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
			env: windowsPowerShellEnvironment(),
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Windows desktop notification timed out."));
		}, 10_000);
		timer.unref();
		child.once("error", () => {
			clearTimeout(timer);
			reject(new Error("Windows desktop notification process could not start."));
		});
		child.once("exit", code => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error("Windows desktop notification could not be submitted."));
		});
		child.stdin.once("error", () => {
			child.kill();
			clearTimeout(timer);
			reject(new Error("Windows desktop notification data could not be delivered."));
		});
		child.stdin.end(JSON.stringify({ ...identity, xml: desktopToastXml(notification) }), "utf8");
	});
	return identity;
}
