/**
 * The one way to reach {@link ./rare-subsystems.ts}. The extension build rewrites the import below to a `require` of the
 * separate file `out/rare-subsystems.js` (the `rareSubsystemsExternal` plugin in `esbuild.mjs`); a test or a type check reads the
 * TypeScript module directly.
 */
import { lazy } from "../host/lazy-module.ts";

/** The rarely used host code, loaded by the first call and shared afterwards. */
export const rareSubsystems = lazy(() => import("./rare-subsystems.ts"));

/** What {@link rareSubsystems} resolves to. */
export type RareSubsystems = Awaited<ReturnType<typeof rareSubsystems>>;
