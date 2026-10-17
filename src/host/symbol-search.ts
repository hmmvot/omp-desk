import { parseCodeSymbol, type CodeSymbol } from "../shared/code-symbols.ts";
import { normalizeSymbolQuery } from "../shared/selection-query.ts";
import type { SymbolScope } from "./link-scope.ts";
import type { SymbolEntry, SymbolFind } from "./symbol-links.ts";
import { symbolTarget } from "./symbol-links.ts";
import type { TerminalFileLocation } from "./terminal-links.ts";

/** One definition offered when a qualified name has several. */
export interface SymbolChoice {
	/** The declaration's name as the provider gave it. */
	readonly label: string;
	/** Its container, as the provider gave it. */
	readonly description: string;
	/** Its file with the line, relative to the session folder inside it. */
	readonly detail: string;
	readonly entry: SymbolEntry;
}

/** What the symbol search needs of the window: the link resolver's own lookup, the places a symbol is shown, and VS Code's picker and Quick Open. */
export interface SymbolSearchHost {
	/** Every definition a qualified name has (the chat links' lookup: the last segment is asked, the qualifier and the type hierarchy filter). */
	find(symbol: CodeSymbol, scope: SymbolScope): Promise<SymbolFind>;
	/** Show a file at a position. */
	open(location: TerminalFileLocation): Promise<void>;
	/** Let the user choose one definition; `undefined` when dismissed. */
	pick(choices: readonly SymbolChoice[]): Promise<SymbolEntry | undefined>;
	/** VS Code's Quick Open with `value` typed (`#Name` is its workspace symbol search). */
	quickOpen(value: string): Promise<void>;
}

/**
 * The symbol search (Ctrl+N) of a selection in a Chat page. VS Code's own `#` search cannot take `Type.Member`: it passes the
 * whole text to the providers but scores only the symbol's bare name against it, so a dotted query lists nothing. A qualified
 * selection is therefore asked of the same lookup that makes a chat link: one definition opens at its position, several are
 * chosen from, and when there is none (or the lookup cannot answer) the Quick Open gets the last segment, which lists every
 * definition of the name. A name without a qualifier, and a selection that is not a code symbol, go to Quick Open as typed.
 */
export async function searchSymbol(selection: string, scope: SymbolScope, host: SymbolSearchHost): Promise<void> {
	const query = normalizeSymbolQuery(selection);
	const symbol = parseCodeSymbol(query);
	if (symbol === null || symbol.segments.length < 2) {
		await host.quickOpen(`#${query}`);
		return;
	}
	const found = await host.find(symbol, scope);
	if (found.state !== "matches") {
		await host.quickOpen(`#${symbol.last}`);
		return;
	}
	const [only, ...others] = found.entries;
	const chosen = only !== undefined && others.length === 0 ? only : await host.pick(found.entries.map(entry => choiceOf(entry, scope.cwd)));
	if (chosen === undefined) return;
	await host.open(locationOf(chosen));
}

/** The list item of one definition. */
export function choiceOf(entry: SymbolEntry, cwd: string): SymbolChoice {
	return { label: entry.name, description: entry.container, detail: symbolTarget(entry, cwd), entry };
}

function locationOf(entry: SymbolEntry): TerminalFileLocation {
	return { path: entry.path, line: Math.max(entry.line, 1), column: Math.max(entry.column, 1) };
}
