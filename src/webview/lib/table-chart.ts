/**
 * The chart Chat draws under a table of numbers in an assistant reply: which tables get one, what it plots, and where every mark of it
 * lies. Pure (no DOM, no React): `components/TableChart.tsx` only turns the layout into SVG.
 *
 * It is a port of OMP's terminal UI path for `tui.autoGraph: always` (`pi-tui` `charts/table-data.ts` — cell reading and column roles —
 * and `charts/chart-plan.ts` — `guessShape`, `buildChart`, `worthCharting`), written for the common kinds only: a single series as
 * **bar**, two or three same-unit measures as **grouped** bars, an ordered x axis (a date or time column, a monotonic `Run 1…`, `Day 2`,
 * `Q3`, `#12`, `v1.2.3` or month-name label column, ordered step values) with four or more rows as **line** of up to six series. Anything
 * the TUI would draw in another kind (stacked, share, heatmap, waterfall, timeline, ladder, bullet, scatter, histogram, slope, range,
 * butterfly, dots, paired and change charts, diverging bars, small multiples) is *not* drawn here: the detectors below recognise the
 * usual triggers of those kinds and answer `null`, so Chat shows fewer charts than the TUI, never different ones.
 *
 * What it reads as a number: `1,200`, `12.5%`, `$3.40`, `250 ms`, `1.2k`, `3 GB`, `~5`, `<5`, `+4`, `−3`, `1m 56s`; a range `5–9` and an
 * arrow `12 → 15` are read at their start. What it is not: missing marks (`-`, `—`, `n/a`, `tbd`…), dates, clock times (read as a
 * duration beside other durations), versions, ids (`#12`, a hex hash, a number of seven or more digits without separators — the
 * TUI reads those as hashes —, a zero-padded number), fractions and slash lists (`12/20`, `79 / 124 µs`), sums (`a + b`) and
 * numbers followed by prose. Deliberately skipped, because their only effect in the TUI is another chart kind or a polish this
 * port has no use for: side-by-side folded tables, slash-list rows, outline fill-down, restated (proportional or running-total)
 * columns, score columns, histogram bins, targets read from cell text, interval and `smart` model-picked charts.
 *
 * Limits, all quiet "no chart": more than {@link MAX_ROWS} rows (a chart of a truncated table would misstate it), fewer than four
 * categories after summary rows are set aside, more than {@link MAX_BAR_ROWS} bars. Columns beyond {@link MAX_COLUMNS} are not read.
 * Every input is untrusted model output: nothing here throws, and the work is bounded by the caps above and by cell length.
 */

export type ChartKind = "bar" | "grouped" | "line";
export interface ChartSeries {
	readonly name: string;
	readonly values: readonly (number | null)[];
}
export interface ChartSpec {
	readonly kind: ChartKind;
	/** What the chart is about, `Tokens by Model`. */
	readonly title: string;
	readonly categories: readonly string[];
	readonly series: readonly ChartSeries[];
	/** The unit written after (`%`, `ms`, `GB`) or before (`$`) a value on the ticks and labels; `""` for a plain count. */
	readonly unit: string;
	/** The one-line description for assistive technology. */
	readonly alt: string;
}

/** Most data rows read; a bigger table gets no chart. */
export const MAX_ROWS = 200;
/** Most columns read. */
export const MAX_COLUMNS = 24;
/** Most characters of a cell, header or label read: bounds every pattern below. */
const MAX_CELL = 200;
/** Fewest categories worth drawing (the TUI's `bars < 4` gate). */
const MIN_CATEGORIES = 4;
/** Most series of a line chart (the TUI's `MAX_LINES`). */
const MAX_LINES = 6;
/** Most bars of a single-series bar chart / most rows of grouped bars that stay legible at a page's width. */
export const MAX_BAR_ROWS = 60;
const MAX_GROUPED_ROWS = 40;
/** Most series of grouped bars; the TUI draws four same-unit measures as a heatmap. */
const MAX_GROUPED = 3;

// ───────────────────────────── Reading a cell ─────────────────────────────

