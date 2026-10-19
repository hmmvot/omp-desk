/**
 * The colours of the magic keyword gradient: `::highlight(omp-magic-<id>-<stop>)` for every keyword and stop (`lib/magic-keyword-paint.ts`
 * fills them). OMP's hue sweep, with each stop's lightness solved per theme kind so the word reads as well as ordinary text
 * (`shared/magic-colour.ts`): the dark palette is the base, the other kinds follow the body class VS Code gives its theme.
 *
 * A highlight can only change colours, underline and shadow, so the keyword keeps its size and weight and nothing moves: the
 * layout and the caret are untouched. Colour alone is not a signal in High Contrast or under forced colours: there the keyword is
 * underlined as well.
 */
import { magicGradient, MAGIC_THEME_KINDS, type MagicThemeKind } from "../shared/magic-colour.ts";
import { MAGIC_GRADIENT_STOPS, MAGIC_KEYWORDS } from "../shared/magic-keywords.ts";
import { magicHighlightName } from "./lib/magic-keyword-paint.ts";

/** The selector prefix of a theme kind: the dark palette is the base every other kind overrides. */
const THEME_SELECTOR: Readonly<Record<MagicThemeKind, string>> = {
	dark: "",
	light: ".vscode-light ",
	"high-contrast": ".vscode-high-contrast ",
	"high-contrast-light": ".vscode-high-contrast-light ",
};

const UNDERLINED_KINDS: ReadonlySet<MagicThemeKind> = new Set(["high-contrast", "high-contrast-light"]);

/** Every highlight of every keyword, for the forced-colours rule. */
const ALL_HIGHLIGHTS = MAGIC_KEYWORDS.flatMap(keyword => Array.from({ length: MAGIC_GRADIENT_STOPS }, (_, stop) => `::highlight(${magicHighlightName(keyword.id, stop)})`));

function themeRules(): string {
	const rules: string[] = [];
	for (const kind of MAGIC_THEME_KINDS) {
		const underline = UNDERLINED_KINDS.has(kind) ? " text-decoration: underline;" : "";
		for (const keyword of MAGIC_KEYWORDS) {
			magicGradient(keyword, kind).forEach((colour, stop) => {
				rules.push(`${THEME_SELECTOR[kind]}::highlight(${magicHighlightName(keyword.id, stop)}) { color: ${colour};${underline} }`);
			});
		}
	}
	return rules.join("\n");
}

export const MAGIC_KEYWORD_STYLES = `
${themeRules()}
@media (forced-colors: active) {
${ALL_HIGHLIGHTS.join(",\n")} { text-decoration: underline; }
}
`;
