import assert from "node:assert/strict";
import { test } from "node:test";
import { displayWidth, latexToBlock } from "./latex-block.ts";
import { latexToUnicode } from "./latex-unicode.ts";

/** Checks `[source, expected lines]` rows, naming the source of a failing row. */
function check(rows: readonly (readonly [string, readonly string[]])[]): void {
	for (const [source, expected] of rows) assert.deepEqual(latexToBlock(source), expected, source);
}

/** The block as one string with its edges visible, for a readable failure. */
function drawn(source: string): string {
	return latexToBlock(source).join("\n");
}

test("display width counts code points, combining marks as 0 and fullwidth text as 2", () => {
	assert.equal(displayWidth(""), 0);
	assert.equal(displayWidth("abc"), 3);
	assert.equal(displayWidth("x\u0302"), 1, "a combining circumflex adds no column");
	assert.equal(displayWidth("A\u20d7B\u0305"), 2);
	assert.equal(displayWidth("中文"), 4);
	assert.equal(displayWidth("ａ"), 2, "fullwidth Latin");
	assert.equal(displayWidth("😀"), 2);
	assert.equal(displayWidth("∑ᵢ₌₀ⁿ"), 5);
	assert.equal(displayWidth("𝐱"), 1, "a surrogate pair is one code point");
	assert.equal(displayWidth("⎡⎢⎣─│"), 5);
});

test("fractions stack over a rule of ─, centred, with the rule on the baseline of the line they sit in", () => {
	check([
		["\\frac{a}{b}", [" a", "───", " b"]],
		["\\frac{12}{5}", [" 12", "────", " 5"]],
		["\\dfrac{ab}{c}", [" ab", "────", " c"]],
		["x = \\frac{1}{2} + \\frac{x}{y+1}", ["     1      x", "x = ─── + ─────", "     2     y+1"]],
		["x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}", ["     -b ± √(b²-4ac)", "x = ────────────────", "           2a"]],
		["\\frac{\\frac{a}{b}}{c}", ["  a", " ───", "  b", "─────", "  c"]],
		["\\frac{1}{\\frac{1}{x}}", ["  1", "─────", "  1", " ───", "  x"]],
		["\\left( x \\right) + \\frac{1}{2}", ["         1", "( x ) + ───", "         2"]],
		["中文 \\frac{a}{b}", ["      a", "中文 ───", "      b"]],
		["\\sum_{i=0}^n \\frac{1}{i}", ["       1", "∑ᵢ₌₀ⁿ ───", "       i"]],
	]);
});

test("binomials are two rows in tall parentheses", () => {
	check([["\\binom{n}{k}", ["⎛ n ⎞", "⎜   ⎟", "⎝ k ⎠"]]]);
});

test("\\left … \\right stretch to tall content and stay flat around one line", () => {
	check([
		["\\left[ \\frac{a}{b} \\right]", ["⎡  a  ⎤", "⎢ ─── ⎥", "⎣  b  ⎦"]],
		["\\left( \\frac{a}{b} \\right)^2", ["⎛  a  ⎞", "⎜ ─── ⎟²", "⎝  b  ⎠"]],
		["\\left| \\frac{a}{b} \\right|", ["│  a  │", "│ ─── │", "│  b  │"]],
		["\\left\\{ \\frac{a}{b} \\right.", ["⎧  a", "⎨ ───", "⎩  b"]],
		["\\left\\langle \\frac{a}{b} \\right\\rangle", ["   a", "⟨ ─── ⟩", "   b"]],
		["\\left( x \\right)", ["( x )"]],
	]);
});

test("a radical over tall content is drawn; over one line it is the flat root", () => {
	check([
		["\\sqrt{\\frac{a}{b}}", [" ┌────", " │  a", " │ ───", "╲│  b"]],
		["\\sqrt[3]{\\frac{a}{b}}", ["  ┌────", "³ │  a", "  │ ───", " ╲│  b"]],
		["\\sqrt{x+1}", ["√(x+1)"]],
		["\\sqrt[3]{x}", ["∛x"]],
	]);
});

