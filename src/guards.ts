/**
 * OMP Desk — the one runtime guard for values that arrived as `unknown`.
 *
 * Every boundary in this package (an ACP frame, a Webview message, a host
 * control reply) starts from "an object of unknown fields". Keeping the guard
 * here means each boundary narrows identically instead of declaring a private
 * copy that can drift.
 *
 * This is deliberately not a schema validator: it proves an object, not its
 * fields. A boundary that needs field-level evidence checks the fields it uses
 * (`typeof`, `Array.isArray`, `in`) or reads them through the named parser that
 * owns that shape.
 */

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
