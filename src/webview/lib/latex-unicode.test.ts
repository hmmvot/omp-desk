import assert from "node:assert/strict";
import { test } from "node:test";
import { latexToUnicode } from "./latex-unicode.ts";

/** Checks `[source, expected]` rows, naming the source of a failing row. */
function check(rows: readonly (readonly [string, string])[]): void {
	for (const [source, expected] of rows) assert.equal(latexToUnicode(source), expected, source);
}

const cp = (code: number): string => String.fromCodePoint(code);

test("Greek letters, with TeX's lunate epsilon and closed phi for the plain commands", () => {
	check([
		["\\alpha\\beta\\gamma\\delta", "αβγδ"],
		["\\zeta\\eta\\theta\\iota\\kappa\\lambda\\mu\\nu\\xi\\pi\\rho\\sigma\\tau\\upsilon\\chi\\psi\\omega", "ζηθικλμνξπρστυχψω"],
		["\\Gamma \\Delta \\Theta \\Lambda \\Xi \\Pi \\Sigma \\Upsilon \\Phi \\Psi \\Omega", "Γ Δ Θ Λ Ξ Π Σ Υ Φ Ψ Ω"],
		["\\epsilon \\varepsilon", "ϵ ε"],
		["\\phi \\varphi", "ϕ φ"],
		["\\theta \\vartheta \\rho \\varrho \\pi \\varpi \\sigma \\varsigma \\kappa \\varkappa", "θ ϑ ρ ϱ π ϖ σ ς κ ϰ"],
		["\\varDelta", "Δ"],
	]);
});

test("operators, relations, arrows, sets, logic and delimiters", () => {
	const symbols: [string, string][] = [
		["infty", "∞"], ["partial", "∂"], ["nabla", "∇"], ["forall", "∀"], ["exists", "∃"], ["nexists", "∄"],
		["in", "∈"], ["notin", "∉"], ["ni", "∋"], ["subset", "⊂"], ["subseteq", "⊆"], ["supset", "⊃"], ["supseteq", "⊇"],
		["cup", "∪"], ["cap", "∩"], ["emptyset", "∅"], ["varnothing", "∅"], ["setminus", "∖"],
		["times", "×"], ["cdot", "⋅"], ["div", "÷"], ["pm", "±"], ["mp", "∓"], ["ast", "∗"], ["circ", "∘"], ["bullet", "∙"],
		["oplus", "⊕"], ["otimes", "⊗"], ["wedge", "∧"], ["vee", "∨"], ["land", "∧"], ["lor", "∨"], ["neg", "¬"],
		["leq", "≤"], ["le", "≤"], ["geq", "≥"], ["ge", "≥"], ["neq", "≠"], ["ne", "≠"], ["approx", "≈"], ["equiv", "≡"],
		["sim", "∼"], ["simeq", "≃"], ["cong", "≅"], ["propto", "∝"], ["ll", "≪"], ["gg", "≫"], ["perp", "⊥"], ["parallel", "∥"],
		["to", "→"], ["rightarrow", "→"], ["leftarrow", "←"], ["leftrightarrow", "↔"], ["Rightarrow", "⇒"], ["Leftarrow", "⇐"],
		["Leftrightarrow", "⇔"], ["mapsto", "↦"], ["implies", "⟹"], ["iff", "⟺"], ["uparrow", "↑"], ["downarrow", "↓"],
		["longrightarrow", "⟶"], ["hookrightarrow", "↪"], ["rightleftharpoons", "⇌"],
		["ldots", "…"], ["dots", "…"], ["cdots", "⋯"], ["vdots", "⋮"], ["ddots", "⋱"],
		["langle", "⟨"], ["rangle", "⟩"], ["lfloor", "⌊"], ["rfloor", "⌋"], ["lceil", "⌈"], ["rceil", "⌉"], ["vert", "|"], ["Vert", "‖"],
		["sum", "∑"], ["prod", "∏"], ["coprod", "∐"], ["int", "∫"], ["iint", "∬"], ["iiint", "∭"], ["oint", "∮"], ["bigcup", "⋃"], ["bigcap", "⋂"],
		["aleph", "ℵ"], ["hbar", "ℏ"], ["ell", "ℓ"], ["Re", "ℜ"], ["Im", "ℑ"], ["wp", "℘"], ["angle", "∠"], ["therefore", "∴"],
		["prime", "′"], ["dagger", "†"], ["star", "⋆"], ["top", "⊤"], ["bot", "⊥"], ["lt", "<"], ["gt", ">"],
	];
	for (const [name, glyph] of symbols) assert.equal(latexToUnicode(`\\${name}`), glyph, name);
});