test("matrices have tall bracket pieces when they have more than one row", () => {
	check([
		["\\begin{pmatrix} 1 & 0 & 0 \\\\ 0 & 1 & 0 \\\\ 0 & 0 & 1 \\end{pmatrix}", ["⎛ 1  0  0 ⎞", "⎜ 0  1  0 ⎟", "⎝ 0  0  1 ⎠"]],
		["\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}", ["⎛ 1  2 ⎞", "⎝ 3  4 ⎠"]],
		["A = \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}", ["A = ⎡ a  b ⎤", "    ⎣ c  d ⎦"]],
		["\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix} = ad - bc", ["│ a  b │ = ad - bc", "│ c  d │"]],
		["\\begin{Vmatrix} a \\\\ b \\end{Vmatrix}", ["║ a ║", "║ b ║"]],
		["\\begin{Bmatrix} a \\\\ b \\\\ c \\end{Bmatrix}", ["⎧ a ⎫", "⎨ b ⎬", "⎩ c ⎭"]],
		["\\begin{matrix} a & b \\\\ c & dd \\end{matrix}", ["a  b", "c  dd"]],
		["\\begin{bmatrix} \\frac{1}{2} & x \\\\ y & 1 \\end{bmatrix}", ["⎡  1     ⎤", "⎢ ───  x ⎥", "⎢  2     ⎥", "⎢        ⎥", "⎣  y   1 ⎦"]],
		["\\begin{pmatrix} a \\\\ b \\end{pmatrix} \\begin{pmatrix} c \\\\ d \\end{pmatrix}", ["⎛ a ⎞ ⎛ c ⎞", "⎝ b ⎠ ⎝ d ⎠"]],
		["\\begin{pmatrix} a & b \\end{pmatrix}", ["(a  b)"]],
	]);
});

test("array columns follow their specification", () => {
	check([
		["\\begin{array}{lr} 1 & 22 \\\\ 333 & 4 \\end{array}", ["1    22", "333   4"]],
		["\\begin{array}{cc} a & bb \\\\ ccc & d \\end{array}", [" a   bb", "ccc  d"]],
		["\\begin{array}{c|r} 1 & 22 \\\\ \\hline 333 & 4 \\end{array}", [" 1   22", "333   4"]],
	]);
});

test("cases have a brace, with its point on the middle row", () => {
	check([
		["\\begin{cases} x & x>0 \\\\ 0 & x = 0 \\\\ -x & x < 0 \\end{cases}", ["⎧ x   x>0", "⎨ 0   x = 0", "⎩ -x  x < 0"]],
		["f(x) = \\begin{cases} x & x>0 \\\\ 0 & x \\le 0 \\\\ -1 & \\text{else} \\end{cases}", ["       ⎧ x   x>0", "f(x) = ⎨ 0   x ≤ 0", "       ⎩ -1  else"]],
		["\\begin{cases} 1 & a \\\\ 2 & b \\end{cases}", ["⎧ 1  a", "⎩ 2  b"]],
		["\\left\\{ \\begin{array}{l} a \\\\ b \\end{array} \\right.", ["⎧ a", "⎩ b"]],
		["\\begin{rcases} a \\\\ b \\end{rcases}", ["a ⎫", "b ⎭"]],
	]);
});

test("align-family rows line up at &, alternating right and left columns", () => {
	check([
		["\\begin{aligned} a &= b + c \\\\ d + e &= f \\end{aligned}", ["    a = b + c", "d + e = f"]],
		["\\begin{aligned} x &= 1 \\\\ yy &= 2 \\end{aligned}", [" x = 1", "yy = 2"]],
		["\\begin{align*} a &= b & c &= d \\\\ ee &= f & g &= h \\end{align*}", [" a = b   c = d", "ee = f   g = h"]],
		["\\begin{align} f(x) &= \\frac{1}{2} \\\\ g(x) &= 3 \\end{align}", ["        1", "f(x) = ───", "        2", "", "g(x) = 3"]],
		["\\begin{gather} a + b \\\\ c \\end{gather}", ["a + b", "c"]],
		["\\begin{split} a &= b \\\\ &= c \\end{split}", ["a = b", "  = c"]],
		["a &= 1 \\\\ b &= 2", ["a = 1", "b = 2"]],
	]);
});

