/**
 * LaTeX math to Unicode text: the one-line conversion behind inline `$…$` and the flat runs of a display block.
 *
 * A browser could typeset math with KaTeX, but the transcript's Find and Quote features rely on the text shown being
 * the DOM text, and KaTeX would add a dependency, fonts and a CSP surface. So, as OMP's terminal UI does, math
 * becomes plain Unicode: Greek letters, operators, super- and subscript digits (x², xᵢ), fonts from the Mathematical
 * Alphanumeric Symbols block (ℝ 𝐱 𝒞 𝔄), accents as combining marks (x̂), fractions (½, (a+b)/c) and radicals (√x). Colour
 * commands have no effect here (`\textcolor{red}{x}` is `x`): the output is text, never markup.
 *
 * All input is untrusted model output, so the work is bounded: input past {@link MAX_INPUT} characters, nesting past
 * {@link MAX_DEPTH} or more than {@link MAX_TOKENS} commands and groups is returned unchanged, and nothing throws.
 */

const MAX_INPUT = 8000;
const MAX_DEPTH = 24;
const MAX_TOKENS = 4000;
/** Characters a raw-argument scan may read in all; a stream of unclosed `{` would otherwise rescan the input per command. */
const MAX_SCAN = 200_000;

/** Raised inside the parser when a bound is exceeded; the caller returns its input unchanged. */
class Bail extends Error {}

/** Marks a `\\` row break while text is built; {@link finish} turns the marks into `; `. Never present in input (it is removed). */
const ROW = "\u0000";

// ---------------------------------------------------------------------------
// Character maps
// ---------------------------------------------------------------------------

/**
 * Superscript forms. Unicode lacks several letters (q, and capitals such as C, F, Q, S, X, Y, Z), so a script
 * group with any character missing here falls back to `^(…)` as a whole instead of mixing sizes. Prime, star,
 * dagger and `\circ` are kept as the glyph itself (`f^{\prime}`, `A^*`, `A^\dagger`, `90^\circ`), `\top` is the
 * transpose `ᵀ`.
 */
const SUPERSCRIPT: Readonly<Record<string, string>> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	α: "ᵅ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	ε: "ᵋ",
	θ: "ᶿ",
	ι: "ᶥ",
	φ: "ᵠ",
	χ: "ᵡ",
	"′": "′",
	"″": "″",
	"‴": "‴",
	"⁗": "⁗",
	"*": "*",
	"∗": "∗",
	"†": "†",
	"‡": "‡",
	"∘": "°",
	"°": "°",
	"⊤": "ᵀ",
};

/** Subscript forms: even sparser than superscripts (no b, c, d, f, g, q, w, y, z and no capitals). */
const SUBSCRIPT: Readonly<Record<string, string>> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	φ: "ᵩ",
	χ: "ᵪ",
};

/** Prime runs `f'`, `f''`, `f'''`, `f''''`; longer runs repeat the single prime. */
const PRIMES = ["", "′", "″", "‴", "⁗"] as const;

/**
 * Vulgar fractions, keyed by the rendered `numerator/denominator`. Used only when nothing digit-like precedes the
 * fraction (`2\frac12` is two times a half, which `2½` would read as two and a half).
 */
const VULGAR: Readonly<Record<string, string>> = {
	"1/2": "½",
	"1/3": "⅓",
	"2/3": "⅔",
	"1/4": "¼",
	"3/4": "¾",
	"1/5": "⅕",
	"2/5": "⅖",
	"3/5": "⅗",
	"4/5": "⅘",
	"1/6": "⅙",
	"5/6": "⅚",
	"1/7": "⅐",
	"1/8": "⅛",
	"3/8": "⅜",
	"5/8": "⅝",
	"7/8": "⅞",
	"1/9": "⅑",
	"1/10": "⅒",
	"0/3": "↉",
};

/** `\not` followed by a relation with a dedicated negated glyph; any other base gets a combining solidus. */
const NOT_MAP: Readonly<Record<string, string>> = {
	"=": "≠",
	"<": "≮",
	">": "≯",
	"∈": "∉",
	"∋": "∌",
	"⊂": "⊄",
	"⊃": "⊅",
	"⊆": "⊈",
	"⊇": "⊉",
	"≡": "≢",
	"∃": "∄",
	"≤": "≰",
	"≥": "≱",
	"≈": "≉",
	"≅": "≇",
	"∼": "≁",
	"≃": "≄",
	"∣": "∤",
	"∥": "∦",
	"≺": "⊀",
	"≻": "⊁",
	"⊑": "⋢",
	"⊒": "⋣",
};

/** Accent commands: the combining mark placed after each base glyph of the argument. */
const ACCENTS: Readonly<Record<string, string>> = {
	hat: "\u0302",
	widehat: "\u0302",
	check: "\u030C",
	widecheck: "\u030C",
	tilde: "\u0303",
	widetilde: "\u0303",
	acute: "\u0301",
	grave: "\u0300",
	dot: "\u0307",
	ddot: "\u0308",
	dddot: "\u20DB",
	ddddot: "\u20DC",
	breve: "\u0306",
	bar: "\u0304",
	vec: "\u20D7",
	overrightarrow: "\u20D7",
	overleftarrow: "\u20D6",
	mathring: "\u030A",
	overline: "\u0305",
	underline: "\u0332",
	underbar: "\u0332",
	cancel: "\u0338",
	bcancel: "\u20E5",
	sout: "\u0336",
};

/** Commands that render as their upright name: `\sin`, `\log`, `\lim`. A space follows when an argument starts right after. */
const FUNCTIONS: Readonly<Record<string, true>> = {
	sin: true,
	cos: true,
	tan: true,
	cot: true,
	sec: true,
	csc: true,
	sinh: true,
	cosh: true,
	tanh: true,
	coth: true,
	arcsin: true,
	arccos: true,
	arctan: true,
	arccot: true,
	arcsec: true,
	arccsc: true,
	sech: true,
	csch: true,
	ln: true,
	log: true,
	lg: true,
	exp: true,
	lim: true,
	limsup: true,
	liminf: true,
	injlim: true,
	projlim: true,
	max: true,
	min: true,
	sup: true,
	inf: true,
	det: true,
	dim: true,
	ker: true,
	hom: true,
	arg: true,
	deg: true,
	gcd: true,
	lcm: true,
	Pr: true,
	argmax: true,
	argmin: true,
	sgn: true,
	tr: true,
	rank: true,
	diag: true,
	mod: true,
};

