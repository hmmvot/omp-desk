/**
 * Test support: the texts the magic-keyword recording asks OMP about. Deterministic (a fixed seed, no clock, no environment) so a
 * rerun of the recorder changes the recording only when OMP's answers change. The offline test replays the recorded texts; it never
 * calls this.
 *
 * Four parts: hand-written boundary and case texts, a cross product of the characters that may stand left and right of a keyword,
 * the Markdown and HTML constructs that mask a keyword (each with the keyword before, inside and after it), and seeded random
 * strings made of the tokens that open and close those constructs.
 */

const ULTRA = "ultrathink";
/** The other three trigger words, as OMP's table spells them (`workflow` is triggered by `workflowz`). */
const OTHER_WORDS = ["orchestrate", "workflowz", "jevify"] as const;

/** Texts that exercise the boundary rules, the case rules and several keywords at once. */
const HAND_WRITTEN: readonly string[] = [
  // The word alone, its case, its neighbours.
  "ultrathink", "Ultrathink", "ULTRATHINK", "ultrathinK", "uLtrathink", "ultrathink about it", "please ultrathink.", "ultra think", "ultra-think", "ultrathinks", "ultrathinking",
  "orchestrate", "Orchestrate", "orchestrates", "orchestrated", "workflowz", "Workflowz", "workflow", "workflows", "workflowzz", "jevify", "Jevify", "jevifyy", "jevifies",
  // Several keywords: together, repeated, touching.
  "ultrathink and orchestrate and workflowz and jevify", "jevify workflowz orchestrate ultrathink", "ultrathink ultrathink", "ultrathink,ultrathink", "ultrathink\nultrathink",
  "ultrathink ultrathink ultrathink", "ultrathinkultrathink", "ultrathink ultrathinkx", "ultrathink orchestrate", "ultrathinkorchestrate", "orchestrateultrathink",
  "ultrathink-orchestrate", "ultrathink.orchestrate", "ultrathink. orchestrate", "ultrathink/orchestrate", "ultrathink,orchestrate,workflowz,jevify", "workflowz jevify",
  "orchestrate\nworkflowz\njevify", "Ultrathink ultrathink", "ultrathink Ultrathink", "ultrathink ULTRATHINK ultrathink",
  // Left boundary: identifiers, paths, symbol references, digits and letters beyond ASCII.
  "src/ultrathink.ts", "ultrathink.ts", "foo::ultrathink", "ultrathink::foo", "foo:ultrathink", "ultrathink()", "ultrathink ()", "ultrathink (x)", "ultrathink(x)", "ultrathink[x]",
  "C:\\ultrathink", "ultrathink\\x", "https://x.test/ultrathink", "a_ultrathink", "ultrathink_", "123ultrathink", "ultrathink123", "-ultrathink", "--ultrathink", "ultrathink--",
  "ultrathink - x", "ultrathink -x", "x -ultrathink", "ultrathink.", "ultrathink...", "ultrathink.x", "ultrathink.-x", "ultrathink._x", "ultrathink. x", "ultrathink.\n", "ultrathink.5",
  "(ultrathink)", "\"ultrathink\"", "'ultrathink'", "\u201cultrathink\u201d", "\u2018ultrathink\u2019", "\u2026ultrathink\u2026", "ultrathink\u2026", "!ultrathink!", "?ultrathink?",
  "[ultrathink]", "{ultrathink}", "*ultrathink*", "**ultrathink**", "_ultrathink_", "#ultrathink", "@ultrathink", "$ultrathink", "%ultrathink%", "ultrathink: x", "ultrathink::",
  "ultrathink:x", "ultrathink;", "ultrathink, x", "ultrathink\u2014x", "x\u2014ultrathink",
  "\u00e9ultrathink", "ultrathink\u00e9", "\u65e5ultrathink", "ultrathink\u65e5", "\ud83d\ude00ultrathink", "ultrathink\ud83d\ude00", "\ud83d\ude00 ultrathink \ud83d\ude00", "\ud835\udc9cultrathink",
  "ultrathink\ud835\udc9c", "e\u0301ultrathink", "ultrathinke\u0301", "\u00b2ultrathink", "ultrathink\u00b2", "\u2163ultrathink", "\u0663ultrathink", "ultrathink\u200b", "\u200bultrathink",
  "\u00a0ultrathink\u00a0", "\tultrathink\t", "ultrathink\r\n", "\r\nultrathink", "ultrathink\u2028x", "x\nultrathink\nx", " ultrathink ", "\nultrathink\n",
  // Offsets: astral characters and newlines before the keyword.
  "\ud83d\ude00\ud83d\ude00 orchestrate", "a\nb\nc workflowz", "\u65e5\u672c jevify \u65e5\u672c",
  // A sentence a user would write.
  "Please ultrathink about the design, then orchestrate the work.", "ultrathink: why does `ultrathink` stay plain here?", "Use ultrathink; not ultrathink.ts or ultrathink() or a::ultrathink.",
];