type Dimension = "count" | "percent" | "duration" | "bytes" | "currency" | "ratio" | "rate";
/** How a number sits in its cell: alone, with a short note, with prose, as the start of a range or of an arrow. */
type Fit = "pure" | "note" | "prose" | "range" | "arrow";
interface NumberCell {
	readonly kind: "number";
	readonly text: string;
	/** In base units (seconds, bytes, ones). */
	readonly value: number;
	readonly dim: Dimension;
	/** What is written for the value: a currency symbol, a rate (`t/s`), the canonical duration / size unit, `%`, `×`; `""` for counts. */
	readonly unit: string;
	/** `value` per one `unit`. */
	readonly factor: number;
	/** The unit letters as written (`k`, `M`), to tell a `du -h` size from a count. */
	readonly written: string;
	readonly fit: Fit;
	readonly signed: boolean;
}
interface OtherCell {
	readonly kind: "missing" | "date" | "time" | "version" | "id" | "text";
	readonly text: string;
}
type Cell = NumberCell | OtherCell;

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+`;
const CELL = new RegExp(
	String.raw`^(?<approx>~|≈|<=|>=|<|>|≤|≥)?\s*(?<sign>[+\-−±])?\s*(?<cur>[$€£¥])?\s*(?<num>${NUMBER})(?<plus>\+(?=\s*[A-Za-zµμ%]))?\s*(?<unit>%|[A-Za-zµμ×]+(?:\/[A-Za-z]+)?|\/s)?(?<rest>.*)$`,
);
/** `12/20`, `79 / 124 µs`, `9/47/85`: a fraction or a list, never one quantity. */
const SLASH_PAIR = new RegExp(
	String.raw`^[~≈<>≤≥+\-−±]*\s*[$€£¥]?(?:${NUMBER})\s*[A-Za-zµμ%]*\s*\/\s*[$€£¥]?(?:${NUMBER})`,
);
const RANGE_TAIL = new RegExp(String.raw`^[-–—]\s*[~≈]?\s*[$€£¥]?(?:${NUMBER})\s*(%|[A-Za-zµμ×]+)?`);
const ARROW_TAIL = new RegExp(String.raw`^(?:→|->|⇒)\s*[~≈]?\s*[+\-−]?\s*[$€£¥]?(?:${NUMBER})`);
const ERROR_TAIL = new RegExp(String.raw`^\(?\s*±\s*(?:${NUMBER})\s*(?:%|[A-Za-zµμ]+(?:\/[A-Za-z]+)?)?\s*\)?$`);
const COMPOUND_DURATION =
	/^(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/;
const DATE =
	/^\d{4}-\d{2}(?:-\d{2})?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b|^\d{1,2}\/\d{1,2}\/\d{2,4}$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:am|pm)?$/i;
const CLOCK = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2}(?:\.\d+)?)$/;
const VERSION = /^v?\d+\.\d+\.\d+|^v\d/i;
const IDENTIFIER =
	/^(?:#\d+|[0-9a-f]{7,40}$|(?=[0-9a-f]{7,40}\s)(?=\d*[a-f])(?=[a-f]*\d)[0-9a-f]{7,40}\s|PR\s*#?\d+|L\d+\b)/i;
const ZERO_PADDED = /^0\d/;
const FOOTNOTE = /^[*†‡]+$/;
/** Status and trend marks that decorate a value without changing it (`**4** ✅`, `6 ↓`). */
const MARKS = /[✅❌⚠🟢🔴🟡✓✗✔★⭐↑↓⬆⬇▲▼]|\uFE0E|\uFE0F/gu;
const MISSING: ReadonlySet<string> = new Set(["", "-", "—", "–", "−", "n/a", "na", "none", "?", "…", "...", "null", "nan", "tbd", "·", "x", "✗"]);

type UnitInfo = { readonly dim: Dimension; readonly factor: number; readonly unit: string };
const info = (dim: Dimension, factor: number, unit: string): UnitInfo => ({ dim, factor, unit });
/** Units matched case-insensitively. Keys are looked up in Maps: a cell saying `constructor` or `__proto__` is no unit. */
const UNITS: ReadonlyMap<string, UnitInfo> = new Map([
	["%", info("percent", 1, "%")],
	["pp", info("percent", 1, "%")],
	["pct", info("percent", 1, "%")],
	["ns", info("duration", 1e-9, "ns")],
	["µs", info("duration", 1e-6, "µs")],
	["μs", info("duration", 1e-6, "µs")],
	["us", info("duration", 1e-6, "µs")],
	["ms", info("duration", 1e-3, "ms")],
	["s", info("duration", 1, "s")],
	["sec", info("duration", 1, "s")],
	["secs", info("duration", 1, "s")],
	["seconds", info("duration", 1, "s")],
	["min", info("duration", 60, "min")],
	["mins", info("duration", 60, "min")],
	["minutes", info("duration", 60, "min")],
	["h", info("duration", 3600, "h")],
	["hr", info("duration", 3600, "h")],
	["hrs", info("duration", 3600, "h")],
	["hours", info("duration", 3600, "h")],
	["d", info("duration", 86_400, "d")],
	["days", info("duration", 86_400, "d")],
	["bytes", info("bytes", 1, "B")],
	["kb", info("bytes", 1e3, "KB")],
	["kib", info("bytes", 1024, "KiB")],
	["mb", info("bytes", 1e6, "MB")],
	["mib", info("bytes", 1024 ** 2, "MiB")],
	["gb", info("bytes", 1e9, "GB")],
	["gib", info("bytes", 1024 ** 3, "GiB")],
	["tb", info("bytes", 1e12, "TB")],
	["tib", info("bytes", 1024 ** 4, "TiB")],
	["x", info("ratio", 1, "×")],
	["×", info("ratio", 1, "×")],
	["k", info("count", 1e3, "")],
	["bn", info("count", 1e9, "")],
]);
/** Units whose case decides their meaning: `B` bytes against `b` billions, `M` millions against `m` minutes. */
const CASED_UNITS: ReadonlyMap<string, UnitInfo> = new Map([
	["B", info("bytes", 1, "B")],
	["b", info("count", 1e9, "")],
	["M", info("count", 1e6, "")],
	["m", info("duration", 60, "min")],
	["G", info("count", 1e9, "")],
	["T", info("count", 1e12, "")],
]);
const knownUnit = (unit: string): UnitInfo | undefined => CASED_UNITS.get(unit) ?? UNITS.get(unit.toLowerCase());

function readCell(source: string): Cell {
	const plain = String(source).slice(0, MAX_CELL).replace(/\s+/g, " ").trim();
	const text = plain.replace(MARKS, "").replace(/\s+/g, " ").trim();
	const other = (kind: OtherCell["kind"]): OtherCell => ({ kind, text: plain });
	if (MISSING.has(text.toLowerCase())) return other("missing");
	if (DATE.test(text)) return other("date");
	if (TIME.test(text)) return other("time");
	if (VERSION.test(text)) return other("version");
	if (IDENTIFIER.test(text) || ZERO_PADDED.test(text)) return other("id");
	if (SLASH_PAIR.test(text)) return other("text");
	const compound = COMPOUND_DURATION.exec(text);
	if (compound && compound.slice(1).filter(Boolean).length >= 2) {
		const [, days, hours, minutes, seconds] = compound.map(part => Number(part ?? 0));
		const value = (days ?? 0) * 86_400 + (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
		return { kind: "number", text: plain, value, dim: "duration", unit: "s", factor: 1, written: "s", fit: "pure", signed: false };
	}
	const groups = CELL.exec(text)?.groups;
	if (!groups) return other("text");
	let unit = groups.unit ?? "";
	let rest = (groups.rest ?? "").trim();
	let dim: Dimension = groups.cur ? "currency" : "count";
	let factor = 1;
	let display = "";
	if (unit) {
		const known = knownUnit(unit);
		if (known) ({ dim, factor, unit: display } = { ...known });
		else if (unit.includes("/")) {
			dim = "rate";
			display = unit;
		} else {
			// A word after the number is a noun (`16 pass`, `8+ structs`), not a unit.
			rest = `${groups.plus ?? ""}${unit} ${rest}`.trim();
			unit = "";
		}
	}
	// `24–72 h`: the unit after the range's end applies to its start too.
	const range = RANGE_TAIL.exec(rest);
	const rangeUnit = range?.[1] ? knownUnit(range[1]) : undefined;
	if (!unit && rangeUnit) ({ dim, factor, unit: display } = { ...rangeUnit });
	// A magnitude suffix on money (`$6.0k`) scales it; the amount stays currency.
	if (groups.cur && dim === "count") dim = "currency";
	if (dim === "currency") display = groups.cur ?? display;
	const value = Number((groups.num ?? "").replaceAll(",", "")) * factor * (groups.sign === "-" || groups.sign === "−" ? -1 : 1);
	if (!Number.isFinite(value)) return other("text");
	let fit: Fit;
	if (!rest || rest === "+" || FOOTNOTE.test(rest)) fit = "pure";
	else if (ERROR_TAIL.test(rest)) fit = "note";
	else if (range) fit = "range";
	else if (ARROW_TAIL.test(rest)) fit = "arrow";
	else if (/^\(.*\)$/.test(rest) || /^[A-Za-z][\w-]{0,11}$/.test(rest)) fit = "note";
	else fit = "prose";
	return { kind: "number", text: plain, value, dim, unit: display, factor, written: unit, fit, signed: groups.sign !== undefined };
}

const isNumber = (cell: Cell | undefined): cell is NumberCell => cell?.kind === "number";

// ───────────────────────────── Reading a column ─────────────────────────────

/** Header names of row numbers and identifiers: never plotted. */
const INDEX_HEADER =
	/^(?:#|no\.?|n°|id|ids|rank|row|idx|index|line|lines?\s*#|ln|pr|pr\s*#|issue|commit|sha|hash|port|pid|code|exit\s*code|status|version|ver|ref|offset|priority|prio)$|\s(?:id|ids|version|ver|sha|hash|pid|port)$/i;
/** Header names of ordered steps: with monotonic values, a valid x axis. */
const SEQUENCE_HEADER =
	/^(?:step|phase|stage|round|tier|level|wave|pass|attempt|iter|iteration|epoch|run|batch|day|week|month|year|quarter|n|workers?|threads?|concurrency|jobs|depth|k)$/i;
/** Row labels that summarize the rows above them. */
const TOTAL_ROW =
	/^(?:(?:total|totals|sum|overall|grand total|subtotal|σ)\b|(?:average|avg|mean|median|all|combined|net)\s*(?:\(.*\))?:?$)/i;
/** Summary labels that say nothing else: they summarize wherever they stand. */
const BARE_TOTAL = /^(?:total|totals|sum|grand total|sub-?total|σ|average|avg|mean|median)\s*(?:\(.*\))?:?$/i;
const APPROX_TOTAL = 0.005;
/** Row labels that name an ordered step (`Run 3`, `Day 2`, `Q3`, `#12`, `v1.2.3`). */
const SEQUENCE_LABEL =
	/^(?:(?:run|day|week|month|iter(?:ation)?|round|step|phase|epoch|v|version|n\s*=|wave|attempt|pass|batch)\s*\d+(?:\.\d+)*|q[1-4]|#\s*\d{1,2})\b/i;
const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const METRIC_HEADER = /^(?:metrics?|measures?|stats?|statistics?|quantit(?:y|ies))$/i;
const AGGREGATE = /^(?:total|sum|cumulative|cum\.?|running total|avg|average|mean)\b/i;
const SIZE_HEADER = /\b(?:sizes?|disk|du|rss|memory|mem|heap|storage|footprint|bytes)\b/i;
const BINARY_POWER: ReadonlyMap<string, number> = new Map([["K", 1], ["k", 1], ["M", 2], ["G", 3], ["T", 4]]);
const BINARY_UNIT = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
type StatusTone = "good" | "bad" | "warn" | "pending";
const STATUS_WORDS: ReadonlyMap<string, StatusTone> = new Map<string, StatusTone>([
	...["ok", "pass", "passed", "passes", "passing", "success", "succeeded", "done", "complete", "completed", "landed", "merged", "fixed", "works", "working", "green"].map((word): [string, StatusTone] => [word, "good"]),
	...["fail", "failed", "fails", "failing", "failure", "error", "errored", "broken", "timeout", "timed out", "crash", "crashed", "oom", "panic", "red", "blocked", "truncated"].map((word): [string, StatusTone] => [word, "bad"]),
	...["partial", "flaky", "degraded"].map((word): [string, StatusTone] => [word, "warn"]),
	...["pending", "running", "waiting", "queued", "skipped", "wip", "in progress"].map((word): [string, StatusTone] => [word, "pending"]),
]);
const STATUS_MARKS: readonly (readonly [RegExp, StatusTone])[] = [
	[/^[✅✓✔🟢]/u, "good"],
	[/^[❌✗✘🔴]/u, "bad"],
	[/^[⚠🟡]/u, "warn"],
	[/^[⏳🕐]/u, "pending"],
];
const STATUS_WORD = new RegExp(String.raw`^(?:${[...STATUS_WORDS.keys()].sort((a, b) => b.length - a.length).join("|")})(?![\w-])`, "i");

type Role = "label" | "temporal" | "index" | "sequence" | "measure";
interface Column {
	readonly index: number;
	readonly header: string;
	role: Role;
	readonly cells: readonly Cell[];
	readonly dim: Dimension | undefined;
	/** The unit most of the column's numbers of its dimension write. */
	readonly unit: string;
	/** Less than 80% of its numbers share one dimension. */
	readonly mixed: boolean;
	readonly signedShare: number;
	readonly arrowShare: number;
	readonly rangeShare: number;
	constant: boolean;
}

/** The status a text leads with (`FAIL`, `✓ via mmdc`, `1 ok`), or `undefined` for any other text. */
function statusTone(text: string): StatusTone | undefined {
	const trimmed = text.trim();
	for (const [mark, tone] of STATUS_MARKS) if (mark.test(trimmed)) return tone;
	const word = STATUS_WORD.exec(trimmed.replace(/^\d+\s+/, ""));
	return word ? STATUS_WORDS.get(word[0].toLowerCase()) : undefined;
}

/** Bare magnitudes (`3.4G`, `960M`) under a size header are `du -h` sizes in powers of 1024. */
function resolveMagnitudes(cells: readonly Cell[], header: string): readonly Cell[] {
	if (!SIZE_HEADER.test(header)) return cells;
	const numbers = cells.filter(isNumber);
	if (!numbers.every(cell => cell.dim === "count" || cell.dim === "bytes")) return cells;
	return cells.map((cell): Cell => {
		const power = isNumber(cell) && cell.dim === "count" ? BINARY_POWER.get(cell.written) : undefined;
		if (!isNumber(cell) || power === undefined) return cell;
		const factor = 1024 ** power;
		return { ...cell, dim: "bytes", unit: BINARY_UNIT[power] ?? "B", factor, value: (cell.value / cell.factor) * factor };
	});
}

/** A lone `m` means minutes beside other durations and millions when no other duration is there. */
function resolveMinutes(cells: readonly Cell[]): readonly Cell[] {
	const durations = cells.filter((cell): cell is NumberCell => isNumber(cell) && cell.dim === "duration");
	if (durations.length === 0 || !durations.every(cell => cell.written === "m")) return cells;
	return cells.map((cell): Cell => (isNumber(cell) && cell.written === "m" ? { ...cell, dim: "count", unit: "", factor: 1e6, value: (cell.value / 60) * 1e6 } : cell));
}

/** `4:14` beside `8s` and `24s` is four minutes fourteen seconds, not a time of day. */
function resolveClock(cells: readonly Cell[]): readonly Cell[] {
	if (!cells.some(cell => isNumber(cell) && cell.dim === "duration")) return cells;
	return cells.map((cell): Cell => {
		const clock = cell.kind === "time" ? CLOCK.exec(cell.text) : null;
		if (!clock) return cell;
		const value = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
		return { kind: "number", text: cell.text, value, dim: "duration", unit: "s", factor: 1, written: "s", fit: "pure", signed: false } satisfies NumberCell;
	});
}

/** Strictly increasing or strictly decreasing. */
function isMonotonic(values: readonly number[]): boolean {
	if (values.length < 2) return false;
	const up = (values[1] ?? 0) > (values[0] ?? 0);
	for (let at = 1; at < values.length; at++) {
		const step = (values[at] ?? 0) - (values[at - 1] ?? 0);
		if (step === 0 || step > 0 !== up) return false;
	}
	return true;
}

/** Non-decreasing with at least one repeat: ordered buckets, not a strictly monotonic axis. */
function isOrdered(values: readonly number[]): boolean {
	if (values.length < 3 || new Set(values).size === values.length) return false;
	return values.every((value, at) => at === 0 || value >= (values[at - 1] ?? value));
}

function readColumn(index: number, header: string, source: readonly Cell[]): Column {
	const cells = resolveClock(resolveMagnitudes(resolveMinutes(source), header));
	const present = cells.filter(cell => cell.kind !== "missing");
	const numbers = present.filter(isNumber);
	const strict = numbers.filter(cell => cell.fit !== "prose");
	const total = Math.max(1, present.length);
	const numberShare = numbers.length / total;
	const strictShare = strict.length / total;
	const temporalShare = present.filter(cell => cell.kind === "date" || cell.kind === "time").length / total;

	const dims = new Map<Dimension, NumberCell[]>();
	for (const cell of numbers) {
		const same = dims.get(cell.dim);
		if (same) same.push(cell);
		else dims.set(cell.dim, [cell]);
	}
	let dominant: NumberCell[] = [];
	for (const group of dims.values()) if (group.length > dominant.length) dominant = group;
	const dim = dominant[0]?.dim;
	const units = new Map<string, number>();
	for (const cell of dominant) units.set(cell.unit, (units.get(cell.unit) ?? 0) + 1);
	let unit = "";
	let seen = 0;
	for (const [candidate, count] of units) if (count > seen) [unit, seen] = [candidate, count];

	const trimmed = header.trim();
	const sequential = index === 0 && numbers.length >= 3 && numbers.length === present.length && numbers.every((cell, at) => cell.dim === "count" && cell.value === (numbers[0]?.value ?? 0) + at);
	// Row numbers and identifiers are bare counts; a unit (`20 ms` under `PR`) makes the column a measure.
	const bare = numbers.every(cell => cell.dim === "count" && !cell.written);
	// `1 ok`, `87 ok`, `3 fail`: every count tallies an outcome, a verdict per row rather than a quantity.
	const tallies = numbers.length > 0 && bare && cells.every(cell => !isNumber(cell) || statusTone(cell.text) !== undefined);
	const values = numbers.map(cell => cell.value);
	let role: Role;
	if (temporalShare >= 0.8) role = "temporal";
	else if (tallies) role = "label";
	else if (numberShare >= 0.8 && (sequential || (bare && INDEX_HEADER.test(trimmed)))) role = "index";
	else if (numberShare >= 0.8 && bare && SEQUENCE_HEADER.test(trimmed) && (isMonotonic(values) || isOrdered(values))) role = "sequence";
	else if (numberShare >= 0.8 && strictShare >= 0.6) role = "measure";
	// A mostly numeric column whose other cells are short status words (`TIMEOUT`, `MISS`, `OOM`).
	else if (numberShare >= 0.6 && strictShare >= 0.5 && present.every(cell => isNumber(cell) || cell.text.length <= 24)) role = "measure";
	else role = "label";
	const share = (test: (cell: NumberCell) => boolean) => (numbers.length ? numbers.filter(test).length / numbers.length : 0);
	return {
		index,
		header,
		role,
		cells,
		dim,
		unit,
		mixed: numbers.length > 0 && dominant.length / numbers.length < 0.8,
		signedShare: share(cell => cell.signed),
		arrowShare: share(cell => cell.fit === "arrow"),
		rangeShare: present.length ? numbers.filter(cell => cell.fit === "range").length / present.length : 0,
		constant: false,
	};
}

/** Whether `cell` is a point of `column`: a number of its dimension (and, for money and rates, of its unit). */
function fits(cell: Cell | undefined, column: Column): cell is NumberCell {
	return isNumber(cell) && cell.dim === column.dim && ((cell.dim !== "currency" && cell.dim !== "rate") || cell.unit === column.unit);
}

/** The base-unit values of `column`'s points over `rows`. */
function pointsOf(column: Column, rows: readonly number[]): number[] {
	const out: number[] = [];
	for (const row of rows) {
		const cell = column.cells[row];
		if (fits(cell, column)) out.push(cell.value);
	}
	return out;
}

const median = (values: readonly number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1] ?? 0;
};