test("row breaks outside environments, and line breaks, are separate lines", () => {
	check([
		["a \\\\ b", ["a", "b"]],
		["a \\\\ b \\\\", ["a", "b"]],
		["a = 1\nb = 2", ["a = 1", "b = 2"]],
		["\n\na\n\n\nb\n", ["a", "b"]],
		["x \\\\[3pt] y", ["x", "y"]],
		["x\n\\frac{a}{b}", ["x", " a", "───", " b"]],
		["\\begin{pmatrix} a \\\\ b \\end{pmatrix}\n\\begin{pmatrix} c \\\\ d \\end{pmatrix}", ["⎛ a ⎞", "⎝ b ⎠", "⎛ c ⎞", "⎝ d ⎠"]],
		["\\text{a \\\\ b}", ["a; b"]],
		["{a \\\\ b}", ["a; b"]],
	]);
});

test("a fragment with nothing to stack is the one-line conversion", () => {
	const flat = [
		"x^2 + y_i",
		"\\alpha + \\beta",
		"\\mathbb{R}^n",
		"\\sqrt{x+1}",
		"\\sqrt[3]{x}",
		"\\left( x \\right)",
		"\\left( \\alpha + 1 \\right)^2",
		"\\sum_{i=0}^{n} x_i",
		"e^{i\\pi} + 1 = 0",
		"\\hat{x} \\cdot \\vec{v}",
		"\\begin{pmatrix} 1 & 2 \\end{pmatrix}",
		"\\begin{aligned} x &= 1 \\end{aligned}",
		"\\begin{cases} x \\end{cases}",
		"\\foo + x",
		"a & b",
		"\\text{hello world}",
		"  spaced   out  ",
	];
	for (const source of flat) assert.deepEqual(latexToBlock(source), [latexToUnicode(source.trim())], source);
	assert.deepEqual(latexToBlock("a \\\\"), ["a"]);
});

test("a blank fragment has no lines", () => {
	for (const source of ["", " ", "\n\n", "\\\\"]) assert.deepEqual(latexToBlock(source), [], JSON.stringify(source));
});

test("what the layout cannot close stays flat while the rest still stacks", () => {
	check([
		["\\frac{a}", ["a/"]],
		["\\left( x", ["( x"]],
		["\\left( \\frac{a}{b}", ["   a", "( ───", "   b"]],
		["\\begin{pmatrix} 1 & 2", ["(1  2)"]],
		["\\begin{tabular}{c} a \\\\ b \\end{tabular}", ["a; b"]],
		["x \\begin{foo} \\frac{a}{b}", ["   a", "x ───", "   b"]],
	]);
});

test("colour commands are text, never escape codes", () => {
	check([
		["\\textcolor{red}{x} + \\frac{a}{b}", ["     a", "x + ───", "     b"]],
		["\\color{blue} \\frac{a}{b}", [" a", "───", " b"]],
	]);
	// eslint-disable-next-line no-control-regex
	assert.ok(!/\u001b/.test(drawn("\\textcolor{red}{\\frac{a}{b}}")));
});

const SAMPLES = [
	"\\frac{a}{b}",
	"x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}",
	"\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}",
	"\\begin{cases} x & x>0 \\\\ 0 & x \\le 0 \\end{cases}",
	"\\begin{aligned} a &= b \\\\ cc &= d \\end{aligned}",
	"\\left[ \\frac{a}{b} \\right] + \\binom{n}{k}",
	"\\sqrt{\\frac{a}{b}}",
	"a \\\\ b \\\\ \\frac{c}{d}",
	"中文 \\frac{a}{\\frac{b}{c}}",
];

test("lines have no trailing spaces and the result has no empty lines at its ends", () => {
	for (const source of SAMPLES) {
		const lines = latexToBlock(source);
		assert.ok(lines.length > 0, source);
		for (const line of lines) assert.equal(line, line.trimEnd(), `${source}: ${JSON.stringify(line)}`);
		assert.notEqual(lines[0], "", source);
		assert.notEqual(lines[lines.length - 1], "", source);
	}
});