/** What may stand directly left of a keyword. `""` is the start of the text. */
const LEFT_CONTEXTS: readonly string[] = [
  "", "\n", " ", "a", "Z", "5", "_", ".", "/", "\\", "-", "::", ":", "\u00e9", "\u65e5", "\ud83d\ude00", "(", "\"", "'", "`",
];

/** What may stand directly right of a keyword. `""` is the end of the text. */
const RIGHT_CONTEXTS: readonly string[] = [
  "", "\n", " ", "a", "5", "_", ".x", ".-", ". ", ".", ".\n", "/", "\\", "-", "(", "()", ":", "::", ",", "!", "?", ")", "\"", "'", "`", "\u2026", "\u00e9", "\u65e5", "\ud83d\ude00", ";",
];

/** The smaller cross product the other three words get. */
const OTHER_LEFT: readonly string[] = ["", " ", "a", "_", "::", "\u00e9"];
const OTHER_RIGHT: readonly string[] = ["", " ", "a", ".x", ". ", "/", "()", ","];

/**
 * Markdown and HTML constructs; `@` is where the keyword (or a plain `x`) goes. Each template is tried with the keyword before the
 * construct, inside it and after it.
 */
const MASKING_TEMPLATES: readonly string[] = (() => {
  const templates: string[] = [];
  // Inline code spans of every backtick count, mismatched runs and unmatched runs.
  for (let ticks = 1; ticks <= 6; ticks++) templates.push(`${"`".repeat(ticks)}@${"`".repeat(ticks)}`);
  templates.push(
    "`@``", "``@`", "```@``", "``@```", "`@", "``@", "```@", "@`", "@``", "`` ` @ ` ``", "`a` @ `b`", "`a`@`b`", "`@ `", "` @`", "`a b` @ `c d`", "`\n@\n`", "`@\n`", "`@`\n`",
    "``a`` `@`", "`a``@``b`", "`a` ` @", "` ` @ `",
  );
  // Fenced blocks: every indent, both fence characters, longer fences, closing-fence rules, info strings, unclosed fences.
  for (const indent of ["", " ", "  ", "   ", "    "]) {
    for (const fence of ["```", "~~~", "````"]) templates.push(`${indent}${fence}\n@\n${indent}${fence}`);
  }
  templates.push(
    "```js\n@\n```", "~~~js\n@\n~~~", "``` js\n@\n```", "```\n@\n```", "````\n@\n```", "````\n@\n`````", "~~~~\n@\n~~~", "~~~\n@\n~~~~", "```\n@\n~~~", "~~~\n@\n```", "```\n@\n``` text",
    "```\n@\n```  ", "```\n@\n```\t", "``` `x`\n@\n```", "~~~ `x`\n@\n~~~", "```js `x`\n@\n```", "```\n@", "~~~\n@", "``` @", "```\n@\n``", "``\n@\n``", "```\n@\n  ```", "```\n@\n   ```",
    "```\n@\n    ```", "  ```\n@\n```", "    ```\n@\n    ```", "```\n\n@\n\n```", "```\r\n@\r\n```", "x\n```\n@\n```\ny", "```\na\n```\n@\n```\nb\n```", "```@\nx\n```", "~~~ @\nx\n~~~",
    "```x\n@\n```\n```y\nz\n```", "```\n`@`\n```", "```\n<b>@</b>\n```", "<b>\n```\n@\n```\n</b>", "```\n</b>\n@", "``` ```\n@", "~~~ ~~~\n@\n~~~", "- ```\n@\n- ```",
  );
  // HTML and XML: nesting, attributes, self-closing tags, comments, unclosed and stray constructs.
  templates.push(
    "<b>@</b>", "<b>@", "<b>x</b>@", "<b><b>@</b></b>", "<b>x<b>@</b>y</b>", "<b><b>x</b>@</b>", "<b><i>@</i></b>", "<b><i>x</i>@</b>", "<b><i>@</b></i>", "<b>@</b></b>", "<b><b>@</b>",
    "<a href=\"x>\">@</a>", "<a href='x>'>@</a>", "<a title=\"a>b\" href=\"c\">@</a>", "<a href=x>@</a>", "<a href=\"x\">@", "<a b='c>@</a>", "<a b=\"c>@</a>", "<a @>x</a>", "<a b=\"@\">x</a>",
    "<br/>@", "<br />@", "<br/><br/>@", "<br @/>", "<img src=\"@\"/>", "<img src=\"x\"/>@", "<br>@</br>", "<b/>@</b>", "<b />@</b>",
    "<!--@-->", "<!--@", "<!-- @ -->", "<!-- a -->@", "@<!-- a -->", "<!-- a -->@<!-- b -->", "<!---->@", "<!--->@-->", "<!-- <b> -->@", "<!-- <b> @ </b> -->", "<!--\n@\n-->", "<!-- a --> x <!-- @",
    "<b @", "<b", "<b>@<p>", "<div>@<p>x</p>", "<div><p>@</p></div>", "<div><p>x</p>@</div>", "<p>x<p>@</p>", "</b>@", "</b @>", "</b>@</b>", "<b></b>@", "<b>@</b", "<b>@</ b>", "<b >@</b >",
    "a < @", "a <@", "1 < 2 @ > 0", "<@>", "< b>@</b>", "<3 @", "<<b>@</b>", "<b<i>@</b>", "<b\n>@</b>", "<b\n@\n</b>", "<?xml?>@", "<?x @ ?>", "<![CDATA[@]]>", "<!DOCTYPE @>", "<!x>@",
    "<A>@</A>", "<b>@</B>", "<B>@</b>", "<x-y>@</x-y>", "<x:y>@</x:y>", "<a1>@</a1>", "<1a>@</1a>", "<b>@</b>x</b>", "<b><!--</b>-->@</b>", "<b><!-- @ --></b>", "<b>`</b>@`",
    "<b>@`", "`<b>`@</b>", "`<b>@</b>`", "`<b>`@`</b>`", "<b>`@`</b>", "<code>@</code>", "<code>x</code> @", "<pre>@</pre>", "<script>@</script>", "<a href=\"x\" @/>", "<>@</>", "<b>a</b><b>@</b>",
  );
  return templates;
})();