// ───────────────────────────── Kinds the TUI draws otherwise ─────────────────────────────

const BEFORE = /\b(?:before|old|baseline|base|main|master|prev|previous|original|orig|cold|was|from|v1|stock|default|unpatched|without)\b/i;
const AFTER = /\b(?:after|new|patched|optimi[sz]ed|fixed|warm|now|to|v2|with|proposed|branch|pr|ours)\b/i;
const DELTA = /(?:Δ|delta|change|diff|improvement|speedup|reduction|savings|saved|gain|regression|% chg)/i;
const STAGE_HEADER =
	/\b(?:(?:iter(?:ation)?|round|run|pass|step|stage|phase|attempt|v)\s*\d+|r\d+|now|after|then|final|latest|current|best|new|fixed|patched|optimi[sz]ed|today)\b/i;
const OPPOSED: readonly (readonly [RegExp, RegExp])[] = [
	[/\b(?:removed|removals?|deletions?|deleted|dels)\b/i, /\b(?:added|additions?|insertions?|inserted|adds)\b/i],
	[/\b(?:loss(?:es)?|lost)\b/i, /\b(?:wins?|won|gain(?:s|ed)?)\b/i],
	[/\b(?:closed|deleted)\b/i, /\b(?:opened|created)\b/i],
	[/\b(?:outflows?|debits?|sells?|downvotes?)\b/i, /\b(?:inflows?|credits?|buys?|upvotes?)\b/i],
];
const TARGET_HEADER = /^(?:[§\p{L}][\p{L}\p{N}§.-]*\s+)?(?<word>target|budget|limit|cap|ceiling|threshold|sla|slo|goal|quota|allowance|bar)(?:\s+[\p{L}\p{N}]+)?(?:\s*\([^)]*\))?$/iu;
const TARGET_WORD = /^(?:target|budget|limit|sla|slo|goal)$/i;
const BOUND = /(?<sign>≤|<=|<|≥|>=|>|\bat most\b|\bat least\b|\bunder\b|\bbelow\b|\bup to\b|\bno more than\b|\bno less than\b)\s*(?=[~≈]?\s*[$€£¥]?\s*\.?\d)/i;
const QUANTILE_WORD = String.raw`p\d{1,4}(?:\.\d+)?|median|med|min|minimum|max|maximum`;
const QUANTILE_HEADER = new RegExp(String.raw`(?:^|[^\w.])(${QUANTILE_WORD})(?![\w.])`, "gi");
const ROW_SPREAD = 8;
const WHOLE_HEADER = /\b(?:total|all|sum|overall)\b/i;
const STEP_HEADER = /^(?:(?:ci|pipeline|build|job|run)\s+)?(?:steps?|stages?|phases?)(?:\s+name)?$/i;
const PART_HEADER = /^(?:buckets?|(?:line\s+)?items?|components?|categor(?:y|ies)|expenses?|costs?|allocations?|use of funds|parts?|breakdown)$/i;
const BUCKET_HEADER = /^(?:status|state|verdict|outcome|result|severity|priority|bucket|cohort|category|class|type|kind|tier|level|grade|cause|reason|disposition|resolution)$/i;
const COUNT_HEADER = /^(?:count|counts|cnt|n|#|number|num|items|tally|freq|frequency)$/i;
const AMOUNT_HEADER = /\b(?:tokens?|lines?|loc|sloc|chars?|characters|words|bytes|calls|requests|cost|spend|budget|amount)\b/i;
const PER_UNIT = /\/|\bper\b|\bprice\b|\brate\b|\bavg\b|\baverage\b|\bmean\b|\beach\b|\bunit\b|\bmedian\b|\bp\d{2}\b/i;
const TOTAL_NAME = /^(?:total|overall|grand|sum)(?:\b|_)/i;
const FLOW_DIMS: ReadonlySet<Dimension> = new Set(["count", "duration", "bytes", "currency"]);
const DOT_DIMS: ReadonlySet<Dimension> = new Set(["duration", "bytes", "currency", "rate", "ratio"]);
const MAX_SHARE_PARTS = 6;
const MAX_FLOW_STEPS = 12;
/** Most characters of other text columns' typical cells, and largest whole plotted number, of a table its prose carries. */
const PROSE_CELL = 40;
const MAX_PROSE_COUNT = 5;
/** Typical size ratio from which same-unit columns count different quantities (the TUI draws panels of them). */
const QUANTITY_SPREAD = 30;
const DOT_SPREAD = 10;
/** Spread from which two timings, sizes or prices read as dots on a log axis rather than as bars. */
const DECADES = 100;
const DOT_CLUMP = 0.2;
/** A header marking the configuration in use, which the others compare against. */
const IN_USE = /\((?:shipped|current|default|in use|deployed|prod(?:uction)?)\b[^)]*\)/i;

