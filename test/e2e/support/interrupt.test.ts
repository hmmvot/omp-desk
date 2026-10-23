import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MODULE = fileURLToPath(new URL("./interrupt.ts", import.meta.url));

let scratch: string;
let marker: string;

/** Runs `body` in a fresh node process with `stopOnInterrupt` imported and a `stop` that appends a line to the marker file; returns the exit code and how often `stop` ran. */
function run(body: string): { code: number | null; stops: number } {
	const script = `import { appendFileSync } from "node:fs"; import { stopOnInterrupt } from ${JSON.stringify(`file:///${MODULE.replaceAll("\\", "/")}`)};`
		+ `const stop = () => appendFileSync(${JSON.stringify(marker)}, "stop\\n"); ${body}`;
	rmSync(marker, { force: true });
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
	let stops = 0;
	try { stops = readFileSync(marker, "utf8").split("\n").filter(Boolean).length; } catch { /* never ran */ }
	return { code: result.status, stops };
}

describe("stopOnInterrupt", () => {
	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "omp-interrupt-"));
		marker = join(scratch, "stops.txt");
	});

	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("stops once when the process exits without having released it, whatever the exit code", () => {
		assert.deepEqual(run("stopOnInterrupt(stop); process.exit(3);"), { code: 3, stops: 1 });
		assert.deepEqual(run("stopOnInterrupt(stop);"), { code: 0, stops: 1 });
	});

	it("does nothing once the returned function released it", () => {
		assert.deepEqual(run("const release = stopOnInterrupt(stop); release(); process.exit(0);"), { code: 0, stops: 0 });
	});

	it("stops, then ends the process with the signal's exit code when no other handler wants the signal", () => {
		assert.deepEqual(run("stopOnInterrupt(stop); process.emit('SIGINT');"), { code: 130, stops: 1 });
		assert.deepEqual(run("stopOnInterrupt(stop); process.emit('SIGTERM');"), { code: 143, stops: 1 });
	});

	it("stops but leaves the process to another handler of the signal (Playwright's own graceful teardown), and stops only once", () => {
		const body = "process.on('SIGINT', () => { process.stdout.write(''); }); stopOnInterrupt(stop); process.emit('SIGINT'); process.emit('SIGINT');";
		assert.deepEqual(run(body), { code: 0, stops: 1 });
	});
});
