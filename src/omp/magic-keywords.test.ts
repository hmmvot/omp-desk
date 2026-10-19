import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  containsMagicKeyword,
  findMagicKeywords,
  hasMagicKeyword,
  magicStopAt,
  magicStopHue,
  MAGIC_GRADIENT_STOPS,
  MAGIC_KEYWORDS,
  MAGIC_KEYWORD_SETTING_KEYS,
  MAGIC_SHIMMER_FRAME_MS,
  MAGIC_SHIMMER_PERIOD_MS,
  MAGIC_TUI_LIGHTNESS,
  MAGIC_TUI_SATURATION,
  maskNonProse,
} from "../shared/magic-keywords.ts";

/**
 * `src/shared/magic-keywords.ts` against a recording of the installed OMP (`fixtures/omp-magic-keywords.json`, written by
 * `magic-keywords-recorder.ts`): every text of the corpus, replayed as recorded, must get the answers OMP's own code gave.
 * `magic-keywords.live.test.ts` records the installed OMP again, so a change in OMP fails there, not here.
 */
type Rgb = [number, number, number];
interface Recording {
  version: string;
  keywords: { id: string; word: string; hue: [number, number]; requires: string[] }[];
  settings: { id: string; type: string; default: unknown }[];
  shimmer: { frameMs: number; periodMs: number };
  /** `ranges` are `[from, to]` pairs; `masked` is absent when the mask changes nothing; `contains` lists the table words OMP accepts as standalone prose. */
  corpus: { text: string; ranges: [number, number][]; masked?: string; has: boolean; contains: string[] }[];
  gradient: { stops: number; keywords: { word: string; palette: Rgb[]; paintings: { phase: number; colors: Rgb[] }[] }[] };
}
const recording = JSON.parse(readFileSync(new URL("./fixtures/omp-magic-keywords.json", import.meta.url), "utf8")) as Recording;

/** The text, JSON-quoted, so a failure names an invisible character or a newline. */
const quoted = (text: string): string => JSON.stringify(text);

describe("OMP's keyword table", () => {
  it("is the table of the shared module, in OMP's order", () => {
    assert.deepEqual(recording.keywords, MAGIC_KEYWORDS.map(({ id, word, hue, requires }) => ({ id, word, hue, requires })));
  });

  it("has one boolean setting, on by default, for the master switch and each keyword", () => {
    assert.deepEqual(recording.settings.map(setting => setting.id), [...MAGIC_KEYWORD_SETTING_KEYS]);
    for (const setting of recording.settings) {
      assert.equal(setting.type, "boolean", setting.id);
      assert.equal(setting.default, true, setting.id);
    }
  });

  it("is painted with the shimmer the shared module repeats", () => {
    assert.deepEqual(recording.shimmer, { frameMs: MAGIC_SHIMMER_FRAME_MS, periodMs: MAGIC_SHIMMER_PERIOD_MS });
  });
});

