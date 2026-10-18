import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART_WIDTH, formatChartValue, layoutChart, MAX_BAR_ROWS, niceTicks, planTableChart, truncateLabel, type ChartSpec } from "./table-chart.ts";

/** The chart of a table written as `[header, ...rows]`. */
const chart = (header: string[], rows: string[][]): ChartSpec | null => planTableChart(header, rows);
const shape = (spec: ChartSpec | null) => (spec === null ? null : { kind: spec.kind, series: spec.series.map(entry => entry.name), n: spec.categories.length });
const NOTES = "this row explains in prose what happened and why it matters";

// The verdicts below were compared with OMP 18.11.1's own planner (`analyzeTable` → `planChart` → `buildChart` → `worthCharting`).

test("one count measure over five categories with a fivefold spread is a bar chart titled by its measure and its label", () => {
	const spec = chart(["Model", "Tokens"], [["A", "1,200"], ["B", "3,400"], ["C", "2,100"], ["D", "5,600"], ["E", "900"]]);
	assert.deepEqual(spec, {
		kind: "bar",
		title: "Tokens by Model",
		categories: ["A", "B", "C", "D", "E"],
		series: [{ name: "Tokens", values: [1200, 3400, 2100, 5600, 900] }],
		unit: "",
		alt: "bar chart of Tokens by Model",
	});
});

test("four rows within a 1.3× spread are not worth a chart; neither are values that are all but one the same", () => {
	assert.equal(chart(["Region", "Score"], [["a", "10"], ["b", "11"], ["c", "9"], ["d", "12"]]), null);
	assert.equal(chart(["Case", "Warnings"], [["a", "0"], ["b", "0"], ["c", "0"], ["d", "0"], ["e", "1"]]), null);
});

