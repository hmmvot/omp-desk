// Release notes for a tag: `node scripts/release-notes.mjs <tag> <output-file>`.
//
// Fails unless the tag is `v` + the `version` in package.json, then writes that
// version's `## [x.y.z]` section of CHANGELOG.md (without its heading) to the output
// file. The section ends at the next `## ` heading or at the link reference
// definitions that close the file.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const [tag, output] = process.argv.slice(2);
if (!tag || !output) {
  console.error("Usage: node scripts/release-notes.mjs <tag> <output-file>");
  process.exit(2);
}

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (tag !== `v${version}`) {
  console.error(`The tag ${tag} does not match package.json version ${version}: expected v${version}.`);
  process.exit(1);
}

const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const heading = `## [${version}]`;
const start = lines.findIndex(line => line === heading || line.startsWith(`${heading} `));
if (start < 0) {
  console.error(`CHANGELOG.md has no "${heading}" section.`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex(line => line.startsWith("## ") || /^\[[^\]]+\]:\s/.test(line));
const notes = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
if (notes === "") {
  console.error(`The "${heading}" section of CHANGELOG.md is empty.`);
  process.exit(1);
}
writeFileSync(output, `${notes}\n`);
console.log(`Release notes for ${tag}: ${notes.split("\n").length} lines from CHANGELOG.md.`);
