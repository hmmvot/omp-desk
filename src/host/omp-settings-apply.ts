import type { RpcSession } from "./rpc/session";

/** The sentence of an application that was refused before anything was sent. */
export const SETTINGS_APPLY_NOT_LIVE = "Not applied: the launching Chat is no longer live and idle.";

/**
 * Whether `thinking` is a level the model cannot take: a named effort outside the model's supported efforts (a model that does not
 * reason supports none). `off` and `auto` are never a mismatch, and an unknown support list is not one either.
 */
export function thinkingUnsupported(thinking: string | undefined, efforts: readonly string[] | undefined): boolean {
  return thinking !== undefined && thinking !== "off" && thinking !== "auto" && efforts !== undefined && !efforts.includes(thinking);
}

/** Bind once; never fall back to the currently selected conversation after an asynchronous read. */
export function settingsSessionApply(session: RpcSession, stillCurrent: () => boolean): (model: { provider: string; id: string; thinking?: string; efforts?: readonly string[] }) => Promise<string> {
  return async model => {
    const ready = (): boolean => stillCurrent() && session.phase === "live" && !session.model.working && !session.model.asyncPaused;
    if (!ready()) return SETTINGS_APPLY_NOT_LIVE;
    // RPC cannot express auto thinking: the model is switched and the session keeps its level. Neither can a level the model does not support: OMP would clamp it, and the readback would differ from what was asked.
    const unsupported = thinkingUnsupported(model.thinking, model.efforts);
    const thinking = model.thinking === "auto" || unsupported ? undefined : model.thinking;
    const available = await session.getAvailableModels();
    if (!ready() || available.status !== "ok" || !available.models.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return "Not applied: the effective default is not available in the launching Chat.";
    const switched = await session.setModel(model.provider, model.id);
    if (switched.status !== "accepted") return switched.status === "unconfirmed" ? "Model application is unconfirmed. Inspect the launching Chat before retrying." : "OMP refused the model change; persisted settings are unchanged.";
    if (!ready()) return "The model changed, but thinking was not applied because the launching Chat changed state.";
    if (thinking !== undefined) {
      const changed = await session.setThinkingLevel(thinking);
      if (changed.status !== "accepted") return "The model changed, but thinking could not be confirmed. Inspect the launching Chat before retrying.";
    }
    const state = await session.readSettingsState();
    if (!stillCurrent() || state?.model?.provider !== model.provider || state.model.id !== model.id || thinking !== undefined && state.thinkingLevel !== thinking) return "Application readback did not match. Inspect the launching Chat before retrying; the model or thinking may have changed.";
    const kept = model.thinking === "auto" ? " Auto thinking is not applied; the session keeps its current level." : unsupported ? ` ${model.provider}/${model.id} does not support ${model.thinking} thinking, so that level was not applied; the session keeps its current level.` : "";
    return `Applied ${model.provider}/${model.id}${thinking ? ` with ${thinking} thinking` : ""} to the launching Chat; confirmed by OMP readback.${kept}`;
  };
}