test("a date column orders a line chart; rows listed out of order are drawn in time order", () => {
	const spec = chart(["Date", "Requests"], [["2026-01-04", "400"], ["2026-01-01", "120"], ["2026-01-03", "90"], ["2026-01-02", "150"], ["2026-01-05", "180"]]);
	assert.equal(spec?.kind, "line");
	assert.deepEqual(spec?.categories, ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
	assert.deepEqual(spec?.series[0]?.values, [120, 150, 90, 400, 180]);
	assert.equal(spec?.title, "Requests by Date");
});

test("two same-unit measures are grouped bars when the draw gate passes: nine points or a threefold spread within a series", () => {
	// The note's table (8 points, spreads 2.5× and 2.3×) is not drawn by the TUI either; its fifth row makes ten points.
	assert.equal(chart(["Region", "Q1", "Q2"], [["North", "10", "12"], ["South", "20", "25"], ["East", "15", "11"], ["West", "8", "14"]]), null);
	const spec = chart(["Region", "Q1", "Q2"], [["North", "10", "12"], ["South", "20", "25"], ["East", "15", "11"], ["West", "8", "14"], ["Mid", "9", "30"]]);
	assert.deepEqual(shape(spec), { kind: "grouped", series: ["Q1", "Q2"], n: 5 });
	assert.equal(spec?.title, "Q1 and Q2 by Region");
	assert.deepEqual(shape(chart(["Region", "Q1", "Q2", "Q3"], [["N", "10", "12", "90"], ["S", "20", "25", "3"], ["E", "15", "11", "50"], ["W", "8", "14", "44"]])), { kind: "grouped", series: ["Q1", "Q2", "Q3"], n: 4 });
});

test("fewer than four categories get no chart: two rows, three rows, and four rows of which one is a total", () => {
	assert.equal(chart(["Operation", "Duration"], [["read", "12 ms"], ["write", "18 ms"]]), null);
	assert.equal(chart(["Name", "V"], [["a", "5"], ["b", "50"], ["c", "500"]]), null);
	assert.equal(chart(["Name", "V"], [["a", "5"], ["b", "50"], ["c", "500"], ["Total", "555"]]), null);
});

test("a prose table, a Metric | Value table and a column of mixed units are not charted", () => {
	assert.equal(chart(["Issue", "Notes", "Severity"], [["Crash", NOTES, "3"], ["Slow", NOTES, "2"], ["Typo", NOTES, "1"], ["Color", NOTES, "2"], ["Leak", NOTES, "4"]]), null);
	assert.equal(chart(["Metric", "Value"], [["events", "1200"], ["saved", "30"], ["median", "4"], ["p99", "900"], ["avg", "8"]]), null);
	assert.equal(chart(["Name", "Value"], [["a", "12 ms"], ["b", "3 GB"], ["c", "45%"], ["d", "1,200"], ["e", "7"]]), null);
});

test("an id, a date or a version column is not a measure: the table's measure alone is drawn", () => {
	assert.deepEqual(shape(chart(["Name", "ID", "Lines"], [["alpha", "001", "10"], ["beta", "002", "200"], ["gamma", "003", "30"], ["delta", "004", "400"], ["eps", "005", "5"]])), { kind: "bar", series: ["Lines"], n: 5 });
	assert.deepEqual(shape(chart(["Task", "Due", "Hours"], [["a", "2026-01-02", "3"], ["b", "2026-01-09", "12"], ["c", "2026-02-01", "40"], ["d", "2026-02-14", "1"], ["e", "2026-03-01", "8"]])), { kind: "bar", series: ["Hours"], n: 5 });
	assert.deepEqual(shape(chart(["Package", "Version", "Downloads"], [["a", "v1.2.3", "10"], ["b", "v1.2.4", "2,000"], ["c", "v1.3.0", "30"], ["d", "v2.0.0", "400"], ["e", "v2.1.0", "5"]])), { kind: "bar", series: ["Downloads"], n: 5 });
	// Seven or more digits written without separators read as a hash, as in the TUI.
	assert.equal(chart(["Model", "Tokens"], [["A", "1200000"], ["B", "3400000"], ["C", "2100000"], ["D", "5600000"], ["E", "900000"]]), null);
	assert.equal(chart(["Model", "Tokens"], [["A", "1,200,000"], ["B", "3,400,000"], ["C", "2,100,000"], ["D", "5,600,000"], ["E", "900,000"]])?.kind, "bar");
});

test("a Total row is set aside and a text label with Run, Day, Q, # or version names makes the rows an ordered axis", () => {
	const rows = [["A", "12"], ["B", "340"], ["C", "21"], ["D", "56"], ["E", "9"], ["F", "71"], ["G", "5"], ["H", "88"]];
	const spec = chart(["Model", "Count"], [...rows, ["Total", "602"]]);
	assert.deepEqual(spec?.categories, ["A", "B", "C", "D", "E", "F", "G", "H"]);
	assert.equal(spec?.kind, "bar");
	assert.equal(chart(["Run", "Time"], [["Run 1", "12 s"], ["Run 2", "14 s"], ["Run 3", "9 s"], ["Run 4", "30 s"]])?.kind, "line");
	assert.equal(chart(["Quarter", "Revenue"], [["Q1", "100"], ["Q2", "150"], ["Q3", "90"], ["Q4", "400"]])?.kind, "line");
	assert.equal(chart(["PR", "Lines"], [["#12", "10"], ["#13", "200"], ["#14", "30"], ["#15", "400"], ["#16", "5"]])?.kind, "line");
	// Weekday names alone are not an order the TUI draws as a line.
	assert.equal(chart(["Day", "Hits"], [["Mon", "100"], ["Tue", "150"], ["Wed", "90"], ["Thu", "400"], ["Fri", "300"]])?.kind, "bar");
});

test("amounts that a Total row sums, parts in a Category table and a count splitting a total are other chart kinds in the TUI: none here", () => {
	assert.equal(chart(["Model", "Tokens"], [["A", "12"], ["B", "340"], ["C", "21"], ["D", "56"], ["E", "9"], ["Total", "438"]]), null);
	assert.equal(chart(["Category", "Cost"], [["Rent", "$400"], ["Food", "$1,200"], ["Fun", "$300"], ["Misc", "$50"], ["Gas", "$20"]]), null);
	assert.equal(chart(["Model", "Count"], [["A", "12"], ["B", "340"], ["C", "21"], ["D", "56"], ["E", "9"], ["Total", "438"]]), null);
	assert.equal(chart(["Cat", "Cost"], [["Rent", "$1,200"], ["Food", "$400"], ["Fun", "$300"], ["Misc", "$50"], ["Gas", "$20"]])?.kind, "bar", "a ranking is a bar chart");
});

test("shares that make a whole, signed deltas, before/after pairs, arrows and several dimensions are not charted", () => {
	assert.equal(chart(["Tool", "Share"], [["a", "50%"], ["b", "30%"], ["c", "15%"], ["d", "5%"]]), null);
	assert.equal(chart(["Tool", "Delta"], [["a", "-3"], ["b", "5"], ["c", "-12"], ["d", "8"], ["e", "30"]]), null);
	assert.equal(chart(["Test", "Before", "After"], [["a", "10", "5"], ["b", "20", "8"], ["c", "15", "7"], ["d", "30", "9"], ["e", "40", "10"]]), null);
	assert.equal(chart(["Test", "Time"], [["a", "12 → 15"], ["b", "20 → 25"], ["c", "40 → 80"], ["d", "5 → 9"], ["e", "100 → 400"]]), null);
	assert.equal(chart(["Model", "Tokens", "Cost"], [["A", "1,200", "$3"], ["B", "3,400", "$9"], ["C", "2,100", "$5"], ["D", "5,600", "$14"], ["E", "900", "$2"]]), null, "no clean set of one dimension");
	assert.equal(chart(["R", "A", "B", "C", "D"], [["n", "1", "2", "3", "40"], ["s", "2", "3", "5", "70"], ["e", "1", "9", "4", "80"], ["w", "3", "3", "1", "20"]]), null, "four same-unit measures are a heatmap");
});

test("the dominant dimension is drawn: the columns of the largest set of one unit, the others are left out", () => {
	const spec = chart(["Model", "In", "Out", "Cost"], [["A", "1,200", "300", "$3"], ["B", "3,400", "900", "$9"], ["C", "2,100", "1,100", "$5"], ["D", "5,600", "100", "$14"], ["E", "900", "50", "$2"]]);
	assert.deepEqual(shape(spec), { kind: "grouped", series: ["In", "Out"], n: 5 });
});

test("percent, currency, rate, ratio and duration columns keep their unit; durations written in several units share the most written one", () => {
	assert.equal(chart(["Tool", "Pass rate"], [["a", "12.5%"], ["b", "80%"], ["c", "44%"], ["d", "3%"], ["e", "9%"]])?.unit, "%");
	const money = chart(["Plan", "Cost"], [["a", "$3.40"], ["b", "$1,200.00"], ["c", "$44"], ["d", "$3"], ["e", "$9"]]);
	assert.equal(money?.unit, "$");
	assert.deepEqual(money?.series[0]?.values, [3.4, 1200, 44, 3, 9]);
	assert.equal(chart(["Run", "Speed"], [["a", "12 t/s"], ["b", "80 t/s"], ["c", "44 t/s"], ["d", "3 t/s"], ["e", "9 t/s"]])?.unit, "t/s");
	assert.equal(chart(["Run", "Speedup"], [["a", "1.2x"], ["b", "8x"], ["c", "4.4x"], ["d", "3x"], ["e", "9x"]])?.unit, "×");
	const timings = chart(["Op", "Latency"], [["a", "250 ms"], ["b", "1.2 s"], ["c", "30 ms"], ["d", "900 ms"], ["e", "12 ms"]]);
	assert.equal(timings?.unit, "ms");
	assert.deepEqual(timings?.series[0]?.values, [250, 1200, 30, 900, 12]);
	const sizes = chart(["Dir", "Size"], [["a", "3 GB"], ["b", "200 MB"], ["c", "1.5 GB"], ["d", "20 MB"], ["e", "12 GB"]]);
	assert.equal(sizes?.unit, "GB");
	assert.deepEqual(sizes?.series[0]?.values, [3, 0.2, 1.5, 0.02, 12]);
});

test("the numeric reading takes the start of a range or an arrow-free estimate and the sign of a figure; thousands separators and 1.2k are read", () => {
	const spec = chart(["Name", "V"], [["a", "5–9"], ["b", "12 → 15"], ["c", "~5"], ["d", "+40"], ["e", "−30"], ["f", "1,000"], ["g", "1.2k"]]);
	assert.deepEqual(spec?.series[0]?.values, [5, 12, 5, 40, -30, 1000, 1200]);
	assert.equal(chart(["Model", "Tokens"], [["A", "1.2k"], ["B", "3.4k"], ["C", "2.1k"], ["D", "560"], ["E", "90"]])?.series[0]?.values.join(","), "1200,3400,2100,560,90");
	assert.deepEqual(chart(["Name", "V"], [["a", "1m 56s"], ["b", "5 s"], ["c", "40 s"], ["d", "300 s"], ["e", "2 s"]])?.series[0]?.values, [116, 5, 40, 300, 2]);
});

test("missing cells are gaps; a series with fewer than two points is dropped", () => {
	const spec = chart(["Model", "Tokens"], [["A", "1,200"], ["B", "-"], ["C", "2,100"], ["D", "5,600"], ["E", "n/a"], ["F", "900"]]);
	assert.deepEqual(spec?.series[0]?.values, [1200, null, 2100, 5600, null, 900]);
	const lines = chart(["Day", "A", "B"], [["Day 1", "1", "10"], ["Day 2", "2", "-"], ["Day 3", "3", "9"], ["Day 4", "7", "30"], ["Day 5", "1", "11"]]);
	assert.deepEqual(lines?.series[1]?.values, [10, null, 9, 30, 11]);
	assert.deepEqual(shape(chart(["Name", "A", "B"], [["a", "1", "-"], ["b", "30", "-"], ["c", "5", "-"], ["d", "400", "7"], ["e", "9", "-"]])), { kind: "bar", series: ["A"], n: 5 });
});

test("a line chart has up to six series of the first series' unit and a bar chart rows are kept in the table's order", () => {
	const header = ["Day", "A", "B", "C", "D", "E", "F", "G"];
	const rows = ["Day 1", "Day 2", "Day 3", "Day 4"].map((day, at) => [day, ...Array.from({ length: 7 }, (_, column) => String(1 + at * (column + 2)))]);
	assert.equal(chart(header, rows)?.series.length, 6);
	const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].map((date, at) => [date, String(10 * (at + 1)), `${at + 1} ms`]);
	assert.deepEqual(shape(chart(["Date", "Hits", "Time"], dates)), { kind: "line", series: ["Hits"], n: 4 });
});