type Font =
	| "bold"
	| "italic"
	| "bolditalic"
	| "script"
	| "fraktur"
	| "doublestruck"
	| "boldscript"
	| "boldfraktur"
	| "sans"
	| "sansbold"
	| "sansitalic"
	| "sansbolditalic"
	| "mono"
	| null;

/**
 * Font commands. `null` is upright math: the argument is converted with no font (ASCII is already upright, so
 * `\mathrm{d}x` is `dx`). `\mathscr` is the script alphabet, as `\mathcal`. Greek letters are left unstyled by every
 * font: only Latin letters and digits have a style in all alphabets.
 */
const FONT_COMMANDS: Readonly<Record<string, Font>> = {
	mathbf: "bold",
	boldsymbol: "bolditalic",
	bm: "bolditalic",
	pmb: "bold",
	mathit: "italic",
	mathbfit: "bolditalic",
	mathbb: "doublestruck",
	Bbb: "doublestruck",
	mathds: "doublestruck",
	mathbbm: "doublestruck",
	mathcal: "script",
	mathscr: "script",
	mathbfscr: "boldscript",
	mathbfcal: "boldscript",
	mathfrak: "fraktur",
	mathbffrak: "boldfraktur",
	mathsf: "sans",
	mathsfit: "sansitalic",
	mathsfbf: "sansbold",
	mathbfsf: "sansbold",
	mathsfbfit: "sansbolditalic",
	mathtt: "mono",
	mathrm: null,
	mathnormal: null,
};

/** Text-mode commands: the argument is prose (spaces kept, `^` and `_` literal), in the font given. */
const TEXT_COMMANDS: Readonly<Record<string, Font>> = {
	text: null,
	textrm: null,
	textnormal: null,
	textup: null,
	textmd: null,
	textsc: null,
	mbox: null,
	hbox: null,
	textbf: "bold",
	textit: "italic",
	textsl: "italic",
	emph: "italic",
	texttt: "mono",
	textsf: "sans",
};

interface Plane {
	readonly upper: number;
	readonly lower: number;
	readonly digit?: number;
}

/** First code point of A, a and 0 in each style of the Mathematical Alphanumeric Symbols block (U+1D400–U+1D7FF). */
const PLANES: Readonly<Record<Exclude<Font, null>, Plane>> = {
	bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	italic: { upper: 0x1d434, lower: 0x1d44e },
	bolditalic: { upper: 0x1d468, lower: 0x1d482 },
	script: { upper: 0x1d49c, lower: 0x1d4b6 },
	boldscript: { upper: 0x1d4d0, lower: 0x1d4ea },
	fraktur: { upper: 0x1d504, lower: 0x1d51e },
	doublestruck: { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8 },
	boldfraktur: { upper: 0x1d56c, lower: 0x1d586 },
	sans: { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 },
	sansbold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
	sansitalic: { upper: 0x1d608, lower: 0x1d622 },
	sansbolditalic: { upper: 0x1d63c, lower: 0x1d656 },
	mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
};

/** Letters Unicode keeps in the Letterlike Symbols block instead of the alphabet's own slot (the reserved "holes"). */
const HOLES: Readonly<Record<string, string>> = {
	"italic:h": "ℎ",
	"script:B": "ℬ",
	"script:E": "ℰ",
	"script:F": "ℱ",
	"script:H": "ℋ",
	"script:I": "ℐ",
	"script:L": "ℒ",
	"script:M": "ℳ",
	"script:R": "ℛ",
	"script:e": "ℯ",
	"script:g": "ℊ",
	"script:o": "ℴ",
	"fraktur:C": "ℭ",
	"fraktur:H": "ℌ",
	"fraktur:I": "ℑ",
	"fraktur:R": "ℜ",
	"fraktur:Z": "ℨ",
	"doublestruck:C": "ℂ",
	"doublestruck:H": "ℍ",
	"doublestruck:N": "ℕ",
	"doublestruck:P": "ℙ",
	"doublestruck:Q": "ℚ",
	"doublestruck:R": "ℝ",
	"doublestruck:Z": "ℤ",
};

/**
 * Environments flattened onto one line: `[open, close, cell separator]`. Rows are always separated by `; `. A matrix
 * keeps its delimiter (`(1  2; 3  4)`), `cases` its brace, and the `align` family shows no `&` (an empty cell
 * separator: the spaces around `&` in the source are the spacing, so `x &= 1` reads `x = 1`). An environment not
 * listed is flattened like a bare matrix.
 */
const ENVIRONMENTS: Readonly<Record<string, readonly [string, string, string]>> = {
	matrix: ["", "", "  "],
	smallmatrix: ["", "", "  "],
	array: ["", "", "  "],
	subarray: ["", "", "  "],
	tabular: ["", "", "  "],
	pmatrix: ["(", ")", "  "],
	bmatrix: ["[", "]", "  "],
	Bmatrix: ["{", "}", "  "],
	vmatrix: ["|", "|", "  "],
	Vmatrix: ["‖", "‖", "  "],
	cases: ["{", "", "  "],
	dcases: ["{", "", "  "],
	rcases: ["", "}", "  "],
	drcases: ["", "}", "  "],
	aligned: ["", "", ""],
	alignedat: ["", "", ""],
	align: ["", "", ""],
	alignat: ["", "", ""],
	flalign: ["", "", ""],
	split: ["", "", ""],
	gather: ["", "", ""],
	gathered: ["", "", ""],
	gatheredat: ["", "", ""],
	multline: ["", "", ""],
	eqnarray: ["", "", ""],
	equation: ["", "", ""],
	displaymath: ["", "", ""],
	math: ["", "", ""],
};

/** Environments whose `\begin` is followed by a column or count specification (`{ccc}`, `{2}`) to skip. */
const ENVIRONMENTS_WITH_SPEC: Readonly<Record<string, true>> = {
	array: true,
	tabular: true,
	subarray: true,
	alignat: true,
	alignedat: true,
	gatheredat: true,
};