const words = (header: string): string[] => header.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
const isTransition = (first: string, second: string): boolean => (BEFORE.test(first) && !BEFORE.test(second)) || (AFTER.test(second) && !AFTER.test(first));
function isConditionPair(first: string, second: string): boolean {
	const [a, b] = [words(first), words(second)];
	if (a.join(" ") === b.join(" ")) return false;
	if (isTransition(first, second)) return true;
	const shared = a.filter(word => b.includes(word));
	return shared.length > 0 && shared.length < Math.max(a.length, b.length);
}

/** The widest typical ratio between two columns of `grid` (rows of positive values, `NaN` where absent): per pair, the median over the rows holding both. */
function pairSpread(grid: readonly (readonly number[])[]): number {
	const width = grid[0]?.length ?? 0;
	let widest = 1;
	for (let a = 0; a < width; a++) {
		for (let b = a + 1; b < width; b++) {
			const ratios = grid.map(values => (values[a] ?? Number.NaN) / (values[b] ?? Number.NaN)).filter(Number.isFinite).sort((x, y) => x - y);
			if (ratios.length < 2) continue;
			const middle = ratios[Math.floor(ratios.length / 2)] ?? 1;
			widest = Math.max(widest, middle, 1 / middle);
		}
	}
	return widest;
}

/** The column the others are read against: one marked as in use (`(current)`), or the sole baseline every other moves from. */
function hasDotBaseline(columns: readonly Column[]): boolean {
	const marked = columns.find(column => IN_USE.test(column.header)) ?? columns.find(column => columns.every(other => other === column || isTransition(column.header, other.header)));
	if (!marked) return false;
	const marks = marked.header.toLowerCase().match(new RegExp(BEFORE.source, "gi")) ?? [];
	return columns.every(column => column === marked || !marks.some(mark => new RegExp(String.raw`\b${mark}\b`, "i").test(column.header)));
}

/**
 * Two to six columns of one measurement (timings, sizes, prices, rates) spanning a hundredfold (tenfold from three columns): the TUI
 * draws dots on a log axis where the columns' rows sit apart, and where they sit tight beside a baseline column.
 */
function isDots(columns: readonly Column[], rows: readonly number[]): boolean {
	const first = columns[0];
	if (!first?.dim || !DOT_DIMS.has(first.dim) || columns.length < 2 || columns.length > MAX_LINES) return false;
	if (columns.some(column => column.dim !== first.dim || ((first.dim === "currency" || first.dim === "rate") && column.unit !== first.unit))) return false;
	const all = columns.flatMap(column => pointsOf(column, rows));
	if (all.length < 2 || all.some(value => value <= 0) || Math.max(...all) / Math.min(...all) < (columns.length >= 3 ? DOT_SPREAD : DECADES)) return false;
	const grid = rows.map(row => columns.map(column => {
		const cell = column.cells[row];
		return fits(cell, column) && cell.value > 0 ? cell.value : Number.NaN;
	}));
	if (pairSpread(grid) >= QUANTITY_SPREAD) return false;
	const values = grid.flat().filter(Number.isFinite);
	if (values.length < 2) return false;
	const whole = Math.log(Math.max(...values) / Math.min(...values));
	const spans = grid.map(row => row.filter(Number.isFinite)).filter(row => row.length >= 2).map(row => Math.log(Math.max(...row) / Math.min(...row))).sort((a, b) => a - b);
	const clumped = whole > 0 && (spans[spans.length >> 1] ?? 0) < DOT_CLUMP * whole;
	return !clumped || hasDotBaseline(columns);
}

/** Before columns pairing with an after column over one metric (`Baseline Turns` → `Iter1 Turns`): at least two pairs. */
function metricPairCount(measures: readonly Column[]): number {
	let pairs = 0;
	const taken = new Set<Column>();
	for (const before of measures) {
		if (!BEFORE.test(before.header)) continue;
		const subject = words(before.header).filter(word => !BEFORE.test(word));
		if (subject.length === 0) continue;
		const partners = measures.filter(column => {
			if (column === before || column.dim !== before.dim || BEFORE.test(column.header)) return false;
			const own = words(column.header);
			const extra = own.filter(word => !subject.includes(word));
			return subject.every(word => own.includes(word)) && extra.length >= 1 && extra.length <= 2;
		});
		if (partners.length > 1) return 0;
		const after = partners[0];
		if (after && !taken.has(after)) {
			taken.add(after);
			pairs++;
		}
	}
	return pairs;
}

/** Whether `parts` add up to `whole` in every row that writes the whole (within the precision a table is written in). */
function addsUp(whole: Column, parts: readonly Column[], rows: readonly number[], exact: boolean): boolean {
	let seen = 0;
	let share = false;
	for (const row of rows) {
		const total = whole.cells[row];
		if (!fits(total, whole) || total.value <= 0) continue;
		seen++;
		let sum = 0;
		for (const part of parts) {
			const cell = part.cells[row];
			if (cell !== undefined && !fits(cell, part)) {
				if (cell.kind !== "missing") return false;
				continue;
			}
			sum += cell?.value ?? 0;
		}
		if (exact ? Math.abs(sum - total.value) > total.value * APPROX_TOTAL : sum > total.value * (1 + APPROX_TOTAL)) return false;
		share ||= sum / total.value >= 0.25;
	}
	return seen >= 2 && (exact || share);
}

/** Subsets of `items` from `min` to `max` long. */
function subsets<T>(items: readonly T[], min: number, max: number): T[][] {
	const out: T[][] = [];
	const grow = (start: number, picked: T[]): void => {
		if (picked.length >= min) out.push(picked);
		if (picked.length === max) return;
		for (let at = start; at < items.length; at++) grow(at + 1, [...picked, items[at] as T]);
	};
	grow(0, []);
	return out;
}

/** Measure columns that add up to a whole column of the table (the TUI draws parts of a whole as stacked bars). */
function hasComposition(measures: readonly Column[], rows: readonly number[], label: Column): boolean {
	const pool = measures.filter(column => !column.mixed && column.arrowShare === 0 && rows.every(row => {
		const cell = column.cells[row];
		return !isNumber(cell) || cell.value >= 0;
	})).slice(0, 8);
	for (const whole of pool) {
		const others = pool.filter(column => column !== whole && column.dim === whole.dim);
		for (const subset of subsets(others, 2, 4)) if (addsUp(whole, subset, rows, true) && !subset.includes(label) && whole !== label) return true;
	}
	const whole = pool.find(column => WHOLE_HEADER.test(column.header));
	if (!whole) return false;
	const parts = pool.filter(column => column !== whole && column.dim === whole.dim && !WHOLE_HEADER.test(column.header) && column.signedShare < 0.5);
	return parts.length >= 2 && parts.length <= 4 && !parts.includes(label) && addsUp(whole, parts, rows, false);
}

/** Outcome columns (`ok | fail`, `Pass | Partial | Fail`) beside each other: the parts of each row's attempts. */
function hasOutcomes(measures: readonly Column[]): boolean {
	const first = measures.find(column => statusTone(column.header));
	if (!first || (first.dim !== "count" && first.dim !== "percent")) return false;
	const parts = measures.filter(column => column.dim === first.dim && column.unit === first.unit && column.signedShare === 0 && statusTone(column.header));
	if (parts.length < 2) return false;
	const tones = parts.map(column => statusTone(column.header));
	return tones.includes("good") && tones.some(tone => tone !== "good");
}

/** Rows that lie end to end (steps of a run, parts of a total): the TUI draws a timeline or a waterfall. */
function isFlow(label: Column, measure: Column, names: ReadonlyMap<number, string>, rows: readonly number[], totals: readonly number[]): boolean {
	const dim = measure.dim;
	if (label.role !== "label" || rows.length < 3 || rows.length > MAX_FLOW_STEPS || !dim || !FLOW_DIMS.has(dim) || measure.mixed || PER_UNIT.test(measure.header)) return false;
	const cells: NumberCell[] = [];
	for (const row of rows) {
		const cell = measure.cells[row];
		if (!fits(cell, measure)) return false;
		cells.push(cell);
	}
	const values = cells.map(cell => cell.value);
	const sum = values.reduce((a, b) => a + b, 0);
	const negative = values.some(value => value < 0);
	const totalCell = totals.map(row => measure.cells[row]).find((cell): cell is NumberCell => fits(cell, measure));
	const sums = totalCell !== undefined && Math.abs(sum - totalCell.value) <= Math.abs(totalCell.value) * APPROX_TOTAL + 1e-9;
	if (totalCell !== undefined && !sums) return false;
	if (Math.max(...values.map(Math.abs)) > 0.9 * values.reduce((a, b) => a + Math.abs(b), 0)) return false;
	if (rows.some(row => TOTAL_NAME.test(names.get(row) ?? ""))) return false;
	if (dim === "duration") return !negative && (STEP_HEADER.test(label.header) || sums);
	if (dim === "count" && !AMOUNT_HEADER.test(measure.header)) return false;
	const rises = values.filter((value, at) => at > 0 && value > (values[at - 1] ?? value)).length;
	return sums || (!negative && PART_HEADER.test(label.header) && rises * 8 > values.length - 1);
}

