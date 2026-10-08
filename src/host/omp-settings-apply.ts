import type { RpcSession } from "./rpc/session";

/** Bind once; never fall back to the currently selected conversation after an asynchronous read. */
export function settingsSessionApply(session: RpcSession, stillCurrent: () => boolean): (model: { provider: string; id: string; thinking?: string }) => Promise<string> {
  return async model => {
    const ready = (): boolean => stillCurrent() && session.phase === "live" && !session.model.working && !session.model.asyncPaused;
    if (!ready()) return "Not applied: the launching Chat is no longer live and idle.";
    if (model.thinking === "auto") return "Not applied: RPC cannot express auto thinking. The saved configuration remains available to native OMP.";
    const available = await session.getAvailableModels();
    if (!ready() || available.status !== "ok" || !available.models.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return "Not applied: the effective default is not available in the launching Chat.";
    const switched = await session.setModel(model.provider, model.id);
    if (switched.status !== "accepted") return switched.status === "unconfirmed" ? "Model application is unconfirmed. Inspect the launching Chat before retrying." : "OMP refused the model change; persisted settings are unchanged.";
    if (!ready()) return "The model changed, but thinking was not applied because the launching Chat changed state.";
    if (model.thinking !== undefined) {
      const thinking = await session.setThinkingLevel(model.thinking);
      if (thinking.status !== "accepted") return "The model changed, but thinking could not be confirmed. Inspect the launching Chat before retrying.";
    }
    const state = await session.readSettingsState();
    if (!stillCurrent() || state?.model?.provider !== model.provider || state.model.id !== model.id || model.thinking !== undefined && state.thinkingLevel !== model.thinking) return "Application readback did not match. Inspect the launching Chat before retrying; the model or thinking may have changed.";
    return `Applied ${model.provider}/${model.id}${model.thinking ? ` with ${model.thinking} thinking` : ""} to the launching Chat; confirmed by OMP readback.`;
  };
}