test("function names are plain words, spaced from what follows", () => {
	check([
		["\\sin x", "sin x"],
		["\\sin\\theta", "sin θ"],
		["\\sin(x)", "sin(x)"],
		["\\sin{x}", "sin x"],
		["\\log_2 n", "log₂ n"],
		["\\lim_{n\\to\\infty} a_n", "lim_(n→∞) aₙ"],
		["\\max_{i} x_i", "maxᵢ xᵢ"],
		["\\ln x + \\exp y", "ln x + exp y"],
		["\\operatorname{rank}(A)", "rank(A)"],
		["\\operatorname{Hom}\\alpha", "Hom α"],
		["\\operatorname*{argmax} f", "argmax f"],
	]);
});

test("superscripts and subscripts are Unicode when every character has a form, else ^(…) and _(…)", () => {
	check([
		["x^2", "x²"],
		["x_i", "xᵢ"],
		["x_i^2", "xᵢ²"],
		["x^2_i", "x²ᵢ"],
		["e^{-x}", "e⁻ˣ"],
		["10^{-3}", "10⁻³"],
		["a_{ij}", "aᵢⱼ"],
		["x^{n+1}", "xⁿ⁺¹"],
		["x^{(k)}", "x⁽ᵏ⁾"],
		["x^{ab}", "xᵃᵇ"],
		["A^T", "Aᵀ"],
		["A^{-1}", "A⁻¹"],
		["A^\\top", "Aᵀ"],
		["x^\\alpha", "xᵅ"],
		["x^\\circ", "x°"],
		["90^\\circ", "90°"],
		["A^*", "A*"],
		["A^\\dagger", "A†"],
		["f^{\\prime}", "f′"],
		["\\sum_{i=0}^{n} x_i", "∑ᵢ₌₀ⁿ xᵢ"],
		["x_{i,j}", "x_(i,j)"],
		["x^q", "x^q"],
		["x^{qr}", "x^(qr)"],
		["x_\\alpha", "x_α"],
		["x_{\\alpha\\beta}", "x_(αβ)"],
		["x^{a^b}", "x^(aᵇ)"],
		["e^{i\\pi}", "e^(iπ)"],
		["x^2y", "x²y"],
		["2^{10}", "2¹⁰"],
		["x_{}", "x"],
	]);
});

test("primes", () => {
	check([
		["f'", "f′"],
		["f''", "f″"],
		["f'''", "f‴"],
		["f''''", "f⁗"],
		["f'''''", "f′′′′′"],
		["f'(x)", "f′(x)"],
		["f'_n", "f′ₙ"],
	]);
});

test("fractions: vulgar when they exist, parentheses only around non-atomic parts", () => {
	check([
		["\\frac{1}{2}", "½"],
		["\\frac12", "½"],
		["\\frac{3}{4}", "¾"],
		["\\dfrac{1}{3}", "⅓"],
		["\\tfrac{5}{8}", "⅝"],
		["\\frac{1}{10}", "⅒"],
		["\\frac{a}{b}", "a/b"],
		["\\frac{1}{x}", "1/x"],
		["\\frac{12}{5}", "12/5"],
		["\\frac{\\pi}{2}", "π/2"],
		["\\frac{x^2}{2}", "x²/2"],
		["\\frac{a+b}{c}", "(a+b)/c"],
		["\\frac{a}{b+c}", "a/(b+c)"],
		["\\frac{a+b}{c-d}", "(a+b)/(c-d)"],
		["\\frac{-b}{2a}", "(-b)/(2a)"],
		["\\frac{dy}{dx}", "(dy)/(dx)"],
		["\\frac{(a)}{b}", "(a)/b"],
		["\\frac{1}{2}x", "½x"],
		["2\\frac{1}{2}", "2(1/2)"],
		["x\\frac{1}{2}", "x½"],
		["\\frac{1}{3}+\\frac{2}{3}", "⅓+⅔"],
		["\\frac{\\frac{a}{b}}{c}", "(a/b)/c"],
		["{a \\over b}", "a/b"],
		["{a+b \\over c}", "(a+b)/c"],
		["{n \\choose k}", "C(n, k)"],
		["\\binom{n}{k}", "C(n, k)"],
		["\\dbinom{n}{2}", "C(n, 2)"],
	]);
});