test("duplicate headers keep both series; an empty header is named by its place", () => {
	const spec = chart(["Name", "Score", "Score"], [["a", "3", "30"], ["b", "50", "5"], ["c", "12", "7"], ["d", "80", "9"], ["e", "30", "60"]]);
	assert.deepEqual(spec?.series.map(entry => entry.name), ["Score", "Score"]);
	assert.deepEqual(chart(["Name", ""], [["a", "3"], ["b", "50"], ["c", "12"], ["d", "80"], ["e", "30"]])?.series.map(entry => entry.name), ["Series 1"]);
});

test("input that is huge, empty or hostile never throws: 300 rows and 40 columns are bounded, empty strings and prototype names are plain text", () => {
	const many = Array.from({ length: 300 }, (_, at) => [`row ${at}`, String(at * 3 + 1)]);
	assert.equal(chart(["Name", "V"], many), null, "a table beyond the row cap is not charted");
	const wide = chart(Array.from({ length: 40 }, (_, at) => (at === 0 ? "Name" : `M${at}`)), Array.from({ length: 6 }, (_, row) => Array.from({ length: 40 }, (_, at) => (at === 0 ? `r${row}` : String((row + 1) * (at + 1))))));
	assert.equal(wide, null);
	assert.equal(chart(["", "", ""], [["", "", ""], ["", "", ""], ["", "", ""], ["", "", ""]]), null);
	assert.equal(chart([], []), null);
	assert.equal(chart(["Name"], [["a"], ["b"], ["c"], ["d"]]), null);
	const hostile = chart(["__proto__", "constructor"], [["__proto__", "1"], ["constructor", "200"], ["toString", "30"], ["<script>alert(1)</script>", "4000"], ["a&b", "5"]]);
	assert.deepEqual(hostile?.categories, ["__proto__", "constructor", "toString", "<script>alert(1)</script>", "a&b"]);
	assert.equal(hostile?.series[0]?.name, "constructor");
	const cut = chart(["Name", "V"], [["a", "1".repeat(5000)], ["b", "2"], ["c", "3"], ["d", "4"]]);
	assert.ok(cut?.series[0]?.values.every(value => value === null || Number.isFinite(value)), "a cell is read up to a bound");
	assert.equal(chart(["Name", "V"], [["a", `${"9".repeat(150)}e9999`], ["b", "2"], ["c", "3"], ["d", "4"]]), null, "an overflowing number is no number");
	// Rows shorter or longer than the header read as missing and ignored cells.
	assert.deepEqual(shape(chart(["Name", "V"], [["a"], ["b", "5"], ["c", "50"], ["d", "500"], ["e", "9", "9", "9", "9"]])), { kind: "bar", series: ["V"], n: 5 });
});

