/**
 * Folder-shell editor entry point.
 *
 * Runs inside the VS Code Webview produced for a folder's `Open Terminal` editor. It
 * injects the nonce-stamped stylesheet, announces itself, and mounts the shell view. It holds
 * no relay and no bridge: a shell editor is panel-only, so its document needs no
 * `connect-src` origin at all, and a page whose extension host is gone says so instead
 * of pretending its screen is live.
 */
import { createRoot } from "react-dom/client";
import { guestTransport, readCspNonce } from "../bridge";
import { ShellView } from "../components/ShellView";
import { adoptNonceForCreatedStyles } from "../lib/nonce-styles";
import { injectShellStyles } from "../lib/terminal-styles";

function boot(): void {
	const nonce = readCspNonce();
	// Installed before any renderer exists: the terminal renderer creates its own style
	// elements at runtime, and the document's policy allows a style element only when it
	// carries this document's nonce.
	adoptNonceForCreatedStyles(nonce);
	injectShellStyles(nonce);
	// No ticket: a shell document carries no bridge identity, so this is the plain
	// announcement that lets the host address the page it created.
	guestTransport.announce();
	const container = document.getElementById("root");
	if (container === null) throw new Error("shell container element is missing");
	createRoot(container).render(<ShellView />);
}

boot();