test("radicals", () => {
	check([
		["\\sqrt{x}", "√x"],
		["\\sqrt x", "√x"],
		["\\sqrt2", "√2"],
		["\\sqrt{2}", "√2"],
		["\\sqrt{10}", "√10"],
		["\\sqrt{x+1}", "√(x+1)"],
		["\\sqrt{ab}", "√(ab)"],
		["\\sqrt{(a+b)}", "√(a+b)"],
		["\\sqrt{x^2+y^2}", "√(x²+y²)"],
		["\\sqrt[3]{x}", "∛x"],
		["\\sqrt[4]{x}", "∜x"],
		["\\sqrt[2]{x}", "√x"],
		["\\sqrt[n]{x}", "ⁿ√x"],
		["\\sqrt[5]{x+1}", "⁵√(x+1)"],
		["\\sqrt[q]{x}", "^q√x"],
		["\\frac{\\sqrt{3}}{2}", "(√3)/2"],
	]);
});

test("fonts use the Mathematical Alphanumeric Symbols block, with the letterlike holes", () => {
	check([
		["\\mathbb{R}", "ℝ"],
		["\\mathbb{N}\\mathbb{Z}\\mathbb{Q}\\mathbb{C}\\mathbb{H}\\mathbb{P}", "ℕℤℚℂℍℙ"],
		["\\mathbb{R}^n", "ℝⁿ"],
		["\\mathbb{A}", cp(0x1d538)],
		["\\mathbb{1}", cp(0x1d7d9)],
		["\\mathbf{x}", cp(0x1d431)],
		["\\mathbf{A}", cp(0x1d400)],
		["\\mathbf{0}", cp(0x1d7ce)],
		["\\mathbf x", cp(0x1d431)],
		["\\mathcal{C}", cp(0x1d49e)],
		["\\mathcal{L}", "ℒ"],
		["\\mathcal{F}", "ℱ"],
		["\\mathcal{e}", "ℯ"],
		["\\mathscr{A}", cp(0x1d49c)],
		["\\mathfrak{A}", cp(0x1d504)],
		["\\mathfrak{g}", cp(0x1d524)],
		["\\mathfrak{R}", "ℜ"],
		["\\mathit{x}", cp(0x1d465)],
		["\\mathit{h}", "ℎ"],
		["\\mathsf{x}", cp(0x1d5d1)],
		["\\mathtt{x}", cp(0x1d6a1)],
		["\\mathtt{7}", cp(0x1d7f6 + 7)],
		["\\boldsymbol{x}", cp(0x1d499)],
		["\\textbf{ab}", cp(0x1d41a) + cp(0x1d41b)],
		["\\textit{a}", cp(0x1d44e)],
		["\\mathbf{x+1}", `${cp(0x1d431)}+${cp(0x1d7cf)}`],
		["\\mathbf{\\alpha}", "α"],
		["\\mathbb{R}\\times\\mathbb{R}", "ℝ×ℝ"],
		["\\mathrm{d}x", "dx"],
		["\\mathrm{e}^{x}", "eˣ"],
		["\\mathrm{Var}(X)", "Var(X)"],
		["\\text{if } x>0", "if x>0"],
		["x \\text{ if } y", "x if y"],
		["x\\text{ and }y", "x and y"],
		["\\text{a_b^c}", "a_b^c"],
		["\\text{$x$ is {big}}", "x is big"],
		["\\text{don't}", "don't"],
		["\\text{50\\% of \\#1}", "50% of #1"],
	]);
});

test("accents are combining marks after each glyph", () => {
	check([
		["\\hat{x}", "x\u0302"],
		["\\hat x", "x\u0302"],
		["\\bar{x}", "x\u0304"],
		["\\vec{v}", "v\u20d7"],
		["\\dot{x}", "x\u0307"],
		["\\ddot{x}", "x\u0308"],
		["\\tilde{x}", "x\u0303"],
		["\\check{x}", "x\u030c"],
		["\\breve{x}", "x\u0306"],
		["\\acute{e}", "e\u0301"],
		["\\overline{AB}", "A\u0305B\u0305"],
		["\\underline{x}", "x\u0332"],
		["\\widehat{xy}", "x\u0302y\u0302"],
		["\\hat\\alpha", "α\u0302"],
		["\\hat{\\imath}", "ı\u0302"],
		["\\vec{AB}", "A\u20d7B\u20d7"],
		["\\cancel{x}", "x\u0338"],
		["\\not=", "≠"],
		["\\not\\in", "∉"],
		["\\not\\subset", "⊄"],
		["\\not\\approx", "≉"],
		["\\not\\perp", "⊥\u0338"],
	]);
});