/** `\x…arrow[below]{above}`: the arrow glyph; the labels become scripts. */
const EXTENSIBLE_ARROWS: Readonly<Record<string, string>> = {
	xleftarrow: "←",
	xrightarrow: "→",
	xleftrightarrow: "↔",
	xLeftarrow: "⇐",
	xRightarrow: "⇒",
	xLeftrightarrow: "⇔",
	xmapsto: "↦",
	xhookleftarrow: "↩",
	xhookrightarrow: "↪",
	xtwoheadrightarrow: "↠",
	xtwoheadleftarrow: "↞",
	xrightleftharpoons: "⇌",
	xleftrightharpoons: "⇋",
};

/** Braces and brackets drawn around the argument, as `⏞(x)`. */
const WRAPPED: Readonly<Record<string, readonly [string, string]>> = {
	boxed: ["[", "]"],
	fbox: ["[", "]"],
	overbrace: ["⏞(", ")"],
	underbrace: ["⏟(", ")"],
	overbracket: ["⎴(", ")"],
	underbracket: ["⎵(", ")"],
	overparen: ["⏜(", ")"],
	underparen: ["⏝(", ")"],
	pmod: ["(mod ", ")"],
	pod: ["(", ")"],
	tag: ["(", ")"],
};

/** Commands that mean spacing or layout and show nothing but, at most, a space. */
const SPACING: Readonly<Record<string, string>> = {
	quad: "  ",
	qquad: "    ",
	enspace: " ",
	thinspace: " ",
	medspace: " ",
	thickspace: " ",
	space: " ",
	negthinspace: "",
	negmedspace: "",
	negthickspace: "",
	displaystyle: "",
	textstyle: "",
	scriptstyle: "",
	scriptscriptstyle: "",
	limits: "",
	nolimits: "",
	nonumber: "",
	notag: "",
	hline: "",
	hdashline: "",
	toprule: "",
	midrule: "",
	bottomrule: "",
	strut: "",
	mathstrut: "",
	centering: "",
	relax: "",
	allowbreak: "",
	nobreak: "",
	protect: "",
	ignorespaces: "",
	normalcolor: "",
	newline: ROW,
	cr: ROW,
};

/** Commands whose argument passes through as math: spacing-class wrappers. */
const TRANSPARENT: Readonly<Record<string, true>> = {
	mathbin: true,
	mathrel: true,
	mathop: true,
	mathord: true,
	mathopen: true,
	mathclose: true,
	mathpunct: true,
	mathinner: true,
	displaystylebox: true,
	smash: true,
	mathchoice: true,
};

/**
 * The symbol table: Greek, operators, relations, arrows, sets, logic and delimiters.
 *
 * Choices where TeX and Unicode differ (they follow `unicode-math`): `\epsilon` is the lunate ϵ and `\varepsilon`
 * the curly ε; `\phi` is the closed ϕ and `\varphi` the looped φ; `\cdot` is U+22C5 (the dot operator), `\bullet` is
 * U+2219, `\perp` and `\bot` are ⊥, `\langle` and `\rangle` are the mathematical angle brackets U+27E8 and U+27E9
 * (not the CJK ones), `\emptyset` and `\varnothing` are both ∅. `\to` and `\rightarrow` are →; the `\long…` and
 * `\Long…` forms use the long arrows U+27F5–U+27F9. Dots: `\ldots` and `\dots` are …, `\cdots` is ⋯.
 */
