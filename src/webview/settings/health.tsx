import type { Problem } from "./model";
import { Icon } from "./common";
import type { Send } from "./common";

/** One Sign in button: GuiLogin's flow runs in the host; the page learns the outcome from a notice and a fresh snapshot. */
export function SignIn({ provider, send, label }: { provider: string; send: Send; label?: string }) {
  return <button type="button" className="secondary" aria-label={`Sign in to ${provider}`} onClick={() => send({ action: "sign-in", provider }, "health")}><Icon name="sign-in" />{label ?? `Sign in to ${provider}`}</button>;
}
/**
 * What is in use but cannot run, on both pages. Agents that are disabled are counted apart so they do not raise the alarm;
 * providers that only they need get no button.
 */
export function HealthBanner({ problems, providers, send }: { problems: readonly Problem[]; providers: readonly { readonly id: string; readonly available: boolean }[]; send: Send }) {
  if (!problems.length) return null;
  const active = problems.filter(problem => !problem.disabled);
  const disabled = problems.length - active.length;
  const signable = new Set(providers.filter(provider => !provider.available).map(provider => provider.id));
  const logins = [...new Set(active.filter(problem => problem.status === "login" && problem.provider && signable.has(problem.provider)).map(problem => problem.provider!))];
  const names = active.map(problem => `${problem.scope} ${problem.id}`);
  return <div className="banner" role="status">
    <Icon name="warning" />
    <div className="grow">
      <strong>{active.length === 0 ? "Nothing in use is affected" : `${active.length} in use ${active.length === 1 ? "needs" : "need"} attention`}</strong>{names.length > 0 && <>: {names.join(", ")}</>}.{" "}
      <span className="muted">{logins.length > 0 ? `Not signed in: ${logins.join(", ")}. ` : ""}A subagent whose model cannot run uses the model of the session that starts it.{disabled > 0 ? ` ${disabled} more ${disabled === 1 ? "affects a disabled agent" : "affect disabled agents"}.` : ""}</span>
    </div>
    {logins.map(provider => <SignIn key={provider} provider={provider} send={send} />)}
  </div>;
}
