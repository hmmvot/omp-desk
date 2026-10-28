/**
 * The entry of `out/rare-subsystems.js`: the host code that most windows never run, built as a bundle of its own and read by the
 * first caller (ADR-0085). Provider login and logout, the Models, Agents and OMP Settings editors and the Desk Settings view are
 * reached from a command, a picker row or a restored editor, so a window that uses none of them neither reads nor evaluates them.
 *
 * Nothing imports this file except {@link ./rare-subsystems-loader.ts}: esbuild resolves that one import to the separate bundle,
 * and the extension build fails if any other path pulls these modules back into `out/extension.js`.
 */
export { SettingsRefusal } from "../host/omp-settings-core.ts";
export { SettingsEditors } from "../host/omp-settings-editor.ts";
export { OmpConfigEditors } from "../host/omp-config-editor.ts";
export { createDeskSettingsView } from "../host/desk-settings/view.ts";
export * as providerLoginFlow from "../host/provider-login-flow.ts";
export * as providerLoginRpc from "../host/provider-login-rpc.ts";
export * as providerLoginUi from "./provider-login-ui.ts";