/** One count column splitting a total into three to six parts (the TUI draws a share bar). */
function splitsTotal(label: Column, measure: Column, rows: readonly number[], totals: readonly number[]): boolean {
	if (label.role !== "label" || measure.dim !== "count" || measure.unit || rows.length < 3 || rows.length > MAX_SHARE_PARTS) return false;
	const values = pointsOf(measure, rows);
	if (values.length !== rows.length || values.some(value => value < 0 || !Number.isInteger(value))) return false;
	if (values.filter(value => value > 0).length < 2) return false;
	const sum = values.reduce((a, b) => a + b, 0);
	const totalled = totals.some(row => {
		const cell = measure.cells[row];
		return fits(cell, measure) && Math.abs(cell.value - sum) <= 0.5;
	});
	return totalled || ((!label.header || BUCKET_HEADER.test(label.header)) && (!measure.header || COUNT_HEADER.test(measure.header)));
}

// ───────────────────────────── Planning ─────────────────────────────

const clean = (text: unknown, limit: number): string => {
	const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : flat;
};

type Order = "temporal" | "sequence" | "numeric";
/** How the label column orders the rows: by time, by step, by a numeric size — or not at all. */
function axisOrder(label: Column, rows: readonly number[], names: ReadonlyMap<number, string>): Order | undefined {
	if (label.role === "temporal") return "temporal";
	if (label.role === "sequence") return isMonotonic(pointsOf(label, rows)) ? "sequence" : undefined;
	const texts = rows.map(row => names.get(row) ?? "");
	const mostly = (pattern: RegExp) => texts.filter(name => pattern.test(name)).length >= texts.length * 0.8;
	if (mostly(SEQUENCE_LABEL)) return "sequence";
	if (mostly(MONTH)) return "temporal";
	const values = pointsOf(label, rows);
	return values.length === texts.length && values.length >= 3 && isMonotonic(values) ? "numeric" : undefined;
}

/** The drawn name of a series: its header, else its place. */
const seriesName = (column: Column, at: number): string => clean(column.header, 40) || `Series ${at + 1}`;

function listNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Whether `spec` is worth a chart (the TUI's `worthCharting`, general rule): four categories, not uniform, nine points or a threefold spread. */
function worthDrawing(categories: readonly string[], series: readonly ChartSeries[]): boolean {
	if (categories.length < MIN_CATEGORIES) return false;
	const uniform = series.every(entry => {
		const values = entry.values.filter((value): value is number => value !== null);
		const tally = new Map<number, number>();
		for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
		return values.length >= 4 && Math.max(0, ...tally.values()) >= values.length - 1;
	});
	if (uniform) return false;
	let points = 0;
	let spread = 1;
	for (const entry of series) {
		const positive: number[] = [];
		for (const value of entry.values) {
			if (value === null) continue;
			points++;
			if (value > 0) positive.push(value);
		}
		if (positive.length >= 2) spread = Math.max(spread, Math.max(...positive) / Math.min(...positive));
	}
	return points >= 9 || spread >= 3;
}

/** The unit the plotted `columns` are drawn in and the factor from base units to it. */
function displayUnit(columns: readonly Column[], rows: readonly number[]): { unit: string; factor: number } {
	const first = columns[0];
	if (!first?.dim) return { unit: "", factor: 1 };
	if (first.dim !== "duration" && first.dim !== "bytes") return { unit: first.dim === "percent" ? "%" : first.dim === "ratio" ? "×" : first.dim === "count" ? "" : first.unit, factor: 1 };
	// Durations and sizes share an axis in base units whatever unit each cell writes: the most written unit is the axis's.
	const tally = new Map<string, { count: number; factor: number }>();
	for (const column of columns) {
		for (const row of rows) {
			const cell = column.cells[row];
			if (!fits(cell, column)) continue;
			const entry = tally.get(cell.unit) ?? { count: 0, factor: cell.factor };
			entry.count++;
			tally.set(cell.unit, entry);
		}
	}
	let best = { unit: first.unit, factor: 1 };
	let seen = 0;
	for (const [unit, entry] of tally) if (entry.count > seen) [best, seen] = [{ unit, factor: entry.factor }, entry.count];
	return best;
}

/** The series for `columns` over `rows` in `unit`'s scale; a column with fewer than two points is no series. */
function buildSeries(columns: readonly Column[], rows: readonly number[], scale: number): { series: ChartSeries[]; columns: Column[] } {
	const series: ChartSeries[] = [];
	const kept: Column[] = [];
	columns.forEach((column, at) => {
		const values = rows.map(row => {
			const cell = column.cells[row];
			return fits(cell, column) ? cell.value / scale : null;
		});
		if (values.filter(value => value !== null).length < 2) return;
		series.push({ name: seriesName(column, at), values });
		kept.push(column);
	});
	return { series, columns: kept };
}

/** `rows` in time order when every label is a parsable date; a line runs left to right whatever order the table lists them. */
function chronological(rows: readonly number[], label: Column): readonly number[] {
	if (label.role !== "temporal") return rows;
	const times = rows.map(row => Date.parse(label.cells[row]?.text ?? ""));
	if (times.some(time => !Number.isFinite(time))) return rows;
	return rows.map((row, at) => ({ row, time: times[at] ?? 0, at })).sort((a, b) => a.time - b.time || a.at - b.at).map(entry => entry.row);
}

const OPPOSED_DIMS: ReadonlySet<Dimension> = new Set(["count", "bytes", "currency", "duration"]);

/** Whether a column holds per-row targets (`Target ≤ 200 µs`, `Budget`) that another column is measured against: a bullet chart. */
function hasTarget(columns: readonly Column[], label: Column, rows: readonly number[]): boolean {
	const goalOf = (text: string): NumberCell | undefined => {
		const bound = BOUND.exec(text);
		const cell = readCell(bound ? text.slice(bound.index + bound[0].length) : text);
		return isNumber(cell) && cell.fit !== "arrow" ? cell : undefined;
	};
	const bounded = (column: Column, written: readonly number[]) => written.filter(row => BOUND.test(column.cells[row]?.text ?? "")).length >= 0.5 * written.length;
	for (const target of columns) {
		const word = TARGET_HEADER.exec(target.header)?.groups?.word;
		if (!word || target === label || target.index === 0) continue;
		const written = rows.filter(row => target.cells[row]?.kind !== "missing");
		const stated = written.filter(row => goalOf(target.cells[row]?.text ?? "") !== undefined).length;
		if (written.length < 2 || stated * 2 < written.length) continue;
		if (!(TARGET_WORD.test(word) || bounded(target, written))) continue;
		const candidates = columns.filter(column => column !== target && column !== label && (column.role === "measure" || column.role === "label") && !TARGET_HEADER.test(column.header) && !bounded(column, written));
		for (const measured of candidates) {
			let both = 0;
			let alike = 0;
			for (const row of rows) {
				const value = measured.cells[row];
				const goal = goalOf(target.cells[row]?.text ?? "");
				if (!isNumber(value) || !goal) continue;
				both++;
				const unit = (value.dim !== "currency" && value.dim !== "rate") || value.unit === goal.unit;
				if (value.dim === goal.dim && unit && (!value.signed || goal.signed)) alike++;
			}
			if (alike >= 2 && alike * 2 >= rows.length && alike * 2 >= both) return true;
		}
	}
	return false;
}

/** Where a quantile header ranks (0–100): `p999` is 99.9. */
function quantileRank(word: string): number {
	const lower = word.toLowerCase();
	if (lower.startsWith("min")) return 0;
	if (lower.startsWith("max")) return 100;
	if (!/^p\d/.test(lower)) return 50;
	let rank = Number(lower.slice(1));
	while (rank > 100) rank /= 10;
	return rank;
}

/**
 * Whether the table is about quantile ladders (`p50 | p90 | p99`, `Startup p50 | Startup p95`): columns each naming one quantile of one
 * measurement, two or more with a middle or a tail, rising with rank in 80% of the rows, and at least half of what the table measures.
 */
function hasLadder(columns: readonly Column[], label: Column, measures: readonly Column[], rows: readonly number[]): boolean {
	const drafts: { name: string; rungs: { column: Column; rank: number }[] }[] = [];
	let previous: (typeof drafts)[number] | undefined;
	for (const column of columns) {
		if (column === label || (column.role !== "measure" && column.role !== "label")) continue;
		const found = [...column.header.matchAll(QUANTILE_HEADER)];
		const word = found[0]?.[1];
		if (found.length !== 1 || word === undefined) {
			previous = undefined;
			continue;
		}
		const name = column.header.replace(word, " ").replace(/[()[\],:;]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
		const draft = (name === "" && previous) || drafts.find(entry => entry.name === name);
		const rung = { column, rank: quantileRank(word) };
		if (draft) draft.rungs.push(rung);
		else drafts.push({ name, rungs: [rung] });
		previous = draft || drafts[drafts.length - 1];
	}
	const held = new Set<Column>();
	for (const draft of drafts) {
		const rungs = [...draft.rungs].sort((a, b) => a.rank - b.rank);
		if (rungs.length < 2 || new Set(rungs.map(rung => rung.rank)).size < rungs.length || rungs.every(rung => rung.rank === 0 || rung.rank === 100)) continue;
		const read = rows.map(row => rungs.flatMap(({ column }) => {
			const cell = column.cells[row];
			return fits(cell, column) ? [cell] : [];
		}));
		if (new Set(read.flat().map(cell => `${cell.dim}:${cell.unit}`)).size !== 1) continue;
		const full = read.filter(cells => cells.length >= 2);
		const ordered = full.filter(cells => cells.every((cell, at) => at === 0 || cell.value >= (cells[at - 1]?.value ?? cell.value)));
		if (full.length < 2 || ordered.length < 0.8 * full.length) continue;
		for (const { column } of rungs) held.add(column);
	}
	if (held.size === 0) return false;
	const measured = new Set<Column>([...measures, ...held]);
	measured.delete(label);
	return held.size * 2 >= measured.size;
}

/** A before column followed by two or three adjacent later stages of the same quantity (`Baseline | Iter 1 | Iter 2`): a slope chart. */
function stageRun(measures: readonly Column[], rows: readonly number[]): boolean {
	const near = (first: Column, next: Column): boolean => {
		const ratios = rows.flatMap(row => {
			const [a, b] = [first.cells[row], next.cells[row]];
			return isNumber(a) && isNumber(b) && a.value > 0 && b.value > 0 ? [Math.max(a.value, b.value) / Math.min(a.value, b.value)] : [];
		}).sort((a, b) => a - b);
		return ratios.length > 0 && (ratios[ratios.length >> 1] ?? Infinity) < QUANTITY_SPREAD;
	};
	for (const [at, first] of measures.entries()) {
		if (!BEFORE.test(first.header) || first.mixed || DELTA.test(first.header) || first.arrowShare >= 0.6) continue;
		let run = 1;
		let last = first;
		for (const next of measures.slice(at + 1)) {
			if (run === 4 || next.index !== last.index + 1) break;
			if (next.dim !== first.dim || next.unit !== first.unit || next.mixed || next.arrowShare >= 0.6 || BEFORE.test(next.header) || DELTA.test(next.header) || AGGREGATE.test(next.header) || !STAGE_HEADER.test(next.header) || !near(first, next)) break;
			run++;
			last = next;
		}
		if (run >= 3) return true;
	}
	return false;
}

/** Two same-unit measures of opposing amounts (`Removed | Added`, `Losses | Wins`): a butterfly chart. */
function opposedPair(measures: readonly Column[]): boolean {
	const plain = measures.filter(column => column.dim !== undefined && OPPOSED_DIMS.has(column.dim) && !column.mixed && column.arrowShare < 0.6 && (!DELTA.test(column.header) || OPPOSED.some(([, gains]) => gains.test(column.header))) && !AGGREGATE.test(column.header));
	return OPPOSED.some(([loses, gains]) => {
		const loss = plain.find(column => loses.test(column.header) && !gains.test(column.header));
		const gain = plain.find(column => gains.test(column.header) && !loses.test(column.header));
		return loss !== undefined && gain !== undefined && loss.dim === gain.dim && loss.unit === gain.unit;
	});
}

/**
 * One of the columns is the baseline the others move from (`baseline` beside `bash | http`) and two rows typically differ eightfold: the TUI
 * draws each row as factors of the baseline instead of bars on one axis.
 */
function againstBaseline(columns: readonly Column[], rows: readonly number[]): boolean {
	if (columns.length < 2 || columns.length > MAX_GROUPED + 1) return false;
	const baseline = columns.find(column => columns.every(other => other === column || isTransition(column.header, other.header)));
	if (!baseline) return false;
	const positive = (column: Column, row: number): boolean => {
		const cell = column.cells[row];
		return isNumber(cell) && cell.value > 0;
	};
	if (pairSpread(columns.map(column => rows.map(row => (positive(column, row) ? (column.cells[row] as NumberCell).value : Number.NaN)))) < ROW_SPREAD) return false;
	// Factors need rows holding the baseline and another value; without two of them the TUI keeps the bars.
	return rows.filter(row => positive(baseline, row) && columns.some(column => column !== baseline && positive(column, row))).length >= 2;
}

const KIND_WORD: Record<ChartKind, string> = { bar: "bar", grouped: "grouped bar", line: "line" };

function plan(header: readonly string[], source: readonly (readonly string[])[]): ChartSpec | null {
	if (source.length > MAX_ROWS || source.length < MIN_CATEGORIES) return null;
	const width = Math.min(header.length, MAX_COLUMNS);
	if (width < 2) return null;
	const headers = Array.from({ length: width }, (_, at) => clean(header[at], MAX_CELL));
	const parsed = source.map(row => Array.from({ length: width }, (_, at) => readCell(row[at] ?? "")));
	const columns = headers.map((text, at) => readColumn(at, text, parsed.map(row => row[at] ?? ({ kind: "missing", text: "" } satisfies OtherCell))));
	// A column that is mostly ranges (`1–5`, `6–10`, `24–72 h`) is bins or intervals: the TUI draws a histogram or a range chart.
	if (columns.some(column => column.rangeShare >= 0.5)) return null;

	// Without a text column, a leading column of named numbers (`4096B chunks`, `12-hover`) names the rows.
	const lead = columns[0];
	const unnamed = !columns.some(column => column.role === "label" || column.role === "temporal");
	if (lead?.role === "measure" && unnamed && lead.cells.some(cell => cell.kind !== "missing" && (!isNumber(cell) || cell.fit === "note" || cell.fit === "prose"))) lead.role = "label";
	const labels = columns.filter(column => column.role === "label" || column.role === "temporal");
	const worded = (cell: Cell | undefined) => cell !== undefined && cell.kind !== "missing" && ((cell.kind !== "id" && !isNumber(cell)) || /\s/.test(cell.text));
	let label = labels.find(column => column.cells.some(worded)) ?? labels[0] ?? columns.find(column => column.role === "sequence") ?? columns.find(column => column.role === "index");

	const everyRow = source.map((_, at) => at);
	const names = new Map<number, string>();
	for (const row of everyRow) names.set(row, label ? clean(label.cells[row]?.text, 28 * 2) : "");
	const summary = everyRow.map(row => label !== undefined && TOTAL_ROW.test(names.get(row) ?? ""));
	// A summary closes (or opens) the table, after any other summary rows; one amid the data only shares a name with one
	// unless its name is the bare summary word or its figure adds up the rows above it.
	const sumsAbove = (row: number): boolean =>
		columns.some(column => {
			const total = column.cells[row];
			if (column.role !== "measure" || !isNumber(total) || total.value <= 0) return false;
			let sum = 0;
			for (let above = row - 1; above >= 0; above--) {
				const cell = column.cells[above];
				if (!isNumber(cell) || cell.dim !== total.dim) return false;
				sum += cell.value;
				if (above < row - 1 && Math.abs(sum - total.value) <= total.value * APPROX_TOTAL) return true;
			}
			return false;
		});
	const totals: number[] = [];
	const data: number[] = [];
	for (const row of everyRow) {
		const summarizes = summary[row] === true && (summary.slice(row + 1).every(Boolean) || summary.slice(0, row).every(Boolean) || BARE_TOTAL.test(names.get(row) ?? "") || sumsAbove(row));
		(summarizes ? totals : data).push(row);
	}
	if (data.length < MIN_CATEGORIES) return null;
	for (const column of columns) {
		const values = new Set(pointsOf(column, data));
		column.constant = values.size === 1 && data.some(row => isNumber(column.cells[row]));
	}
	// A constant column that is one step of a sweep (`Step 8` at 165 in every row beside `Step 1` and `Step 4`) stays a measure.
	const sweepKey = (header: string): string => header.replace(/\d+(?:\.\d+)?/g, "#");
	const varying = new Set(columns.filter(column => column.role === "measure" && !column.constant && /\d/.test(column.header)).map(column => sweepKey(column.header)));
	for (const column of columns) if (column.constant && column.role === "measure" && varying.has(sweepKey(column.header))) column.constant = false;

	let measures = columns.filter(column => column.role === "measure" && !column.constant);
	// A target column held against a measure (`Target ≤ 200 µs`), the quantiles of one measurement, before/after metric pairs: bullet, ladder
	// and change charts.
	if (label && (hasTarget(columns, label, [...data, ...totals]) || hasLadder(columns, label, measures, data))) return null;
	if (metricPairCount(measures) >= 2) return null;
	// `Total tokens` beside parts that restate it is dropped when enough same-unit series remain.
	measures = measures.filter(column => {
		if (!AGGREGATE.test(column.header)) return true;
		const others = measures.filter(other => other !== column && other.dim === column.dim);
		if (others.length < 2) return true;
		const ratios = data.map(row => {
			const sum = others.reduce((acc, other) => acc + (other.cells[row] !== undefined && fits(other.cells[row], other) ? (other.cells[row] as NumberCell).value : 0), 0);
			const cell = column.cells[row];
			return fits(cell, column) ? cell.value / sum : Number.NaN;
		}).filter(Number.isFinite);
		return median(ratios) >= QUANTITY_SPREAD;
	});
	if (measures.length === 0) return null;

	let order = label ? axisOrder(label, data, names) : undefined;
	// Without a name column, a monotonic leading measure (`Workers | p50 | p99`) is the x axis of the rest.
	if (!order && label?.role !== "label" && measures.length >= 2 && measures[0]?.index === 0) {
		const xs = pointsOf(measures[0], data);
		if (xs.length === data.length && isMonotonic(xs)) {
			label = measures[0];
			measures = measures.slice(1);
			for (const row of data) names.set(row, clean(label.cells[row]?.text, 28 * 2));
			if (data.length >= MIN_CATEGORIES) order = "numeric";
		}
	}
	if (!label) return null;
	const axis = label;

	// Text columns carry the table and the numbers are small whole counts (tiers, ratings): the numbers only restate it.
	const prose = columns.reduce((total, column) => (column.role !== "label" || column === axis ? total : total + median(data.map(row => (column.cells[row]?.text ?? "").length))), 0);
	if (prose >= PROSE_CELL && measures.every(column => pointsOf(column, data).every(value => Number.isInteger(value) && Math.abs(value) <= MAX_PROSE_COUNT))) return null;
	// `Metric | Value`: each row is a quantity of its own; one axis would set unlike things side by side.
	if (measures.length === 1 && measures[0]?.arrowShare !== undefined && measures[0].arrowShare < 0.6 && axis.role === "label" && METRIC_HEADER.test(axis.header.trim())) return null;
	// Several `a → b` columns are drawn by the TUI as a change chart (a lone one, below, once the plotted columns are chosen).
	if (measures.filter(column => column.arrowShare >= 0.6).length >= 2) return null;
	if (hasComposition(measures, data, axis) || hasOutcomes(measures)) return null;
	if (measures.length === 1 && measures[0] && isFlow(axis, measures[0], names, data, totals)) return null;
	// Columns of mixed units (`12 ms`, `3 GB`, `45%` in one) share no axis: the TUI draws panels of them when they are half the measures,
	// else a mixed column keeps only the points of its own dominant dimension.
	if (measures.filter(column => column.mixed).length * 2 >= measures.length) return null;
	// A before column followed by later stages, opposing amounts, a before/after pair: slope, butterfly, change and paired charts.
	if (stageRun(measures, data) || opposedPair(measures)) return null;
	if (measures.length >= 2 && measures.length <= 4) {
		const before = measures.find(column => BEFORE.test(column.header));
		const after = measures.find(column => column !== before && column.dim === before?.dim && AFTER.test(column.header));
		if (before && after) return null;
	}

	let plotted: Column[];
	let rows: readonly number[] = data;
	const isLine = order !== undefined && data.length >= MIN_CATEGORIES;
	if (isLine) {
		const lead = measures[0];
		plotted = measures.filter(column => column.dim === lead?.dim && (column.dim !== "currency" && column.dim !== "rate" ? true : column.unit === lead?.unit)).slice(0, MAX_LINES);
		rows = chronological(data, axis);
	} else {
		// A lone `a → b` column among bars is where the TUI starts a before/after chart.
		if (measures.some(column => column.arrowShare >= 0.6)) return null;
		// Columns of unlike dimensions share no axis: the largest set of one dimension is drawn, and none without a clean set.
		const groups = new Map<string, Column[]>();
		for (const column of measures) {
			const key = column.dim === "currency" || column.dim === "rate" ? `${column.dim}:${column.unit}` : `${column.dim}`;
			groups.set(key, [...(groups.get(key) ?? []), column]);
		}
		let best: Column[] = [];
		for (const group of groups.values()) if (group.length > best.length) best = group;
		if (groups.size > 1 && best.length < 2) return null;
		plotted = best;
		// Four or more columns of one dimension are a heatmap in the TUI.
		if (plotted.length >= 4) return null;
		const [only, second] = plotted;
		if (only && plotted.length === 1) {
			const values = pointsOf(only, data);
			const sum = values.reduce((a, b) => a + b, 0);
			if (only.dim === "percent" && data.length <= 10 && values.every(value => value >= 0) && sum >= 97 && sum <= 103) return null;
			if (splitsTotal(axis, only, data, totals)) return null;
		}
		if (plotted.length <= 2 && plotted.some(column => (column.signedShare >= 0.6 || DELTA.test(column.header)) && pointsOf(column, data).some(value => value < 0))) return null;
		if (plotted.length >= 2 && isDots(plotted, data)) return null;
		const grid = data.map(row => plotted.map(column => {
			const cell = column.cells[row];
			return fits(cell, column) && cell.value > 0 ? cell.value : Number.NaN;
		}));
		// Columns that typically differ thirtyfold in a row count different quantities: the TUI draws panels of them
		// (timings and sizes that far apart are one measurement, which dots draw).
		if (plotted.length >= 2 && !DOT_DIMS.has(only?.dim ?? "count") && pairSpread(grid) >= QUANTITY_SPREAD) return null;
		if (plotted.length === 2 && only && second && isConditionPair(only.header, second.header)) return null;
		if (againstBaseline(plotted, data)) return null;
	}
	// A plotted `a → b` column is a before/after chart in the TUI (a lone one among bars, a dumbbell or factors).
	if (plotted.some(column => column.arrowShare >= 0.6)) return null;
	const { unit, factor } = displayUnit(plotted, rows);
	const built = buildSeries(plotted, rows, factor);
	if (built.series.length === 0) return null;
	const kind: ChartKind = isLine ? "line" : built.series.length > 1 ? "grouped" : "bar";
	const categories = rows.map(row => names.get(row) ?? "");
	if (kind === "bar" && categories.length > MAX_BAR_ROWS) return null;
	if (kind === "grouped" && categories.length > MAX_GROUPED_ROWS) return null;
	if (!worthDrawing(categories, built.series)) return null;

	const subject = listNames(built.series.map(entry => entry.name));
	const title = clean(axis.header ? `${subject} by ${axis.header}` : subject, 80);
	return { kind, title, categories, series: built.series, unit, alt: `${KIND_WORD[kind]} chart of ${title}` };
}

/**
 * The chart for a table, or `null`. `header` and `rows` hold the visible text of each cell (Markdown already stripped by the caller).
 * Never throws: a chart is decoration, so whatever the model wrote, the table still shows.
 */
export function planTableChart(header: readonly string[], rows: readonly (readonly string[])[]): ChartSpec | null {
	try {
		return plan(header, rows);
	} catch {
		return null;
	}
}

// ───────────────────────────── Numbers on an axis ─────────────────────────────

/** A 1, 2, 5 or 10 times a power of ten near `x` (rounded to the nearest such step). */
function niceStep(x: number): number {
	const exponent = Math.floor(Math.log10(x));
	const base = 10 ** exponent;
	const fraction = x / base;
	const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
	return nice * base;
}

/**
 * Axis ticks for `[min, max]`: evenly spaced round numbers (steps of 1, 2, 5 × a power of ten) that cover the range, about `target` of
 * them. A range of one value gets the zero line and that value. Non-finite input has no ticks.
 */
export function niceTicks(min: number, max: number, target = 5): readonly number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
	let low = Math.min(min, max);
	let high = Math.max(min, max);
	if (low === high) {
		if (low === 0) return [0, 1];
		if (low > 0) low = 0;
		else high = 0;
	}
	const count = Number.isFinite(target) ? Math.max(2, Math.min(12, Math.floor(target))) : 5;
	const step = niceStep((high - low) / (count - 1));
	if (!(step > 0) || !Number.isFinite(step)) return [low, high];
	const decimals = Math.min(15, Math.max(0, -Math.floor(Math.log10(step))));
	const first = Math.floor(low / step + 1e-9);
	const last = Math.ceil(high / step - 1e-9);
	if (last - first > 100) return [low, high];
	const ticks: number[] = [];
	for (let at = first; at <= last; at++) ticks.push(Number((at * step).toFixed(decimals)) + 0);
	return ticks;
}

const CURRENCY_SYMBOLS = "$€£¥";

function formatNumber(value: number): string {
	const abs = Math.abs(value);
	const compact = (scaled: number, suffix: string): string => `${Number(scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0)).toString()}${suffix}`;
	if (abs >= 1e12) return compact(abs / 1e12, "T");
	if (abs >= 1e9) return compact(abs / 1e9, "B");
	if (abs >= 1e6) return compact(abs / 1e6, "M");
	if (abs > 0 && abs < 0.001) return Number(abs.toPrecision(2)).toString();
	const decimals = abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
	const fixed = abs.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
	return fixed.replace(/^\d+/, whole => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
}

/** A value as the chart writes it: grouped digits (`1,200`), `M`/`B`/`T` from a million, the unit after it (`12 ms`, `45%`) or before (`$3`). */
export function formatChartValue(value: number, unit: string): string {
	if (!Number.isFinite(value)) return "";
	const sign = value < 0 && formatNumber(value) !== "0" ? "−" : "";
	const number = formatNumber(value);
	if (unit === "") return `${sign}${number}`;
	if (unit === "%" || unit === "×") return `${sign}${number}${unit}`;
	if (unit.length === 1 && CURRENCY_SYMBOLS.includes(unit)) return `${sign}${unit}${number}`;
	return `${sign}${number} ${unit}`;
}

// ───────────────────────────── Geometry ─────────────────────────────

/** The width of the drawing in its own units (it scales to the block); heights follow the data. */
export const CHART_WIDTH = 720;
const PAD = 12;
const LABEL_SIZE = 12;
const TICK_SIZE = 11;
const LEGEND_LINE = 18;
const LABEL_LIMIT = 28;
const LEGEND_LIMIT = 24;
const LINE_PLOT_HEIGHT = 200;

export interface LayoutText {
	readonly x: number;
	readonly y: number;
	readonly text: string;
	readonly anchor: "start" | "middle" | "end";
}
export interface LayoutTick {
	/** Where the tick lies along its axis. */
	readonly pos: number;
	readonly label: string;
}
export interface LayoutLegend {
	readonly series: number;
	readonly name: string;
	readonly x: number;
	readonly y: number;
}
export interface LayoutBar {
	readonly series: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** The bar's value at its end (single series only). */
	readonly value: LayoutText | null;
}
export interface LayoutBarRow {
	readonly label: LayoutText;
	/** The tooltip: the full category and every value of the row. */
	readonly title: string;
	readonly bars: readonly LayoutBar[];
}
export interface LayoutPlot {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}
export interface BarLayout {
	readonly kind: "bar" | "grouped";
	readonly width: number;
	readonly height: number;
	readonly plot: LayoutPlot;
	/** Vertical gridlines with their labels under the plot. */
	readonly ticks: readonly LayoutTick[];
	/** Where the value 0 lies. */
	readonly zero: number;
	readonly legend: readonly LayoutLegend[];
	readonly rows: readonly LayoutBarRow[];
}
export interface LayoutPoint {
	readonly x: number;
	readonly y: number;
	readonly title: string;
}
export interface LayoutLine {
	readonly series: number;
	/** Runs of consecutive points; a missing value ends one. */
	readonly segments: readonly (readonly { readonly x: number; readonly y: number }[])[];
	readonly dots: readonly LayoutPoint[];
}
export interface LineLayout {
	readonly kind: "line";
	readonly width: number;
	readonly height: number;
	readonly plot: LayoutPlot;
	/** Horizontal gridlines with their labels left of the plot. */
	readonly ticks: readonly LayoutTick[];
	readonly legend: readonly LayoutLegend[];
	/** The thinned category labels under the plot, each with its full text for a tooltip. */
	readonly xLabels: readonly (LayoutText & { readonly full: string })[];
	readonly lines: readonly LayoutLine[];
}
export type ChartLayout = BarLayout | LineLayout;

const round = (value: number): number => Math.round(value * 100) / 100;

/** The width `text` takes at `size`, estimated per character class: the drawing is laid out without a DOM to measure. */
export function estimateTextWidth(text: string, size: number): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code > 0x2e7f) width += 1;
		else if ("il.,:;|!'` ()[]".includes(char)) width += 0.32;
		else if ("mwMW@%".includes(char)) width += 0.85;
		else if (char >= "A" && char <= "Z") width += 0.64;
		else width += 0.56;
	}
	return width * size;
}

