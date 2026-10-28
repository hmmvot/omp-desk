/**
 * The lazily loaded terminal renderer: `media/terminal.js`, a classic script of its own.
 *
 * Neither page script (`guest.js`, `shell.js`) imports this file; a pane adds a `<script>` for it when it first shows a terminal
 * (`../lib/terminal-loader.ts`). The script publishes one global, {@link OmpTerminal}, and does nothing else on load: xterm.js and
 * its addons (about 390 KB minified) are parsed only by a page that shows a terminal.
 */
import { createTerminalRenderer } from "../lib/terminal-renderer.ts";
import { TERMINAL_CONTRACT, TERMINAL_GLOBAL, type OmpTerminal } from "./contract.ts";

const terminal: OmpTerminal = { contract: TERMINAL_CONTRACT, createTerminalRenderer };

Reflect.set(window, TERMINAL_GLOBAL, terminal);