test("\\left, \\right and \\big delimiters show their glyph", () => {
	check([
		["\\left( x \\right)", "( x )"],
		["\\left\\{ x \\right\\}", "{ x }"],
		["\\left[ x \\right]", "[ x ]"],
		["\\left\\langle x \\right\\rangle", "⟨ x ⟩"],
		["\\left\\| x \\right\\|", "‖ x ‖"],
		["\\left| x \\right|", "| x |"],
		["\\left\\lfloor x \\right\\rfloor", "⌊ x ⌋"],
		["\\left. x \\right|", "x |"],
		["\\left( x \\right.", "( x"],
		["\\bigl( x \\bigr)", "( x )"],
		["\\Big| x \\Big|", "| x |"],
		["\\Biggl[ x \\Biggr]", "[ x ]"],
		["a \\middle| b", "a | b"],
		["\\left(\\frac{a}{b}\\right)^2", "(a/b)²"],
	]);
});

test("spacing commands, tildes and whitespace", () => {
	check([
		["a\\,b", "a b"],
		["a\\:b", "a b"],
		["a\\;b", "a b"],
		["a\\ b", "a b"],
		["a~b", "a b"],
		["a\\quad b", "a  b"],
		["a\\qquad b", "a    b"],
		["a\\!b", "ab"],
		["a\\/b", "ab"],
		["a\\hspace{1em}b", "a b"],
		["a\\vspace{1em}b", "ab"],
		["\\displaystyle x", "x"],
		["a   +   b", "a + b"],
		["a\n+ b", "a + b"],
		["  x  ", "x"],
		["", ""],
		["   ", ""],
		["\\phantom{ab}", ""],
		["x\\phantom{ab}y", "x  y"],
		["\\vphantom{x}y", "y"],
		["a \\bmod b", "a mod b"],
		["a\\bmod b", "a mod b"],
		["x \\pmod{n}", "x (mod n)"],
		["\\tag{1}", "(1)"],
		["x \\label{eq:1}", "x"],
		["\\eqref{eq:1}", "(eq:1)"],
	]);
});

test("row breaks become `; ` and end-of-row breaks vanish", () => {
	check([
		["a \\\\ b", "a; b"],
		["a\\\\b", "a; b"],
		["a \\\\[2pt] b", "a; b"],
		["a \\\\ b \\\\", "a; b"],
		["\\\\ a", "a"],
		["a \\\\ \\\\ b", "a; b"],
		["a \\newline b", "a; b"],
		["\\substack{i<n \\\\ j>0}", "i<n, j>0"],
		["\\sum_{\\substack{i<n \\\\ j>0}} x", "∑_(i<n, j>0) x"],
	]);
});