const SYMBOLS: Readonly<Record<string, string>> = {
	// Greek, lower case
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ϵ",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	varkappa: "ϰ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	omicron: "ο",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "ϕ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	digamma: "ϝ",
	// Greek, upper case (the `\var…` forms are the slanted capitals; plain capitals here)
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	varGamma: "Γ",
	varDelta: "Δ",
	varTheta: "Θ",
	varLambda: "Λ",
	varXi: "Ξ",
	varPi: "Π",
	varSigma: "Σ",
	varUpsilon: "Υ",
	varPhi: "Φ",
	varPsi: "Ψ",
	varOmega: "Ω",
	// Big operators
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	iiiint: "⨌",
	oint: "∮",
	oiint: "∯",
	oiiint: "∰",
	bigcup: "⋃",
	bigcap: "⋂",
	bigvee: "⋁",
	bigwedge: "⋀",
	bigoplus: "⨁",
	bigotimes: "⨂",
	bigodot: "⨀",
	biguplus: "⨄",
	bigsqcup: "⨆",
	// Binary operators
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	cdot: "⋅",
	cdotp: "⋅",
	centerdot: "⋅",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "∙",
	bigcirc: "◯",
	oplus: "⊕",
	ominus: "⊖",
	otimes: "⊗",
	oslash: "⊘",
	odot: "⊙",
	circledast: "⊛",
	circledcirc: "⊚",
	circleddash: "⊝",
	boxplus: "⊞",
	boxminus: "⊟",
	boxtimes: "⊠",
	boxdot: "⊡",
	cup: "∪",
	cap: "∩",
	Cup: "⋓",
	Cap: "⋒",
	doublecup: "⋓",
	doublecap: "⋒",
	uplus: "⊎",
	sqcup: "⊔",
	sqcap: "⊓",
	vee: "∨",
	wedge: "∧",
	lor: "∨",
	land: "∧",
	barwedge: "⊼",
	veebar: "⊻",
	curlywedge: "⋏",
	curlyvee: "⋎",
	setminus: "∖",
	smallsetminus: "∖",
	wr: "≀",
	amalg: "⨿",
	dagger: "†",
	ddagger: "‡",
	dag: "†",
	ddag: "‡",
	diamond: "⋄",
	triangleleft: "◁",
	triangleright: "▷",
	bigtriangleup: "△",
	bigtriangledown: "▽",
	lhd: "⊲",
	rhd: "⊳",
	unlhd: "⊴",
	unrhd: "⊵",
	dotplus: "∔",
	ltimes: "⋉",
	rtimes: "⋊",
	divideontimes: "⋇",
	intercal: "⊺",
	// Relations
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	leqq: "≦",
	geqq: "≧",
	leqslant: "⩽",
	geqslant: "⩾",
	neq: "≠",
	ne: "≠",
	approx: "≈",
	thickapprox: "≈",
	approxeq: "≊",
	equiv: "≡",
	sim: "∼",
	thicksim: "∼",
	simeq: "≃",
	cong: "≅",
	propto: "∝",
	varpropto: "∝",
	asymp: "≍",
	doteq: "≐",
	triangleq: "≜",
	coloneqq: "≔",
	eqqcolon: "≕",
	ll: "≪",
	gg: "≫",
	lll: "⋘",
	ggg: "⋙",
	lesssim: "≲",
	gtrsim: "≳",
	lessgtr: "≶",
	gtrless: "≷",
	prec: "≺",
	succ: "≻",
	preceq: "⪯",
	succeq: "⪰",
	preccurlyeq: "≼",
	succcurlyeq: "≽",
	precsim: "≾",
	succsim: "≿",
	nless: "≮",
	ngtr: "≯",
	nleq: "≰",
	ngeq: "≱",
	nsim: "≁",
	ncong: "≇",
	napprox: "≉",
	nequiv: "≢",
	nprec: "⊀",
	nsucc: "⊁",
	lneq: "⪇",
	gneq: "⪈",
	perp: "⊥",
	bot: "⊥",
	top: "⊤",
	mid: "∣",
	nmid: "∤",
	parallel: "∥",
	nparallel: "∦",
	vdash: "⊢",
	dashv: "⊣",
	vDash: "⊨",
	Vdash: "⊩",
	models: "⊨",
	nvdash: "⊬",
	nvDash: "⊭",
	sqsubset: "⊏",
	sqsupset: "⊐",
	sqsubseteq: "⊑",
	sqsupseteq: "⊒",
	bowtie: "⋈",
	Join: "⨝",
	smile: "⌣",
	frown: "⌢",
	vartriangleleft: "⊲",
	vartriangleright: "⊳",
	trianglelefteq: "⊴",
	trianglerighteq: "⊵",
	multimap: "⊸",
	// Sets and logic
	in: "∈",
	notin: "∉",
	ni: "∋",
	owns: "∋",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	nsubset: "⊄",
	nsupset: "⊅",
	nsubseteq: "⊈",
	nsupseteq: "⊉",
	subsetneq: "⊊",
	supsetneq: "⊋",
	subsetneqq: "⫋",
	supsetneqq: "⫌",
	Subset: "⋐",
	Supset: "⋑",
	emptyset: "∅",
	varnothing: "∅",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	neg: "¬",
	lnot: "¬",
	implies: "⟹",
	impliedby: "⟸",
	iff: "⟺",
	therefore: "∴",
	because: "∵",
	complement: "∁",
	// Arrows
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	gets: "←",
	leftrightarrow: "↔",
	Rightarrow: "⇒",
	Leftarrow: "⇐",
	Leftrightarrow: "⇔",
	mapsto: "↦",
	mapsfrom: "↤",
	longmapsto: "⟼",
	longrightarrow: "⟶",
	longleftarrow: "⟵",
	longleftrightarrow: "⟷",
	Longrightarrow: "⟹",
	Longleftarrow: "⟸",
	Longleftrightarrow: "⟺",
	uparrow: "↑",
	downarrow: "↓",
	updownarrow: "↕",
	Uparrow: "⇑",
	Downarrow: "⇓",
	Updownarrow: "⇕",
	nearrow: "↗",
	searrow: "↘",
	swarrow: "↙",
	nwarrow: "↖",
	hookrightarrow: "↪",
	hookleftarrow: "↩",
	rightharpoonup: "⇀",
	rightharpoondown: "⇁",
	leftharpoonup: "↼",
	leftharpoondown: "↽",
	upharpoonleft: "↿",
	upharpoonright: "↾",
	downharpoonleft: "⇃",
	downharpoonright: "⇂",
	rightleftharpoons: "⇌",
	leftrightharpoons: "⇋",
	leadsto: "⇝",
	rightsquigarrow: "⇝",
	leftrightsquigarrow: "↭",
	twoheadrightarrow: "↠",
	twoheadleftarrow: "↞",
	rightarrowtail: "↣",
	leftarrowtail: "↢",
	looparrowright: "↬",
	looparrowleft: "↫",
	curvearrowright: "↷",
	curvearrowleft: "↶",
	circlearrowright: "↻",
	circlearrowleft: "↺",
	Rrightarrow: "⇛",
	Lleftarrow: "⇚",
	rightrightarrows: "⇉",
	leftleftarrows: "⇇",
	leftrightarrows: "⇆",
	rightleftarrows: "⇄",
	upuparrows: "⇈",
	downdownarrows: "⇊",
	nrightarrow: "↛",
	nleftarrow: "↚",
	nleftrightarrow: "↮",
	nRightarrow: "⇏",
	nLeftarrow: "⇍",
	nLeftrightarrow: "⇎",
	Rsh: "↱",
	Lsh: "↰",
	// Delimiters
	langle: "⟨",
	rangle: "⟩",
	lfloor: "⌊",
	rfloor: "⌋",
	lceil: "⌈",
	rceil: "⌉",
	lbrace: "{",
	rbrace: "}",
	lbrack: "[",
	rbrack: "]",
	vert: "|",
	lvert: "|",
	rvert: "|",
	Vert: "‖",
	lVert: "‖",
	rVert: "‖",
	backslash: "\\",
	textbackslash: "\\",
	slash: "/",
	lgroup: "⟮",
	rgroup: "⟯",
	llbracket: "⟦",
	rrbracket: "⟧",
	ulcorner: "⌜",
	urcorner: "⌝",
	llcorner: "⌞",
	lrcorner: "⌟",
	lmoustache: "⎰",
	rmoustache: "⎱",
	lt: "<",
	gt: ">",
	colon: ":",
	// Dots
	ldots: "…",
	dots: "…",
	dotsc: "…",
	dotso: "…",
	mathellipsis: "…",
	cdots: "⋯",
	dotsb: "⋯",
	dotsm: "⋯",
	dotsi: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	iddots: "⋰",
	adots: "⋰",
	// Miscellaneous
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	prime: "′",
	backprime: "‵",
	aleph: "ℵ",
	beth: "ℶ",
	gimel: "ℷ",
	daleth: "ℸ",
	hbar: "ℏ",
	hslash: "ℏ",
	ell: "ℓ",
	wp: "℘",
	Re: "ℜ",
	Im: "ℑ",
	mho: "℧",
	Finv: "Ⅎ",
	Game: "⅁",
	imath: "ı",
	jmath: "ȷ",
	eth: "ð",
	angle: "∠",
	measuredangle: "∡",
	sphericalangle: "∢",
	surd: "√",
	Box: "□",
	square: "□",
	blacksquare: "■",
	Diamond: "◇",
	lozenge: "◊",
	blacklozenge: "⧫",
	triangle: "△",
	triangledown: "▽",
	blacktriangle: "▲",
	blacktriangledown: "▼",
	blacktriangleleft: "◀",
	blacktriangleright: "▶",
	bigstar: "★",
	checkmark: "✓",
	flat: "♭",
	natural: "♮",
	sharp: "♯",
	clubsuit: "♣",
	diamondsuit: "♢",
	heartsuit: "♡",
	spadesuit: "♠",
	degree: "°",
	copyright: "©",
	pounds: "£",
	S: "§",
	P: "¶",
	ldotp: ".",
	Bbbk: "𝕜",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An own property of a static table: command names come from untrusted text, so `constructor` must not resolve. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** `ch` (one code point) in the alphabet of `font`; characters the alphabet lacks stay as they are. */
function styleChar(ch: string, font: Font): string {
	if (font === null) return ch;
	const code = ch.codePointAt(0) ?? 0;
	const plane = PLANES[font];
	if (code >= 0x41 && code <= 0x5a) return own(HOLES, `${font}:${ch}`) ?? String.fromCodePoint(plane.upper + code - 0x41);
	if (code >= 0x61 && code <= 0x7a) return own(HOLES, `${font}:${ch}`) ?? String.fromCodePoint(plane.lower + code - 0x61);
	if (code >= 0x30 && code <= 0x39 && plane.digit !== undefined) return String.fromCodePoint(plane.digit + code - 0x30);
	return ch;
}

const COMBINING = /\p{M}/u;

/** Number of base glyphs: code points, combining marks not counted. */
function glyphCount(text: string): number {
	let count = 0;
	for (const ch of text) if (!COMBINING.test(ch)) count++;
	return count;
}

/** `mark` after every base glyph of `text` (spaces and row marks excepted). */
function applyCombining(text: string, mark: string): string {
	let out = "";
	for (const ch of text) out += ch === " " || ch === ROW || COMBINING.test(ch) ? ch : ch + mark;
	return out;
}

/** The script form of `text` (`sup` picks superscripts), or the `^(…)` / `_(…)` spelling when a character lacks one. */
function toScript(text: string, sup: boolean): string {
	if (text === "") return "";
	const table = sup ? SUPERSCRIPT : SUBSCRIPT;
	let mapped = "";
	for (const ch of text) {
		const form = own(table, ch);
		if (form === undefined) {
			const mark = sup ? "^" : "_";
			return glyphCount(text) > 1 ? `${mark}(${text})` : mark + text;
		}
		mapped += form;
	}
	return mapped;
}

/** A balanced `(…)` as a whole: the first `(` closes only at the last character. */
function bracketed(text: string): boolean {
	if (!text.startsWith("(") || !text.endsWith(")")) return false;
	let depth = 0;
	for (let at = 0; at < text.length; at++) {
		const ch = text.charAt(at);
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return at === text.length - 1;
	}
	return false;
}

const NUMBER = /^[\p{N}.]+$/u;
/** One variable, with at most scripts or primes after it: `x`, `x²`, `xᵢ`, `f′`. */
const VARIABLE = /^[\p{L}\p{M}][\p{N}\p{Lm}′″‴⁗\p{M}]*$/u;

/** Whether `text` is read as one unit by a `/` or a `√` next to it, so it needs no parentheses. */
function atomic(text: string): boolean {
	return NUMBER.test(text) || VARIABLE.test(text) || bracketed(text);
}

function wrapUnit(text: string): string {
	return text === "" || atomic(text) ? text : `(${text})`;
}

/** `\text{…}`-style unescaping of one raw argument: `\&`, `\%`, `\$`, `\#`, `\_`, `\{`, `\}`, `~`, and any whitespace as one space. */
function unescapeText(text: string): string {
	return text.replace(/\\([&%$#_{}])/g, "$1").replace(/\\?\s+/g, " ").replace(/~/g, " ");
}

/** Row marks to their separator, and the blank edges of the whole result dropped. */
function finish(text: string, separator: string): string {
	if (!text.includes(ROW)) return text.trim();
	return text
		.split(ROW)
		.map(part => part.trim())
		.filter(part => part !== "")
		.join(separator);
}

const LETTER = /[A-Za-z]/;
const SPACE = /\s/;
const STOP_GROUP = 1;
const STOP_CELL = 2;
const BIG_DELIMITER = /^[bB]igg?[lrm]?$/;
const SPACING_ARGUMENT = /^\[\s*-?[\d.]*\s*(?:pt|em|ex|mm|cm|in|bp|pc|sp|mu|dd|cc)\s*\]/;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** A recursive-descent converter over one source string. Builds the Unicode text directly; no tree. */
class Parser {
	#s: string;
	#i = 0;
	#depth = 0;
	#tokens = 0;
	#scanned = 0;
	/** Inside a `\text{…}` argument: `^`, `_` and `'` are plain characters and `$` is dropped. */
	#text = false;

	constructor(source: string) {
		this.#s = source;
	}

	render(): string {
		return finish(this.#sequence(null, 0), "; ");
	}

	#tick(): void {
		if (++this.#tokens > MAX_TOKENS) throw new Bail();
	}

	#scan(count: number): void {
		this.#scanned += count;
		if (this.#scanned > MAX_SCAN) throw new Bail();
	}

	#peek(offset = 0): string {
		return this.#s.charAt(this.#i + offset);
	}

	#skipSpaces(): void {
		while (this.#i < this.#s.length && SPACE.test(this.#s.charAt(this.#i))) this.#i++;
	}

	#atEnd(): boolean {
		return this.#s.startsWith("\\end", this.#i) && !LETTER.test(this.#peek(4));
	}

	/** Converts until the end of the source, or until what `stop` names (left unconsumed). */
	#sequence(font: Font, stop: number): string {
		if (++this.#depth > MAX_DEPTH) throw new Bail();
		let out = "";
		while (this.#i < this.#s.length) {
			const ch = this.#peek();
			if (ch === "}") {
				if (stop & STOP_GROUP) break;
				this.#i++; // a stray close brace
				continue;
			}
			if (stop & STOP_CELL && (ch === "&" || (ch === "\\" && (this.#peek(1) === "\\" || this.#atEnd())))) break;
			if (SPACE.test(ch)) {
				this.#skipSpaces();
				if ((out !== "" || this.#text) && !out.endsWith(" ")) out += " ";
				continue;
			}
			if (ch === "\\") {
				const infix = this.#infix();
				if (infix !== undefined) {
					const right = this.#sequence(font, stop).trim();
					out = infix === "over" ? this.#fraction(out.trim(), right, "") : `C(${out.trim()}, ${right})`;
					break;
				}
			}
			out += this.#node(ch, font, out);
		}
		this.#depth--;
		return out;
	}

	/** Consumes `\over` or `\choose` (they take the whole group so far as left operand) when the source is at one. */
	#infix(): "over" | "choose" | undefined {
		for (const name of ["over", "choose"] as const) {
			if (this.#s.startsWith(`\\${name}`, this.#i) && !LETTER.test(this.#peek(name.length + 1))) {
				this.#i += name.length + 1;
				return name;
			}
		}
		return undefined;
	}

	#node(ch: string, font: Font, out: string): string {
		this.#tick();
		switch (ch) {
			case "\\":
				return this.#command(font, out);
			case "{": {
				this.#i++;
				const inner = this.#sequence(font, STOP_GROUP);
				if (this.#peek() === "}") this.#i++;
				return inner;
			}
			case "^":
			case "_":
				this.#i++;
				if (this.#text) return ch;
				return toScript(this.#argument(font), ch === "^");
			case "'": {
				let count = 0;
				while (this.#peek() === "'") {
					this.#i++;
					count++;
				}
				if (this.#text) return "'".repeat(count);
				return count < PRIMES.length ? (PRIMES[count] ?? "") : "′".repeat(count);
			}
			case "~":
				this.#i++;
				return " ";
			case "&":
				this.#i++;
				return this.#text ? "&" : " ";
			case "$":
				this.#i++;
				return this.#text ? "" : "$";
			case "%":
				return this.#percent();
			default:
				return this.#plain(font);
		}
	}

	/** A `%` that starts its line comments the line out (as TeX does); anywhere else it is a percent sign. */
	#percent(): string {
		let before = this.#i - 1;
		while (before >= 0 && (this.#s.charAt(before) === " " || this.#s.charAt(before) === "\t")) before--;
		if (before >= 0 && this.#s.charAt(before) !== "\n") {
			this.#i++;
			return "%";
		}
		const newline = this.#s.indexOf("\n", this.#i);
		this.#i = newline === -1 ? this.#s.length : newline + 1;
		return "";
	}

	/** A run of ordinary characters, in `font`. */
	#plain(font: Font): string {
		let out = "";
		while (this.#i < this.#s.length) {
			const ch = String.fromCodePoint(this.#s.codePointAt(this.#i) ?? 0);
			if (ch === "\\" || ch === "{" || ch === "}" || ch === "^" || ch === "_" || ch === "'" || ch === "~" || ch === "&" || ch === "$" || ch === "%" || SPACE.test(ch)) break;
			out += styleChar(ch, font);
			this.#i += ch.length;
		}
		return out;
	}

	/** One argument: a `{…}` group, a command, or one character. Empty at the end of the input or before a `}`. */
	#argument(font: Font): string {
		this.#skipSpaces();
		const ch = this.#peek();
		if (ch === "" || ch === "}" || ch === "^" || ch === "_") return "";
		if (++this.#depth > MAX_DEPTH) throw new Bail();
		let text: string;
		if (ch === "{") {
			this.#i++;
			text = this.#sequence(font, STOP_GROUP).trim();
			if (this.#peek() === "}") this.#i++;
		} else if (ch === "\\") {
			this.#tick();
			text = this.#command(font, "").trim();
		} else {
			const point = String.fromCodePoint(this.#s.codePointAt(this.#i) ?? 0);
			this.#i += point.length;
			text = styleChar(point, font);
		}
		this.#depth--;
		return text;
	}

	/** An argument read as prose: spaces kept, no math. A single character or command stands as it is. */
	#textArgument(font: Font, out: string): string {
		this.#skipSpaces();
		if (this.#peek() !== "{") return this.#argument(font);
		this.#i++;
		const outer = this.#text;
		this.#text = true;
		const text = this.#sequence(font, STOP_GROUP);
		this.#text = outer;
		if (this.#peek() === "}") this.#i++;
		return out.endsWith(" ") && text.startsWith(" ") ? text.slice(1) : text;
	}

	/** The source of an argument, unparsed: a balanced `{…}`, a control sequence, or one character. */
	#rawArgument(): string {
		this.#skipSpaces();
		const ch = this.#peek();
		if (ch === "") return "";
		if (ch === "\\") {
			let end = this.#i + 1;
			if (LETTER.test(this.#s.charAt(end))) while (LETTER.test(this.#s.charAt(end))) end++;
			else end += 1;
			const raw = this.#s.slice(this.#i, end);
			this.#i = end;
			return raw;
		}
		if (ch !== "{") {
			const point = String.fromCodePoint(this.#s.codePointAt(this.#i) ?? 0);
			this.#i += point.length;
			return point;
		}
		let depth = 1;
		let at = this.#i + 1;
		const start = at;
		while (at < this.#s.length) {
			const c = this.#s.charAt(at);
			if (c === "\\") at++;
			else if (c === "{") depth++;
			else if (c === "}" && --depth === 0) break;
			at++;
		}
		const end = Math.min(at, this.#s.length);
		this.#scan(end - start);
		this.#i = Math.min(end + 1, this.#s.length);
		return this.#s.slice(start, end);
	}

	/** A `[…]` argument, or `null` when none follows (nothing is consumed then). */
	#optionalRaw(): string | null {
		let at = this.#i;
		while (at < this.#s.length && SPACE.test(this.#s.charAt(at))) at++;
		if (this.#s.charAt(at) !== "[") return null;
		const start = at + 1;
		let brackets = 1;
		let braces = 0;
		for (at = start; at < this.#s.length; at++) {
			const c = this.#s.charAt(at);
			if (c === "\\") at++;
			else if (c === "{") braces++;
			else if (c === "}" && braces > 0) braces--;
			else if (braces === 0 && c === "[") brackets++;
			else if (braces === 0 && c === "]" && --brackets === 0) {
				this.#scan(at - start);
				this.#i = at + 1;
				return this.#s.slice(start, at);
			}
		}
		return null;
	}

	/** `source` converted as a nested run of this parse (an optional argument). */
	#nested(source: string, font: Font): string {
		const saved = this.#s;
		const position = this.#i;
		this.#s = source;
		this.#i = 0;
		const text = this.#sequence(font, 0).trim();
		this.#s = saved;
		this.#i = position;
		return text;
	}

	/** A space when what follows a function name would otherwise run into it (`\sin\theta`, `\sin{x}`). */
	#spaceBeforeArgument(): string {
		return /[A-Za-z0-9\\{]/.test(this.#peek()) ? " " : "";
	}

	#fraction(numerator: string, denominator: string, before: string): string {
		const vulgar = own(VULGAR, `${numerator}/${denominator}`);
		const digitBefore = /\p{N}$/u.test(before);
		if (vulgar !== undefined && !digitBefore) return vulgar;
		const text = `${wrapUnit(numerator)}/${wrapUnit(denominator)}`;
		return digitBefore && /^\p{N}/u.test(text) ? `(${text})` : text;
	}

	#command(font: Font, out: string): string {
		this.#i++; // the backslash
		if (this.#i >= this.#s.length) return "\\";
		const first = this.#peek();
		if (!LETTER.test(first)) {
			const point = String.fromCodePoint(this.#s.codePointAt(this.#i) ?? 0);
			this.#i += point.length;
			return this.#symbolCommand(point);
		}
		let end = this.#i;
		while (LETTER.test(this.#s.charAt(end))) end++;
		const name = this.#s.slice(this.#i, end);
		this.#i = end;
		return this.#namedCommand(name, font, out);
	}

	/** A control symbol: `\\`, `\{`, `\,`, `\|`. */
	#symbolCommand(ch: string): string {
		switch (ch) {
			case "\\": {
				const spacing = SPACING_ARGUMENT.exec(this.#s.slice(this.#i, this.#i + 24));
				if (spacing !== null) this.#i += spacing[0].length;
				return ROW;
			}
			case ",":
			case ":":
			case ";":
			case ">":
			case " ":
				return " ";
			case "!":
			case "/":
			case "-":
			case "(":
			case ")":
			case "[":
			case "]":
				return "";
			case "|":
				return "‖";
			default:
				return SPACE.test(ch) ? " " : ch;
		}
	}

	#namedCommand(name: string, font: Font, out: string): string {
		const mathFont = own(FONT_COMMANDS, name);
		if (mathFont !== undefined) return this.#argument(mathFont);
		const textFont = own(TEXT_COMMANDS, name);
		if (textFont !== undefined) return this.#textArgument(textFont, out);
		if (name === "operatorname") {
			if (this.#peek() === "*") this.#i++;
			return this.#textArgument(null, out) + this.#spaceBeforeArgument();
		}
		const accent = own(ACCENTS, name);
		if (accent !== undefined) return applyCombining(this.#argument(font), accent);
		switch (name) {
			case "frac":
			case "dfrac":
			case "tfrac":
			case "cfrac": {
				const numerator = this.#argument(font);
				return this.#fraction(numerator, this.#argument(font), out);
			}
			case "genfrac":
				return this.#genfrac(font, out);
			case "binom":
			case "dbinom":
			case "tbinom": {
				const n = this.#argument(font);
				return `C(${n}, ${this.#argument(font)})`;
			}
			case "sqrt":
				return this.#sqrt(font);
			case "not":
				return this.#not(font);
			case "overset":
			case "stackrel": {
				const above = this.#argument(font);
				return this.#argument(font) + toScript(above, true);
			}
			case "underset": {
				const below = this.#argument(font);
				return this.#argument(font) + toScript(below, false);
			}
			case "prescript": {
				const sup = this.#argument(font);
				const sub = this.#argument(font);
				return toScript(sup, true) + toScript(sub, false) + this.#argument(font);
			}
			case "substack":
				return this.#argument(font).split(ROW).map(part => part.trim()).filter(part => part !== "").join(", ");
			case "xcancel":
				return applyCombining(applyCombining(this.#argument(font), "\u0338"), "\u20E5");
			case "left":
			case "right":
			case "middle":
				return this.#delimiter();
			case "begin":
				return this.#environment(font);
			case "end":
				this.#rawArgument();
				return "";
			case "label":
			case "vspace":
			case "definecolor":
				this.#rawArgument();
				if (name === "definecolor") {
					this.#rawArgument();
					this.#rawArgument();
				}
				return "";
			case "bmod":
				return `${out === "" || out.endsWith(" ") ? "" : " "}mod `;
			case "hspace":
			case "mspace":
				this.#rawArgument();
				return " ";
			case "ref":
			case "eqref":
				return `(${unescapeText(this.#rawArgument())})`;
			case "url":
				return unescapeText(this.#rawArgument());
			case "href":
				this.#rawArgument();
				return this.#textArgument(font, out);
			case "textcolor":
				this.#optionalRaw();
				this.#rawArgument();
				return this.#argument(font);
			case "colorbox":
				this.#optionalRaw();
				this.#rawArgument();
				return this.#textArgument(font, out);
			case "fcolorbox":
				this.#optionalRaw();
				this.#rawArgument();
				this.#rawArgument();
				return this.#textArgument(font, out);
			case "color":
				this.#optionalRaw();
				this.#rawArgument();
				return "";
			case "phantom":
			case "hphantom":
				return " ".repeat(glyphCount(this.#argument(font)));
			case "vphantom":
				this.#argument(font);
				return "";
			default:
				return this.#tableCommand(name, font);
		}
	}

	/** Commands answered from a table: wrappers, arrows with labels, big delimiters, functions, symbols; else literal. */
	#tableCommand(name: string, font: Font): string {
		const wrapped = own(WRAPPED, name);
		if (wrapped !== undefined) {
			const body = this.#argument(font);
			return wrapped[0] + body + wrapped[1];
		}
		const arrow = own(EXTENSIBLE_ARROWS, name);
		if (arrow !== undefined) {
			const belowSource = this.#optionalRaw();
			const above = this.#argument(font);
			const below = belowSource === null ? "" : this.#nested(belowSource, font);
			return arrow + toScript(above, true) + toScript(below, false);
		}
		if (own(TRANSPARENT, name) !== undefined) return this.#argument(font);
		if (BIG_DELIMITER.test(name)) return this.#delimiter();
		const spacing = own(SPACING, name);
		if (spacing !== undefined) return spacing;
		if (own(FUNCTIONS, name) !== undefined) return name + this.#spaceBeforeArgument();
		const symbol = own(SYMBOLS, name);
		if (symbol !== undefined) return symbol;
		return `\\${name}`;
	}

	/** `\genfrac{left}{right}{thickness}{style}{numerator}{denominator}`; a zero thickness is a binomial. */
	#genfrac(font: Font, out: string): string {
		const left = unescapeText(this.#rawArgument());
		const right = unescapeText(this.#rawArgument());
		const thickness = this.#rawArgument().trim();
		this.#rawArgument();
		const numerator = this.#argument(font);
		const denominator = this.#argument(font);
		const body = /^0*\.?0*(?:pt|em|ex|mm|cm|in)?$/.test(thickness) ? `${numerator}, ${denominator}` : this.#fraction(numerator, denominator, out);
		return left + body + right;
	}

	/** `\sqrt{x}` is `√x`, `\sqrt{x+1}` is `√(x+1)`, `\sqrt[3]{x}` is `∛x`; other indices are a superscript before `√`. */
	#sqrt(font: Font): string {
		const indexSource = this.#optionalRaw();
		const index = indexSource === null ? "" : this.#nested(indexSource, font);
		const radicand = this.#argument(font);
		const radical = index === "" || index === "2" ? "√" : index === "3" ? "∛" : index === "4" ? "∜" : `${toScript(index, true)}√`;
		const unit = glyphCount(radicand) <= 1 || NUMBER.test(radicand) || bracketed(radicand) ? radicand : `(${radicand})`;
		return radical + unit;
	}

	/** `\not` before a relation: its negated glyph, or the relation struck through. */
	#not(font: Font): string {
		const target = this.#argument(font);
		return own(NOT_MAP, target) ?? applyCombining(target, "\u0338");
	}

	/** The delimiter after `\left`, `\right`, `\middle` or `\big…`: a character or a command; `.` is none. */
	#delimiter(): string {
		this.#skipSpaces();
		const ch = this.#peek();
		if (ch === "") return "";
		if (ch === ".") {
			this.#i++;
			return "";
		}
		if (ch !== "\\") {
			this.#i++;
			return ch === "<" ? "⟨" : ch === ">" ? "⟩" : ch;
		}
		this.#i++;
		const next = this.#peek();
		if (!LETTER.test(next)) {
			this.#i += 1;
			if (next === "|") return "‖";
			return next === "." || SPACE.test(next) ? "" : next;
		}
		let end = this.#i;
		while (LETTER.test(this.#s.charAt(end))) end++;
		const name = this.#s.slice(this.#i, end);
		this.#i = end;
		return own(SYMBOLS, name) ?? `\\${name}`;
	}

	/** `\begin{env} … \end{env}` flattened on one line; see {@link ENVIRONMENTS}. */
	#environment(font: Font): string {
		const raw = this.#rawArgument().trim();
		const base = raw.endsWith("*") ? raw.slice(0, -1) : raw;
		if (own(ENVIRONMENTS_WITH_SPEC, base) !== undefined) {
			this.#optionalRaw();
			this.#skipSpaces();
			if (this.#peek() === "{") this.#rawArgument();
		} else if (raw.endsWith("*")) {
			this.#optionalRaw();
		}
		const rows: string[][] = [[]];
		for (;;) {
			const cell = this.#sequence(font, STOP_CELL);
			rows[rows.length - 1]?.push(cell);
			if (this.#i >= this.#s.length) break;
			if (this.#peek() === "&") {
				this.#i++;
			} else if (this.#atEnd()) {
				this.#i += 4;
				this.#rawArgument();
				break;
			} else {
				this.#i += 2; // `\\`
				const spacing = SPACING_ARGUMENT.exec(this.#s.slice(this.#i, this.#i + 24));
				if (spacing !== null) this.#i += spacing[0].length;
				rows.push([]);
			}
		}
		const [open, close, joiner] = own(ENVIRONMENTS, base) ?? ["", "", "  "];
		const lines: string[] = [];
		for (const cells of rows) {
			const line = joiner === "" ? joinAligned(cells) : cells.map(cell => cell.trim()).join(joiner);
			if (line.trim() !== "") lines.push(line);
		}
		return open + lines.join(ROW) + close;
	}
}

/** The cells of an `align` row as one run: the spaces already around the `&` are the spacing. */
function joinAligned(cells: readonly string[]): string {
	let line = "";
	for (const cell of cells) line += line.endsWith(" ") && cell.startsWith(" ") ? cell.slice(1) : cell;
	return line.trim();
}

/**
 * The Unicode text of a bare LaTeX math fragment (no delimiters), on one line.
 *
 * Unknown commands are kept as their literal `\name`, never dropped; `\\` and the rows of an environment are
 * separated by `; `, `&` cells by two spaces. Input longer than 8000 characters, nested deeper than 24 levels, or
 * with more than a few thousand commands and groups is returned unchanged, and nothing throws.
 */
export function latexToUnicode(body: string): string {
	if (typeof body !== "string" || body === "" || body.length > MAX_INPUT) return body;
	try {
		return new Parser(body.includes(ROW) ? body.replaceAll(ROW, "") : body).render();
	} catch {
		return body;
	}
}