test("every box line, even a wide one, lines up: the rule is as wide as the stacked parts", () => {
	for (const line of latexToBlock("中文 \\frac{a}{\\frac{b}{c}}")) assert.ok(displayWidth(line) <= displayWidth("中文 ─────"), line);
	const [top, rule, bottom] = latexToBlock("\\frac{中文}{ab}");
	assert.equal(displayWidth(rule ?? ""), 6, "two fullwidth characters are four columns, plus a column of margin each side");
	assert.equal(top, " 中文");
	assert.equal(bottom, "  ab");
});

test("input past the limits comes back flat and never throws", () => {
	const started = performance.now();
	const long = `\\frac{a}{b} ${"x".repeat(8100)}`;
	assert.deepEqual(latexToBlock(long), [long], "more than 8000 characters is returned as written");
	const multi = `${"x ".repeat(2000)}\n${"y ".repeat(2000)}\n`;
	assert.equal(latexToBlock(multi.repeat(2)).length > 0, true);
	const deep = `${"\\frac{a}{".repeat(30)}x${"}".repeat(30)}`;
	assert.equal(Array.isArray(latexToBlock(deep)), true, "30 nested fractions");
	const braces = `${"{".repeat(3000)}x${"}".repeat(3000)}`;
	assert.equal(Array.isArray(latexToBlock(braces)), true);
	const lefts = "\\left( ".repeat(1000);
	assert.equal(Array.isArray(latexToBlock(lefts)), true, "unclosed \\left again and again");
	const begins = "\\begin{pmatrix} ".repeat(300);
	assert.equal(Array.isArray(latexToBlock(begins)), true, "unclosed environments again and again");
	const rows = "a \\\\ ".repeat(1500);
	assert.equal(latexToBlock(rows).length, 1500);
	const fractions = "\\frac{a}{b} ".repeat(500);
	assert.ok(latexToBlock(fractions).length >= 3);
	const garbage = "\\{}^_$&%~'[]() ab1\n=+-".repeat(5000);
	assert.deepEqual(latexToBlock(garbage), garbage.split("\n").map(line => line.trimEnd()).filter((line, index, all) => !(line === "" && (index === 0 || index === all.length - 1))));
	assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)}ms`);
});

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const PIECES = [
	"\\frac", "\\frac{a}{b}", "\\sqrt", "\\sqrt[3]", "\\left(", "\\right)", "\\left\\{", "\\right.", "\\begin{pmatrix}", "\\end{pmatrix}", "\\begin{cases}",
	"\\end{cases}", "\\begin{aligned}", "\\end{aligned}", "\\begin{array}{cc}", "\\end{array}", "\\binom", "\\text{", "\\mathbf", "\\\\", "&", "\\hline",
	"^", "_", "{", "}", "[", "]", "(", ")", "$", " ", "\n", "a", "b", "x", "1", "-", "=", "中", "\\alpha", "\\over", "%", "\\",
];

test("fuzzed TeX-like text never throws, and its lines are clean strings", () => {
	const next = random(1_019_2024);
	for (let round = 0; round < 3000; round++) {
		let source = "";
		const length = 1 + Math.floor(next() * 50);
		for (let part = 0; part < length; part++) source += PIECES[Math.floor(next() * PIECES.length)] ?? "";
		const lines = latexToBlock(source);
		assert.ok(Array.isArray(lines), JSON.stringify(source));
		for (const line of lines) {
			assert.equal(typeof line, "string", JSON.stringify(source));
			assert.ok(!line.includes("\n") && !line.includes("\u0000") && !line.includes("undefined") && !line.includes("[object"), JSON.stringify(source));
			assert.equal(line, line.trimEnd(), JSON.stringify(source));
		}
		if (lines.length > 0) assert.ok(lines[0] !== "" && lines[lines.length - 1] !== "", JSON.stringify(source));
	}
});