test("environments are flattened on one line", () => {
	check([
		["\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}", "(1  2; 3  4)"],
		["\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}", "[a  b; c  d]"],
		["\\begin{Bmatrix} a \\end{Bmatrix}", "{a}"],
		["\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}", "|a  b; c  d|"],
		["\\begin{Vmatrix} a \\end{Vmatrix}", "‖a‖"],
		["\\begin{matrix} 1 & 2 \\\\ 3 & 4 \\end{matrix}", "1  2; 3  4"],
		["\\begin{smallmatrix} 1 & 2 \\end{smallmatrix}", "1  2"],
		["\\begin{array}{cc} 1 & 2 \\\\ 3 & 4 \\end{array}", "1  2; 3  4"],
		["\\begin{array}{c|c} a & b \\\\ \\hline c & d \\end{array}", "a  b; c  d"],
		["\\begin{cases} 1 & x>0 \\\\ 0 & x\\le0 \\end{cases}", "{1  x>0; 0  x≤0"],
		["f(x)=\\begin{cases} x & x>0 \\\\ -x & \\text{otherwise} \\end{cases}", "f(x)={x  x>0; -x  otherwise"],
		["\\begin{rcases} a \\\\ b \\end{rcases}", "a; b}"],
		["\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}", "a = b; c = d"],
		["\\begin{align*} a &= b \\\\ c &\\le d \\end{align*}", "a = b; c ≤ d"],
		["\\begin{align} x&=1 \\end{align}", "x=1"],
		["\\begin{alignedat}{2} a &= b & c &= d \\end{alignedat}", "a = b c = d"],
		["\\begin{gather} a \\\\ b \\end{gather}", "a; b"],
		["\\begin{split} a &= b \\\\ &= c \\end{split}", "a = b; = c"],
		["\\begin{equation} x \\end{equation}", "x"],
		["\\begin{pmatrix} 1 \\\\ 2 \\\\ \\end{pmatrix}", "(1; 2)"],
		["\\begin{pmatrix} \\end{pmatrix}", "()"],
		["\\begin{pmatrix} \\begin{pmatrix}1\\end{pmatrix} & 2 \\end{pmatrix}", "((1)  2)"],
		["\\begin{pmatrix} 1 & 2", "(1  2)"],
		["\\begin{pmatrix} \\frac{1}{2} & x^2 \\end{pmatrix}", "(½  x²)"],
		["\\begin{pmatrix} 1 & & 3 \\end{pmatrix}", "(1    3)"],
		["x \\end{pmatrix}", "x"],
	]);
});

test("an unknown command stays as its literal name; table names never resolve to prototype members", () => {
	check([
		["\\foo", "\\foo"],
		["\\foo + x", "\\foo + x"],
		["\\constructor", "\\constructor"],
		["\\toString", "\\toString"],
		["\\hasOwnProperty", "\\hasOwnProperty"],
		["\\valueOf", "\\valueOf"],
		["\\sin\\constructor", "sin \\constructor"],
		["\\begin{constructor} x \\end{constructor}", "x"],
		["x\\", "x\\"],
	]);
});

test("escapes, comments and colour commands", () => {
	check([
		["\\{a\\}", "{a}"],
		["\\$5", "$5"],
		["50\\%", "50%"],
		["50%", "50%"],
		["a \\& b", "a & b"],
		["\\#1", "#1"],
		["a\\_b", "a_b"],
		["a \\| b", "a ‖ b"],
		["% a comment\nx", "x"],
		["x\n  % a comment\ny", "x y"],
		["a % b", "a % b"],
		["\\textcolor{red}{x}", "x"],
		["\\textcolor[rgb]{1,0,0}{x+1}", "x+1"],
		["\\color{blue} y", "y"],
		["a \\color{red} b", "a b"],
		["\\colorbox{yellow}{z}", "z"],
		["\\fcolorbox{red}{green}{t}", "t"],
		["\\definecolor{mine}{rgb}{1,0,0}x", "x"],
		["\\normalcolor y", "y"],
		["\\boxed{x}", "[x]"],
		["\\overset{a}{=}", "=ᵃ"],
		["\\underset{a}{=}", "=ₐ"],
		["\\xrightarrow{f}", "→ᶠ"],
		["\\xrightarrow[i]{f}", "→ᶠᵢ"],
		["\\overbrace{x}", "⏞(x)"],
		["\\prescript{a}{i}{X}", "ᵃᵢX"],
		["a$b", "a$b"],
	]);
});

test("whole expressions", () => {
	check([
		["e^{i\\pi} + 1 = 0", "e^(iπ) + 1 = 0"],
		["\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}", "∫₀^∞ e^(-x²) dx = (√π)/2"],
		["\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\epsilon_0}", `∇ ⋅ ${cp(0x1d404)} = ρ/ϵ₀`],
		["\\forall \\epsilon > 0\\ \\exists \\delta > 0", "∀ ϵ > 0 ∃ δ > 0"],
		["\\mathbb{E}[X] = \\sum_{i} x_i p_i", "𝔼[X] = ∑ᵢ xᵢ pᵢ".replace("𝔼", cp(0x1d53c))],
		["A \\subseteq B \\iff \\forall x (x \\in A \\Rightarrow x \\in B)", "A ⊆ B ⟺ ∀ x (x ∈ A ⇒ x ∈ B)"],
		["\\hat{\\beta} = (X^T X)^{-1} X^T y", "β\u0302 = (XᵀX)⁻¹ Xᵀ y".replace("XᵀX", "Xᵀ X")],
		["a \\leq b \\leq c", "a ≤ b ≤ c"],
		["\\{ x \\mid x > 0 \\}", "{ x ∣ x > 0 }"],
		["\\langle u, v \\rangle", "⟨ u, v ⟩"],
	]);
});