/** `text` cut to the characters that fit `limit` characters or `maxWidth` units, ending in `…` when cut. */
export function truncateLabel(text: string, limit: number, maxWidth: number, size: number): string {
	const chars = Array.from(text);
	let cut = chars.length > limit ? limit - 1 : chars.length;
	if (cut === chars.length && estimateTextWidth(text, size) <= maxWidth) return text;
	while (cut > 0 && estimateTextWidth(`${chars.slice(0, cut).join("")}…`, size) > maxWidth) cut--;
	return `${chars.slice(0, cut).join("").trimEnd()}…`;
}

function layoutLegend(spec: ChartSpec): { legend: LayoutLegend[]; height: number } {
	if (spec.series.length < 2) return { legend: [], height: 0 };
	const legend: LayoutLegend[] = [];
	let x = PAD;
	let row = 0;
	spec.series.forEach((entry, series) => {
		const name = truncateLabel(entry.name, LEGEND_LIMIT, 1e9, TICK_SIZE);
		const width = 15 + estimateTextWidth(name, TICK_SIZE) + 16;
		if (x > PAD && x + width > CHART_WIDTH - PAD) {
			x = PAD;
			row++;
		}
		legend.push({ series, name, x, y: PAD + row * LEGEND_LINE + LEGEND_LINE / 2 });
		x += width;
	});
	return { legend, height: (row + 1) * LEGEND_LINE + 8 };
}