describe("the recorded corpus", () => {
  const entry = (text: string) => {
    const found = recording.corpus.find(candidate => candidate.text === text);
    assert.ok(found, `the corpus holds ${quoted(text)}`);
    return found;
  };

  it("is rich enough to mean something", () => {
    const withMatch = recording.corpus.filter(item => item.ranges.length > 0).length;
    const withoutMatch = recording.corpus.length - withMatch;
    assert.ok(recording.corpus.length >= 1000, `${recording.corpus.length} texts`);
    assert.ok(withMatch >= 400, `${withMatch} texts hold a keyword as prose`);
    assert.ok(withoutMatch >= 400, `${withoutMatch} texts hold none`);
    assert.ok(recording.corpus.filter(item => item.masked !== undefined).length >= 400, "texts the mask changes");
    assert.equal(new Set(recording.corpus.map(item => item.text)).size, recording.corpus.length, "no text twice");
    for (const keyword of MAGIC_KEYWORDS) {
      assert.ok(recording.corpus.some(item => item.contains.includes(keyword.word)), `${keyword.word} is found somewhere`);
      assert.ok(recording.corpus.some(item => item.text.includes(keyword.word) && !item.contains.includes(keyword.word)), `${keyword.word} is refused somewhere`);
    }
    assert.ok(recording.corpus.some(item => item.ranges.length >= 3), "a text with several matches");
    assert.ok(recording.corpus.some(item => item.ranges.length > 0 && item.text.includes("\n")), "a multi-line text with a match");
  });

  it("holds every masking construct, with the keyword hidden or shown as OMP says", () => {
    const hidden = [
      "`ultrathink`", "``ultrathink``", "```ultrathink```", "```\nultrathink\n```", "~~~\nultrathink\n~~~", "  ```\nultrathink\n  ```", "```\nultrathink", "~~~\nultrathink", "````\nultrathink\n```",
      "```\nx\n``` text\nultrathink", "<b>ultrathink</b>", "<b><b>ultrathink</b></b>", "<a href=\"x>\">ultrathink</a>", "<a href='x>'>ultrathink</a>", "<!--ultrathink-->", "<!--ultrathink",
      "<br ultrathink/>", "<img src=\"ultrathink\"/>", "<code>ultrathink</code>", "<ultrathink>",
      // Not fences (four spaces of indent, two backticks), but the backticks pair as an inline span across the lines.
      "    ```\nultrathink\n    ```", "``\nultrathink\n``",
    ];
    const shown = [
      "`ultrathink", "``ultrathink`", "`x` ultrathink", "ultrathink `x`", "```\nx\n```\nultrathink", "~~~\nx\n~~~\nultrathink",
      "<b>ultrathink", "<br/>ultrathink", "<b>x</b> ultrathink", "<!-- a -->ultrathink", "<b>x</b>ultrathink", "a < ultrathink",
    ];
    for (const text of hidden) assert.deepEqual(entry(text).ranges, [], `${quoted(text)} hides the keyword`);
    for (const text of shown) assert.equal(entry(text).ranges.length, 1, `${quoted(text)} shows the keyword`);
  });

  it("is answered by the shared module as OMP answered it: the ranges", () => {
    for (const item of recording.corpus) {
      assert.deepEqual(findMagicKeywords(item.text).map(match => [match.from, match.to]), item.ranges, `ranges of ${quoted(item.text)}`);
    }
  });

  it("is answered by the shared module as OMP answered it: the mask", () => {
    for (const item of recording.corpus) assert.equal(maskNonProse(item.text), item.masked ?? item.text, `mask of ${quoted(item.text)}`);
  });

  it("is answered by the shared module as OMP answered it: whether any keyword is there", () => {
    for (const item of recording.corpus) assert.equal(hasMagicKeyword(item.text), item.has, `hasMagicKeyword of ${quoted(item.text)}`);
  });

  it("is answered by the shared module as OMP answered it: whether each word is there", () => {
    for (const item of recording.corpus) {
      for (const keyword of MAGIC_KEYWORDS) {
        assert.equal(containsMagicKeyword(item.text, keyword.word), item.contains.includes(keyword.word), `containsMagicKeyword(${quoted(item.text)}, ${quoted(keyword.word)})`);
      }
    }
  });
});

/** CSS Color 4 `hsl()` to sRGB, 0 to 255 per channel, unrounded. */
function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const h = ((hue % 360) + 360) % 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [channel(0), channel(8), channel(4)];
}

describe("OMP's gradient", () => {
  it("has the stop count of the shared module and a recording per keyword, in table order", () => {
    assert.equal(recording.gradient.stops, MAGIC_GRADIENT_STOPS);
    assert.deepEqual(recording.gradient.keywords.map(keyword => keyword.word), MAGIC_KEYWORDS.map(keyword => keyword.word));
    for (const painted of recording.gradient.keywords) {
      assert.equal(painted.palette.length, MAGIC_GRADIENT_STOPS, painted.word);
      assert.ok(painted.paintings.length >= 5, `${painted.word} is painted at several phases`);
      assert.ok(painted.paintings.some(painting => painting.phase === 0), `${painted.word} is painted at phase 0`);
    }
  });

  it("paints stop s of a keyword with hsl(round(hue), 90%, 62%) at the shared module's hue", () => {
    for (const keyword of MAGIC_KEYWORDS) {
      const painted = recording.gradient.keywords.find(candidate => candidate.word === keyword.word);
      assert.ok(painted, keyword.word);
      painted.palette.forEach((color, stop) => {
        const expected = hslToRgb(magicStopHue(keyword, stop), MAGIC_TUI_SATURATION, MAGIC_TUI_LIGHTNESS);
        color.forEach((value, channel) => {
          assert.ok(Math.abs(value - expected[channel]!) <= 1, `${keyword.word} stop ${stop} channel ${channel}: OMP painted ${value}, hsl gives ${expected[channel]}`);
        });
      });
    }
  });

  it("gives each character the stop the shared module picks, at every recorded phase", () => {
    for (const painted of recording.gradient.keywords) {
      for (const painting of painted.paintings) {
        assert.equal(painting.colors.length, painted.word.length, `${painted.word} at ${painting.phase}`);
        painting.colors.forEach((color, index) => {
          const stop = magicStopAt(index, painted.word.length, painting.phase);
          assert.deepEqual(color, painted.palette[stop], `${painted.word}[${index}] at phase ${painting.phase} should be stop ${stop}`);
        });
      }
    }
  });
});
