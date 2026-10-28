/**
 * What the Models, Agents, OMP Settings and Desk Settings code takes from the extension bundle instead of carrying a copy of.
 *
 * That code is built as `out/rare-subsystems.js` (ADR-0085), a bundle of its own, so a module it imported would exist twice:
 * once there and once in `out/extension.js`. For these it must not. Where OMP is found and which Bun runs it depend on the
 * path reader and the resolution log the extension sets at activation, and a failure is told by `instanceof`, which a second copy
 * of the class would answer `false` to. The extension hands the one instance of each over here, and the rarely used code reads only
 * the types of the modules behind them (type imports are erased, so none is bundled).
 */
import { OmpUnavailableError } from "../shared/omp-unavailable";
import { resolveBunRuntime, resolveOmpBinary, resolveOmpPackageRoot } from "./native-terminal";
import { stageRuntimeAssets, verifyStagedRuntimeAsset } from "./runtime-assets";

export interface OmpRuntimeServices {
	readonly resolveOmpBinary: typeof resolveOmpBinary;
	readonly resolveBunRuntime: typeof resolveBunRuntime;
	readonly resolveOmpPackageRoot: typeof resolveOmpPackageRoot;
	readonly stageRuntimeAssets: typeof stageRuntimeAssets;
	readonly verifyStagedRuntimeAsset: typeof verifyStagedRuntimeAsset;
	/** Whether `error` is the error {@link resolveOmpBinary} throws when no usable OMP is installed. */
	isOmpUnavailable(error: unknown): error is Error;
}

export const ompRuntimeServices: OmpRuntimeServices = {
	resolveOmpBinary,
	resolveBunRuntime,
	resolveOmpPackageRoot,
	stageRuntimeAssets,
	verifyStagedRuntimeAsset,
	isOmpUnavailable: (error): error is Error => error instanceof OmpUnavailableError,
};