function valueRange(spec: ChartSpec): [number, number] {
	let low = Infinity;
	let high = -Infinity;
	for (const entry of spec.series) {
		for (const value of entry.values) {
			if (value === null) continue;
			if (value < low) low = value;
			if (value > high) high = value;
		}
	}
	return Number.isFinite(low) ? [low, high] : [0, 1];
}

function layoutBars(spec: ChartSpec): BarLayout {
	const single = spec.series.length === 1;
	const [min, max] = valueRange(spec);
	const hasNegative = min < 0;
	const ticks = niceTicks(Math.min(0, min), Math.max(0, max));
	const low = ticks[0] ?? 0;
	const high = ticks[ticks.length - 1] ?? 1;
	const labels = spec.categories.map(category => truncateLabel(category, LABEL_LIMIT, 1e9, LABEL_SIZE));
	const labelWidth = Math.min(200, Math.max(28, ...labels.map(label => estimateTextWidth(label, LABEL_SIZE))));
	const valueWidth = single ? Math.max(0, ...spec.series.flatMap(entry => entry.values.map(value => (value === null ? 0 : estimateTextWidth(formatChartValue(value, spec.unit), TICK_SIZE))))) + 8 : 0;
	const left = PAD + labelWidth + 10 + (single && hasNegative ? valueWidth : 0);
	const right = CHART_WIDTH - PAD - (single && max > 0 ? valueWidth : 8);
	const scale = (value: number): number => round(left + ((value - low) / (high - low)) * (right - left));
	const zero = scale(0);
	const count = spec.categories.length;
	const bar = single ? (count <= 5 ? 18 : count <= 10 ? 16 : count <= 20 ? 14 : 11) : count <= 6 ? 10 : 8;
	const groupHeight = spec.series.length * (bar + 2) - 2;
	const rowHeight = single ? bar + 6 : groupHeight + 10;
	const { legend, height: legendHeight } = layoutLegend(spec);
	const top = PAD + legendHeight;
	const bottom = top + count * rowHeight;
	const rows = spec.categories.map((category, at): LayoutBarRow => {
		const y0 = top + at * rowHeight;
		const first = y0 + (rowHeight - groupHeight) / 2;
		const parts: string[] = [];
		const values: string[] = [];
		const bars: LayoutBar[] = [];
		spec.series.forEach((entry, series) => {
			const value = entry.values[at] ?? null;
			values.push(value === null ? "—" : formatChartValue(value, spec.unit));
			parts.push(`${entry.name}: ${values[series]}`);
			if (value === null) return;
			const y = round(first + series * (bar + 2));
			const end = scale(value);
			const x = Math.min(zero, end);
			const text = formatChartValue(value, spec.unit);
			bars.push({
				series,
				x,
				y,
				width: Math.max(round(Math.abs(end - zero)), value === 0 ? 0 : 1),
				height: bar,
				value: single ? { x: value < 0 ? round(end - 4) : round(end + 4), y: round(y + bar / 2), text, anchor: value < 0 ? "end" : "start" } : null,
			});
		});
		return {
			label: { x: PAD + labelWidth, y: round(y0 + rowHeight / 2), text: labels[at] ?? "", anchor: "end" },
			title: single ? `${category}: ${values[0] ?? "—"}` : `${category} — ${parts.join("; ")}`,
			bars,
		};
	});
	return {
		kind: single ? "bar" : "grouped",
		width: CHART_WIDTH,
		height: bottom + 30,
		plot: { left, right, top, bottom },
		ticks: ticks.map(tick => ({ pos: scale(tick), label: formatChartValue(tick, spec.unit) })),
		zero,
		legend,
		rows,
	};
}

function layoutLines(spec: ChartSpec): LineLayout {
	const [min, max] = valueRange(spec);
	// Counts and amounts start at zero unless the data sits in a narrow band far above it, which zero would flatten.
	const ticks = niceTicks(min >= 0 && min < max * 0.5 ? 0 : min, max);
	const low = ticks[0] ?? 0;
	const high = ticks[ticks.length - 1] ?? 1;
	const tickLabels = ticks.map(tick => formatChartValue(tick, spec.unit));
	const axisWidth = Math.max(...tickLabels.map(label => estimateTextWidth(label, TICK_SIZE)), 0);
	const left = PAD + axisWidth + 8;
	const right = CHART_WIDTH - PAD - 10;
	const { legend, height: legendHeight } = layoutLegend(spec);
	const top = PAD + legendHeight + 6;
	const bottom = top + LINE_PLOT_HEIGHT;
	const count = spec.categories.length;
	const xOf = (at: number): number => round(count === 1 ? (left + right) / 2 : left + (at / (count - 1)) * (right - left));
	const yOf = (value: number): number => round(bottom - ((value - low) / (high - low)) * LINE_PLOT_HEIGHT);
	const names = spec.categories.map(category => truncateLabel(category, 14, 1e9, TICK_SIZE));
	const widest = Math.max(0, ...names.map(name => estimateTextWidth(name, TICK_SIZE)));
	const spacing = count > 1 ? (right - left) / (count - 1) : right - left;
	const every = Math.max(1, Math.ceil((widest + 10) / spacing));
	const xLabels = names.flatMap((name, at) => {
		if (at % every !== 0) return [];
		const half = estimateTextWidth(name, TICK_SIZE) / 2;
		const x = round(Math.min(Math.max(xOf(at), PAD + half), CHART_WIDTH - PAD - half));
		return [{ x, y: bottom + 16, text: name, anchor: "middle" as const, full: spec.categories[at] ?? "" }];
	});
	const dotted = count <= 60;
	const lines = spec.series.map((entry, series): LayoutLine => {
		const segments: { x: number; y: number }[][] = [];
		const dots: LayoutPoint[] = [];
		let run: { x: number; y: number }[] = [];
		entry.values.forEach((value, at) => {
			if (value === null) {
				if (run.length > 0) segments.push(run);
				run = [];
				return;
			}
			const point = { x: xOf(at), y: yOf(value) };
			run.push(point);
			if (dotted) dots.push({ ...point, title: `${spec.categories[at] ?? ""} — ${entry.name}: ${formatChartValue(value, spec.unit)}` });
		});
		if (run.length > 0) segments.push(run);
		return { series, segments: segments.filter(segment => segment.length > 1), dots };
	});
	return {
		kind: "line",
		width: CHART_WIDTH,
		height: bottom + 34,
		plot: { left, right, top, bottom },
		ticks: ticks.map((tick, at) => ({ pos: yOf(tick), label: tickLabels[at] ?? "" })),
		legend,
		xLabels,
		lines,
	};
}

/** Where every mark of `spec` lies, in the drawing's own units ({@link CHART_WIDTH} wide). */
export function layoutChart(spec: ChartSpec): ChartLayout {
	return spec.kind === "line" ? layoutLines(spec) : layoutBars(spec);
}
