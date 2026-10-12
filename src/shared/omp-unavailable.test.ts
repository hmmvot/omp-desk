import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatDuration,
	isTransientOmpFailure,
	NO_FALLBACK_NOTICE,
	OmpUnavailableError,
	rethrowIfTransientInspection,
	transientErrnoCause,
} from "./omp-unavailable.ts";

function spawnError(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

describe("OMP failure classification", () => {
	it("calls a failure transient only when it carries a cause about the machine, not the candidate", () => {
		assert.equal(isTransientOmpFailure(new OmpUnavailableError("timed out", { transientCause: "did not finish within 15 s" })), true);
		assert.equal(isTransientOmpFailure(new OmpUnavailableError("No usable OMP launcher was found.")), false);
		assert.equal(isTransientOmpFailure(new Error("did not finish")), false);
		assert.equal(isTransientOmpFailure("did not finish"), false);
	});

	it("treats errors that say the system could not do this now as transient, naming the action", () => {
		for (const code of ["EAGAIN", "EBUSY", "EINTR", "EMFILE", "ENFILE", "ENOMEM", "ETIMEDOUT", "ETXTBSY"]) {
			assert.equal(transientErrnoCause(spawnError(code, "it failed"), "started"), `could not be started right now (${code}: it failed)`, code);
			assert.equal(transientErrnoCause(spawnError(code, "it failed"), "read"), `could not be read right now (${code}: it failed)`, code);
		}
	});

	it("treats errors that describe the file or the request as definitive", () => {
		for (const code of ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EISDIR", "constructor"]) {
			assert.equal(transientErrnoCause(spawnError(code, "it failed"), "started"), undefined, code);
		}
		assert.equal(transientErrnoCause(new Error("no code"), "read"), undefined);
		assert.equal(transientErrnoCause("EBUSY", "read"), undefined);
		assert.equal(transientErrnoCause(null, "read"), undefined);
	});

	it("lets a failed inspection mean 'not a candidate' unless it only says the machine is busy", () => {
		assert.doesNotThrow(() => rethrowIfTransientInspection("C:/b/omp.exe", spawnError("ENOENT", "no such file")));
		assert.doesNotThrow(() => rethrowIfTransientInspection("C:/b/omp.exe", spawnError("EACCES", "denied")));
		assert.throws(
			() => rethrowIfTransientInspection("C:/b/omp.exe", spawnError("EBUSY", "resource busy or locked")),
			(error: unknown) => {
				assert.ok(isTransientOmpFailure(error));
				assert.equal(error.transientCause, "could not be read right now (EBUSY: resource busy or locked)");
				assert.equal(error.message, `C:/b/omp.exe could not be read right now (EBUSY: resource busy or locked); ${NO_FALLBACK_NOTICE}`);
				return true;
			},
		);
	});

	it("words a limit as seconds when it is whole seconds", () => {
		assert.equal(formatDuration(15_000), "15 s");
		assert.equal(formatDuration(250), "250 ms");
		assert.equal(formatDuration(1500), "1500 ms");
	});
});
