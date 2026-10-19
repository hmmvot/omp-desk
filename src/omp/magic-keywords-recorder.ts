import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ompDependencyRoot } from "../shared/omp-package-layout.ts";
import { buildCorpus } from "./magic-keywords-corpus.ts";

/**
 * Test support, run by Bun: writes what the installed OMP's magic keywords do, as one JSON document on stdout, every answer
 * computed by OMP's own code: its keyword table and `magicKeywords.*` settings, the shimmer constants of its editor, what its
 * matcher and its Markdown/HTML mask say about every text of the corpus, and the colours its gradient paints.
 * `src/omp/fixtures/omp-magic-keywords.json` is a committed recording of it, so `src/shared/magic-keywords.ts` is tested against OMP's
 * answers without OMP installed; `magic-keywords.live.test.ts` records the installed OMP again and fails when the two differ, which
 * is how a changed OMP is noticed.
 */
const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("Usage: bun magic-keywords-recorder.ts <pi-coding-agent root>");
// The gradient paints for the active colour mode: pin it to truecolor before the first palette is built.
process.env.WT_SESSION = "magic-keywords-recorder";

const tuiRoot = ompDependencyRoot(packageRoot, "pi-tui");
const load = async (root: string, relative: string): Promise<Record<string, unknown>> => await import(pathToFileURL(path.join(root, relative)).href) as Record<string, unknown>;

interface OmpKeyword { id: string; word: string; hue: readonly [number, number]; requires: readonly string[] }
interface OmpSetting { id: string; type: string; default: unknown }
const table = await load(packageRoot, "src/modes/magic-keywords.ts") as unknown as { MAGIC_KEYWORDS: readonly OmpKeyword[] };
const all = await load(packageRoot, "src/config/all-settings.ts") as unknown as { orderedSettings(): readonly OmpSetting[] };
const engine = await load(tuiRoot, "src/prompt/magic-keywords.ts") as unknown as {
  setMagicKeywords(specs: readonly OmpKeyword[]): void;
  magicKeywordRanges(text: string): { from: number; to: number }[];
  containsMagicKeyword(text: string, word: string): boolean;
  hasMagicKeyword(text: string): boolean;
  highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string;
};
const prose = await load(tuiRoot, "src/prompt/markdown-prose.ts") as unknown as { maskNonProse(text: string): string };
const version = (JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version: string }).version;

/** OMP registers its whole table with the editor at startup (`interactive-mode.ts`, `startup-composer.ts`). */
engine.setMagicKeywords(table.MAGIC_KEYWORDS);

/** The editor's shimmer constants are `static readonly` members of its class, not exports: read them from the source and fail loudly when the source stops saying them. */
const editorSource = await readFile(path.join(tuiRoot, "src/prompt/custom-editor.ts"), "utf8");
function shimmerConstant(name: string): number {
  const match = new RegExp(`static readonly ${name}\\s*=\\s*(\\d+)\\s*;`).exec(editorSource);
  if (!match) throw new Error(`custom-editor.ts no longer declares "static readonly ${name} = <number>;"`);
  return Number(match[1]);
}

/** Per text: OMP's ranges as `[from, to]` pairs, its mask (left out when it changes nothing), `hasMagicKeyword`, and the table words `containsMagicKeyword` accepts as standalone prose. */
const corpus = buildCorpus().map(text => {
  const masked = prose.maskNonProse(text);
  const contains = table.MAGIC_KEYWORDS.map(keyword => keyword.word).filter(word => engine.containsMagicKeyword(text, word));
  return { text, ranges: engine.magicKeywordRanges(text).map(({ from, to }) => [from, to]), ...(masked === text ? {} : { masked }), has: engine.hasMagicKeyword(text), contains };
});

type Rgb = [number, number, number];
const SGR = /\x1b\[38;2;(\d+);(\d+);(\d+)m|\x1b|([\s\S])/gu;
/** The colour OMP's gradient gave each character of `word` at `phase`, read back from the escape sequences it wrote. */
function paint(word: string, phase: number): Rgb[] {
  const painted = engine.highlightMagicKeywords(word, "", phase);
  const colors: Rgb[] = [];
  let current: Rgb | undefined;
  for (const match of painted.matchAll(SGR)) {
    if (match[0] === "\x1b") throw new Error(`Unexpected escape sequence in ${JSON.stringify(painted)}: the gradient is no longer 24-bit foreground colours`);
    if (match[4] === undefined) { current = [Number(match[1]), Number(match[2]), Number(match[3])]; continue; }
    if (!current) throw new Error(`Character before any colour in ${JSON.stringify(painted)}`);
    colors.push(current);
  }
  if (colors.length !== word.length) throw new Error(`Painted ${colors.length} characters of ${JSON.stringify(word)}`);
  return colors;
}

const STOPS = 14;
const PHASES = [0, 0.1, 0.25, 0.5, 0.77, 0.999];
const gradient = table.MAGIC_KEYWORDS.map(keyword => ({
  word: keyword.word,
  /** The colour of stop `s`: the first character sits on stop `s` at phase `(s + 0.5) / 14`, so OMP's own painting yields every stop whatever the word's length. */
  palette: Array.from({ length: STOPS }, (_, stop) => paint(keyword.word, (stop + 0.5) / STOPS)[0]!),
  paintings: PHASES.map(phase => ({ phase, colors: paint(keyword.word, phase) })),
}));

const recording = {
  version,
  keywords: table.MAGIC_KEYWORDS.map(({ id, word, hue, requires }) => ({ id, word, hue, requires })),
  settings: all.orderedSettings()
    .filter(setting => setting.id === "magicKeywords.enabled" || setting.id.startsWith("magicKeywords."))
    .map(({ id, type, default: value }) => ({ id, type, default: value })),
  shimmer: { frameMs: shimmerConstant("SHIMMER_FRAME_MS"), periodMs: shimmerConstant("SHIMMER_PERIOD_MS") },
  corpus,
  gradient: { stops: STOPS, keywords: gradient },
};
process.stdout.write(JSON.stringify(recording));
