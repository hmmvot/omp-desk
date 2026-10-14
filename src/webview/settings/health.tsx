import type { Problem } from "./model";
import { Icon } from "./common";
import type { Send } from "./common";

/** One Sign in button: GuiLogin's flow runs in the host; the page learns the outcome from a notice and a fresh snapshot. */
export function SignIn({ provider, send, label }: { provider: string; send: Send; label?: string }) {
  return <button type="button" className="secondary" aria-label={`Sign in to ${provider}`} onClick={() => send({ action: "sign-in", provider }, "health")}><Icon name="sign-in" />{label ?? `Sign in to ${provider}`}</button>;
}
/**
 * What is in use but cannot run, on both pages. A warning appears only for something in use: an agent that is disabled affects
 * nothing, so it raises no banner (its own row says so, quietly), and providers only it needs get no button.
 */
export function HealthBanner({ problems, providers, send }: { problems: readonly Problem[]; providers: readonly { readonly id: string; readonly available: boolean }[]; send: Send }) {
  const active = problems.filter(problem => !problem.disabled);
  if (!active.length) return null;
  const signable = new Set(providers.filter(provider => !provider.available).map(provider => provider.id));
  const logins = [...new Set(active.filter(problem => problem.status === "login" && problem.provider && signable.has(problem.provider)).map(problem => problem.provider!))];
  const names = active.map(problem => `${problem.scope} ${problem.id}`);
  return <div className="banner" role="status">
    <Icon name="warning" />
    <div className="grow">
      <strong>{active.length} in use {active.length === 1 ? "needs" : "need"} attention</strong>: {names.join(", ")}.{" "}
      <span className="muted">{logins.length > 0 ? `Not signed in: ${logins.join(", ")}. ` : ""}A subagent whose model cannot run uses the model of the session that starts it.</span>
    </div>
    {logins.map(provider => <SignIn key={provider} provider={provider} send={send} />)}
  </div>;
}