/** The keyword before, inside and after `template`. A multi-line template is separated from the keyword by a newline. */
function maskingCases(template: string, word: string): string[] {
  const separator = template.includes("\n") ? "\n" : " ";
  return [
    `${word}${separator}${template.replace("@", "x")}`,
    template.replace("@", word),
    `${template.replace("@", "x")}${separator}${word}`,
  ];
}

/** The tokens the random strings are made of: the openers and closers of every masked construct, and the keywords among filler. */
const RANDOM_TOKENS: readonly string[] = [
  "`", "``", "```", "~~~", "<b>", "</b>", "<a href=\"x>\">", "<br/>", "<!--", "-->", "\n", "\n", " ", " ", " ", ULTRA, ULTRA, "orchestrate", "workflowz", "jevify", "x", "(", ".", "-",
];

/** mulberry32: a tiny seeded generator, so the random strings are the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANDOM_SEED = 0x0a11ce;
const RANDOM_COUNT = 180;

function randomTexts(): string[] {
  const next = mulberry32(RANDOM_SEED);
  const texts: string[] = [];
  for (let i = 0; i < RANDOM_COUNT; i++) {
    const length = 3 + Math.floor(next() * 12);
    let text = "";
    for (let token = 0; token < length; token++) text += RANDOM_TOKENS[Math.floor(next() * RANDOM_TOKENS.length)]!;
    texts.push(text);
  }
  return texts;
}

/** The whole corpus, in a fixed order, without duplicates. */
export function buildCorpus(): string[] {
  const texts: string[] = [...HAND_WRITTEN];
  for (const left of LEFT_CONTEXTS) for (const right of RIGHT_CONTEXTS) texts.push(`${left}${ULTRA}${right}`);
  for (const word of OTHER_WORDS) for (const left of OTHER_LEFT) for (const right of OTHER_RIGHT) texts.push(`${left}${word}${right}`);
  for (const template of MASKING_TEMPLATES) texts.push(...maskingCases(template, ULTRA));
  for (const word of OTHER_WORDS) for (const template of ["`@`", "```\n@\n```", "<b>@</b>", "<!--@-->", "<br @/>"]) texts.push(template.replace("@", word));
  texts.push(...randomTexts());
  return [...new Set(texts)];
}