test("more bars than a page holds legibly get no chart; the cap is stated", () => {
	const rows = Array.from({ length: MAX_BAR_ROWS + 1 }, (_, at) => [`item ${at}`, String(1 + at * 7)]);
	assert.equal(chart(["Name", "V"], rows), null);
	assert.equal(chart(["Name", "V"], rows.slice(0, MAX_BAR_ROWS))?.kind, "bar");
});

test("niceTicks covers the range with 1, 2 or 5 times a power of ten", () => {
	assert.deepEqual(niceTicks(0, 5600), [0, 1000, 2000, 3000, 4000, 5000, 6000]);
	assert.deepEqual(niceTicks(0, 100), [0, 20, 40, 60, 80, 100]);
	assert.deepEqual(niceTicks(-3, 12), [-5, 0, 5, 10, 15]);
	assert.deepEqual(niceTicks(0.1, 0.35), [0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
	assert.deepEqual(niceTicks(5, 5), [0, 1, 2, 3, 4, 5], "one value is shown against zero");
	assert.deepEqual(niceTicks(0, 0), [0, 1]);
	assert.deepEqual(niceTicks(-4, -4), [-4, -3, -2, -1, 0]);
	assert.deepEqual(niceTicks(10, 0), niceTicks(0, 10), "the bounds may come in any order");
	assert.deepEqual(niceTicks(Number.NaN, 1), []);
	assert.deepEqual(niceTicks(0, Number.POSITIVE_INFINITY), []);
	assert.ok(niceTicks(0, 1, Number.NaN).length >= 2);
	for (const [low, high] of [[0, 1e-9], [0, 1e15], [-1e9, 1e9], [3, 3.0000001]] as const) {
		const ticks = niceTicks(low, high);
		assert.ok(ticks.length >= 2 && ticks.length <= 101, `${low}..${high}: ${ticks.length} ticks`);
		assert.ok((ticks[0] ?? Infinity) <= low && (ticks[ticks.length - 1] ?? -Infinity) >= high, `${low}..${high} covered`);
	}
});

test("formatChartValue groups digits, abbreviates from a million and puts the unit where it is read", () => {
	assert.equal(formatChartValue(1234.5, ""), "1,234.5");
	assert.equal(formatChartValue(1200, ""), "1,200");
	assert.equal(formatChartValue(0.5, "%"), "0.5%");
	assert.equal(formatChartValue(3.4, "$"), "$3.4");
	assert.equal(formatChartValue(-12, "ms"), "−12 ms");
	assert.equal(formatChartValue(-3, "$"), "−$3");
	assert.equal(formatChartValue(1_200_000, ""), "1.2M");
	assert.equal(formatChartValue(2_500_000_000, ""), "2.5B");
	assert.equal(formatChartValue(0.00012, ""), "0.00012");
	assert.equal(formatChartValue(0, "ms"), "0 ms");
	assert.equal(formatChartValue(-0, ""), "0");
	assert.equal(formatChartValue(Number.NaN, "ms"), "");
	assert.equal(formatChartValue(12, "t/s"), "12 t/s");
	assert.equal(formatChartValue(4.4, "×"), "4.4×");
});

test("a bar layout puts every bar from the zero line, labels at the ends and a legend only for several series", () => {
	const spec = chart(["Model", "Tokens"], [["A", "1,200"], ["B", "3,400"], ["C", "2,100"], ["D", "5,600"], ["E", "900"]]);
	assert.ok(spec);
	const layout = layoutChart(spec);
	if (layout.kind !== "bar") return assert.fail("a bar layout");
	assert.equal(layout.width, CHART_WIDTH);
	assert.equal(layout.rows.length, 5);
	assert.equal(layout.legend.length, 0);
	assert.deepEqual(layout.ticks.map(tick => tick.label), ["0", "1,000", "2,000", "3,000", "4,000", "5,000", "6,000"]);
	const widths = layout.rows.map(row => row.bars[0]?.width ?? 0);
	assert.ok(widths[3] > widths[1] && widths[1] > widths[2] && widths[2] > widths[0] && widths[0] > widths[4], "lengths follow the values");
	assert.ok(layout.rows.every(row => row.bars.every(bar => bar.x === layout.zero)), "bars start at zero");
	assert.deepEqual(layout.rows.map(row => row.bars[0]?.value?.text), ["1,200", "3,400", "2,100", "5,600", "900"]);
	assert.ok(layout.rows.every(row => row.bars.every(bar => bar.x + bar.width <= layout.plot.right + 0.01 && (bar.value?.x ?? 0) < layout.width)));
	const grouped = chart(["Region", "Q1", "Q2"], [["North", "10", "12"], ["South", "20", "25"], ["East", "15", "11"], ["West", "8", "14"], ["Mid", "9", "30"]]);
	assert.ok(grouped);
	const groupedLayout = layoutChart(grouped);
	assert.equal(groupedLayout.legend.map(item => item.name).join(), "Q1,Q2");
	assert.ok(groupedLayout.kind === "grouped" && groupedLayout.rows.every(row => row.bars.length === 2 && row.bars.every(bar => bar.value === null)));
});

test("negative values extend left of the zero line with their label at the left end; a long label is cut with an ellipsis and keeps its full text in the tooltip", () => {
	const long = "a very long category name that cannot fit the label column";
	const spec: ChartSpec = { kind: "bar", title: "T", categories: [long, "b", "c", "d"], series: [{ name: "V", values: [-30, 10, 20, null] }], unit: "", alt: "" };
	const layout = layoutChart(spec);
	if (layout.kind === "line") return assert.fail("a bar layout");
	const [first] = layout.rows;
	assert.ok(first && first.label.text.endsWith("…") && first.label.text.length < long.length);
	assert.ok(first?.title.startsWith(long), "the tooltip has the full name");
	const negative = first?.bars[0];
	assert.ok(negative && negative.x < layout.zero && Math.abs(negative.x + negative.width - layout.zero) < 0.02);
	assert.equal(negative?.value?.anchor, "end");
	assert.equal(layout.rows[3]?.bars.length, 0, "a gap draws nothing");
});

test("a line layout leaves a gap at a missing value, thins crowded x labels and dots every point", () => {
	const dates = Array.from({ length: 40 }, (_, at) => `2026-02-${String(at + 1).padStart(2, "0")}`);
	const values = dates.map((_, at) => (at === 10 ? null : at + 1));
	const spec: ChartSpec = { kind: "line", title: "T", categories: dates, series: [{ name: "V", values }], unit: "", alt: "" };
	const layout = layoutChart(spec);
	assert.equal(layout.kind, "line");
	if (layout.kind !== "line") return;
	assert.equal(layout.lines[0]?.segments.length, 2);
	assert.equal(layout.lines[0]?.dots.length, 39);
	assert.ok(layout.xLabels.length < 20 && layout.xLabels.length >= 2, `${layout.xLabels.length} labels`);
	assert.equal(layout.xLabels[0]?.full, "2026-02-01");
	assert.ok(layout.xLabels.every(label => label.x >= 0 && label.x <= layout.width));
	const single = layoutChart({ ...spec, categories: ["only"], series: [{ name: "V", values: [5] }] });
	assert.equal(single.kind === "line" && single.lines[0]?.segments.length, 0, "one point has no segment, only its dot");
});

test("truncateLabel cuts at a character limit or a width and never splits a character", () => {
	assert.equal(truncateLabel("short", 28, 1e9, 12), "short");
	assert.equal(truncateLabel("abcdefghij", 5, 1e9, 12), "abcd…");
	assert.ok(truncateLabel("w".repeat(50), 100, 60, 12).endsWith("…"));
	assert.equal(truncateLabel("😀😀😀😀😀", 3, 1e9, 12), "😀😀…");
});