test("input past the limits is returned unchanged", () => {
	const long = `x^2 + ${"y ".repeat(4100)}`;
	assert.ok(long.length > 8000);
	assert.equal(latexToUnicode(long), long, "more than 8000 characters");
	assert.equal(latexToUnicode("x".repeat(7999)), "x".repeat(7999), "just under the limit converts");
	const ok = `${"{".repeat(20)}x${"}".repeat(20)}`;
	assert.equal(latexToUnicode(ok), "x", "20 levels of braces");
	const deep = `${"{".repeat(30)}x${"}".repeat(30)}`;
	assert.equal(latexToUnicode(deep), deep, "more than 24 levels of nesting");
	const thousands = `${"{".repeat(3000)}x${"}".repeat(3000)}`;
	assert.equal(latexToUnicode(thousands), thousands, "thousands of braces");
	const chain = `${"\\hat".repeat(1500)}x`;
	assert.equal(latexToUnicode(chain), chain, "a chain of commands with no braces is nested just the same");
	const tokens = "a^1".repeat(2600);
	assert.ok(tokens.length < 8000);
	assert.equal(latexToUnicode(tokens), tokens, "more than a few thousand tokens");
	assert.equal(latexToUnicode("a^1".repeat(50)), "a¹".repeat(50), "a few score tokens convert");
});

test("a command's raw arguments are scanned a bounded number of times", () => {
	const started = performance.now();
	const unclosed = "\\text{".repeat(1300);
	assert.equal(typeof latexToUnicode(unclosed), "string");
	const refs = "\\ref{".repeat(1500);
	assert.equal(typeof latexToUnicode(refs), "string");
	assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)}ms`);
});

/** A deterministic generator, so a failing fuzz input can be reproduced. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const PIECES = [
	"\\frac", "\\sqrt", "\\left", "\\right", "\\begin{pmatrix}", "\\end{pmatrix}", "\\begin{cases}", "\\end{cases}", "\\begin{aligned}",
	"\\text{", "\\mathbf", "\\mathbb{R}", "\\hat", "\\not", "\\over", "\\\\", "\\,", "\\alpha", "\\sum", "\\textcolor{red}", "\\operatorname",
	"\\xrightarrow", "\\binom", "\\genfrac", "\\substack", "\\overset", "\\sqrt[", "\\color", "\\end", "\\begin", "\\", "%", "&", "^", "_", "'",
	"{", "}", "[", "]", "(", ")", "$", "~", " ", "\n", "a", "b", "x", "1", "2", "-", "+", "=", "é", "😀", "\u0300", "\u0000",
];

test("fuzzed TeX-like text never throws and always yields a clean string", () => {
	const next = random(20_241_019);
	for (let round = 0; round < 3000; round++) {
		let source = "";
		const length = 1 + Math.floor(next() * 60);
		for (let part = 0; part < length; part++) source += PIECES[Math.floor(next() * PIECES.length)] ?? "";
		const result = latexToUnicode(source);
		assert.equal(typeof result, "string", JSON.stringify(source));
		assert.ok(!result.includes("undefined") && !result.includes("[object") && !result.includes("\u0000"), JSON.stringify(source));
		assert.ok(result === source || !/[\r\n]/.test(result), JSON.stringify(source) + " must stay on one line");
	}
	// Printable ASCII with the metacharacters of TeX, in longer runs.
	const alphabet = "\\{}^_$&%~'[]()ab1 \n=+-/*<>|!.,;:#@";
	for (let round = 0; round < 300; round++) {
		let source = "";
		const length = Math.floor(next() * 400);
		for (let at = 0; at < length; at++) source += alphabet.charAt(Math.floor(next() * alphabet.length));
		assert.equal(typeof latexToUnicode(source), "string", JSON.stringify(source));
	}
	const garbage = Array.from({ length: 100_000 }, () => alphabet.charAt(Math.floor(next() * alphabet.length))).join("");
	assert.equal(latexToUnicode(garbage), garbage, "1e5 characters of garbage come back unchanged");
	const dense = Array.from({ length: 7900 }, () => alphabet.charAt(Math.floor(next() * alphabet.length))).join("");
	assert.equal(typeof latexToUnicode(dense), "string");
});
