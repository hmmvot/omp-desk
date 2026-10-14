import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import type { ResolvedModel, ResolvedThinking, RoleResolution, SettingsAgent, SettingsRole, SettingsSnapshot } from "../../protocol/settings-model";
import type { SurfaceProps } from "./common";

/** The Models roles page, the Agents page and the health banner rendered to static markup from an esbuild bundle (the page's own bundler). */
interface Bundle {
  models(props: SurfaceProps): string; agents(props: SurfaceProps): string; health(props: unknown): string;
  signIn(props: unknown): { props: { onClick(): void } };
}
let render: Bundle;
before(async () => {
  const bundled = await build({ stdin: { contents: `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ModelsRoles } from "./roles";
    import { Agents } from "./agents";
    import { HealthBanner, SignIn } from "./health";
    export const models = props => renderToStaticMarkup(createElement(ModelsRoles, props));
    export const agents = props => renderToStaticMarkup(createElement(Agents, props));
    export const health = props => renderToStaticMarkup(createElement(HealthBanner, props));
    export const signIn = props => SignIn(props);
  `, loader: "tsx", resolveDir: join(process.cwd(), "src/webview/settings") }, bundle: true, write: false,
    format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  render = module.exports as Bundle;
});

const ok = (model: string): ResolvedModel => ({ model, status: "ok" });
const login: ResolvedModel = { status: "login", provider: "z", wanted: "z/gone" };
const thinking = (level?: string, source: ResolvedThinking["source"] = "selector"): ResolvedThinking => level ? { level, source } : { source: "none" };
const roleResolution = (patch: Partial<RoleResolution>): RoleResolution => ({ source: "global", follows: [], model: ok("a/sonnet"), thinking: thinking("high"), trace: [], followers: [], agents: { following: [], overridden: [] }, ...patch });
const role = (id: string, resolution: RoleResolution): SettingsRole => ({ id, name: id, section: "chat", accepts: [], defaults: [], resolution });
const agent = (name: string, patch: Partial<SettingsAgent> & Pick<SettingsAgent, "resolution">): SettingsAgent =>
  ({ name, description: `${name} agent`, systemPrompt: "", source: "bundled", hasFile: false, disabled: false, effectiveModel: [], ...patch });
const reviewer = agent("reviewer", { resolution: {
  source: "override", layer: "project", model: ok("a/opus"), thinking: thinking("high"), roles: [], shadowedRoles: ["slow"], overrides: { project: "a/opus:high" },
  trace: [{ kind: "override", layer: "project", title: "Project override", value: "a/opus:high", state: "used" }, { kind: "definition", title: "Definition", value: "@slow", state: "shadowed" }],
  ifReset: { project: { source: "definition", model: ok("a/sonnet"), thinking: thinking("high", "role") } } } });
const scout = agent("scout", { disabled: false, resolution: {
  source: "definition", model: login, thinking: thinking(), roles: ["smol"], shadowedRoles: [], overrides: {}, ifReset: {},
  trace: [{ kind: "definition", title: "Definition", value: "@smol", state: "used" }] } });
const retired = agent("retired", { disabled: true, resolution: { ...scout.resolution } });

const snapshot = (roles: SettingsRole[], agents: SettingsAgent[]): SettingsSnapshot => ({
  profile: "default", cwd: "p", globalFile: "g.yml", projectFile: "p.yml", agentDirectories: { global: "ga", project: "pa" },
  global: {}, project: { task: { agentModelOverrides: { reviewer: "a/opus:high" } } }, effective: { cycleOrder: ["smol"] }, provenance: {}, models: [],
  roles, agents, providers: [{ id: "a", status: "available", available: true }, { id: "z", status: "locked", available: false }], presetNames: [],
});
const props = (value: SettingsSnapshot, folder: string | null = null): SurfaceProps => ({ snapshot: value, send: () => undefined, pick: async () => null, revision: 1, folder });

test("each role row carries its model, thinking level with a text label, and a source pill; a role that cannot run shows needs login", () => {
  const html = render.models(props(snapshot([
    role("default", roleResolution({ source: "global", trace: [{ kind: "global", layer: "global", title: "Global config", value: "a/sonnet:high", state: "used" }] })),
    role("smol", roleResolution({ source: "inherited", follows: ["default"] })),
    role("slow", roleResolution({ source: "project", model: login, thinking: thinking() })),
  ], [])));
  assert.match(html, /<span class="mname">sonnet<\/span>/);
  assert.match(html, /role="img" aria-label="Thinking high"/);
  assert.match(html, /<span class="src s-global" title="[^"]*">global<\/span>/);
  assert.match(html, /<span class="src s-inherited" title="Not set here: follows @default">inherited<\/span>/);
  assert.match(html, /<span class="src s-project"[^>]*>project<\/span>/);
  assert.match(html, /mchip bad" title="z\/gone: z is not signed in">[\s\S]*?<span class="small">needs login<\/span>/);
  assert.match(html, /aria-label="No thinking level"/);
  assert.match(html, /3 of 3 assigned|2 of 3 assigned/);
});

test("the detail pane shows the trace with the winner and the shadowed layers named in words", () => {
  const html = render.models(props(snapshot([role("default", roleResolution({ trace: [
    { kind: "project", layer: "project", title: "Project config", value: "a/opus", state: "shadowed" },
    { kind: "global", layer: "global", title: "Global config", value: "a/sonnet:high", state: "used" },
  ] }))], [])));
  assert.match(html, /Effective now/);
  assert.match(html, /<ol class="trace" aria-label="How default was decided">/);
  assert.match(html, /Project config<span class="sr-only"> — overridden<\/span>/);
  assert.match(html, /Global config<span class="sr-only"> — used<\/span>/);
});

test("an unassigned role says what OMP does instead, not that it is automatic", () => {
  const html = render.models(props(snapshot([role("default", roleResolution({ source: "none", model: { status: "none" }, thinking: thinking() }))], [])));
  assert.match(html, /Not assigned: a session uses its restored or first available model/);
  assert.match(html, /What OMP does without it/);
  assert.match(html, /unassigned/);
  assert.doesNotMatch(html, /Automatic/);
});

test("the Agents page lists model, thinking and origin per agent, the roles strip and the filters with counts", () => {
  const html = render.agents(props(snapshot([role("default", roleResolution({})), role("smol", roleResolution({})), role("slow", roleResolution({})), role("task", roleResolution({ source: "none", model: { status: "none" }, thinking: thinking() }))], [reviewer, scout, retired])));
  assert.match(html, /aria-label="Roles agents follow"/);
  assert.match(html, /<strong class="small">@task<\/strong>/);
  assert.match(html, /<span class="src s-override"[^>]*>override<\/span>/);
  assert.match(html, /<span class="src s-inherited" title="Its definition names @smol">@smol<\/span>/);
  assert.match(html, /Overridden <span class="pill">1<\/span>/);
  assert.match(html, /Follow a role <span class="pill">2<\/span>/);
  assert.match(html, /Problems <span class="pill">2<\/span>/);
  assert.match(html, /Disabled <span class="pill">1<\/span>/);
});

test("the agent detail explains the override, previews a reset and offers Save to only when a folder is bound", () => {
  const roles = [role("default", roleResolution({})), role("smol", roleResolution({})), role("slow", roleResolution({})), role("task", roleResolution({}))];
  const bound = render.agents(props(snapshot(roles, [reviewer]), "d:/work/project"));
  assert.match(bound, /If you reset the project override/);
  assert.match(bound, /aria-label="Agent override write scope"/);
  assert.match(bound, /<option value="project" selected="">/, "the layer that holds the override is the default");
  assert.match(bound, /<input type="checkbox" aria-label="reviewer enabled" disabled="" checked=""\/>/, "enabling is global-only");
  assert.match(bound, /aria-label="Clear project model override"/);
  const unbound = render.agents(props(snapshot(roles, [reviewer])));
  assert.doesNotMatch(unbound, /Agent override write scope/);
  assert.match(unbound, /Saved to the global config\./);
});

test("an agent whose model needs login explains the fallback and offers Sign in, while a disabled agent does not raise the alarm", () => {
  const roles = [role("default", roleResolution({})), role("smol", roleResolution({})), role("slow", roleResolution({})), role("task", roleResolution({}))];
  const html = render.agents(props(snapshot(roles, [scout])));
  assert.match(html, /<strong>z\/gone<\/strong> needs login\. Until that changes, this agent runs on the model of the session that spawns it\./);
  assert.match(html, /aria-label="Sign in to z"/);
  const banner = render.health({ problems: [{ scope: "agent", id: "retired", status: "login", provider: "z", wanted: "z/gone", disabled: true }], providers: [{ id: "z", available: false }], send() {} });
  assert.equal(banner, "", "a disabled agent affects nothing in use, so there is no warning banner");
  const quiet = render.agents(props(snapshot(roles, [retired])));
  assert.match(quiet, /Disabled, so it is not in use\. Its model z\/gone would need login\./);
  assert.doesNotMatch(quiet, /class="banner/);
});

test("the health banner names what is affected and signs in once per provider that is not signed in", () => {
  const html = render.health({ providers: [{ id: "z", available: false }, { id: "a", available: true }], send() {}, problems: [
    { scope: "role", id: "slow", status: "login", provider: "z", wanted: "z/gone", disabled: false },
    { scope: "agent", id: "scout", status: "login", provider: "z", wanted: "z/gone", disabled: false },
    { scope: "agent", id: "gone", status: "unavailable", provider: "a", wanted: "a/old", disabled: false },
  ] });
  assert.match(html, /3 in use need attention/);
  assert.match(html, /role slow, agent scout, agent gone/);
  assert.equal(html.match(/aria-label="Sign in to z"/g)?.length, 1);
  assert.doesNotMatch(html, /Sign in to a/, "a provider that is signed in has nothing to sign in to");
});

test("Sign in sends the sign-in action for its provider from the health origin", () => {
  const sent: unknown[] = [];
  render.signIn({ provider: "z", send: (...args: unknown[]) => { sent.push(args); return "id"; } }).props.onClick();
  assert.deepEqual(sent, [[{ action: "sign-in", provider: "z" }, "health"]]);
});

const withSession = (session: unknown, canApply = true): string => render.models({ ...props(snapshot([role("default", roleResolution({}))], [])), init: { type: "settings:init", key: "k", kind: "models", folder: null, canApply, sessionLabel: "omp-desk-0.4.0" }, session } as unknown as SurfaceProps);
const live = { label: "omp-desk-0.4.0", busy: false, current: { model: "a/old", thinking: "low" }, target: { model: "a/sonnet", thinking: "high" } };

test("Current session names the session as a session, the model and level it will set, and a button that says what it does", () => {
  const html = withSession(live);
  assert.match(html, /Switch the Chat session \u201Comp-desk-0\.4\.0\u201D to a\/sonnet \u00B7 high/);
  assert.match(html, /Saved settings apply to new sessions\. This changes the model of the Chat session \u201Comp-desk-0\.4\.0\u201D now\./);
  assert.match(html, />Use sonnet in this session<\/button>/);
  assert.doesNotMatch(html, /RPC|Apply default/);
});

test("Current session is hidden when the session already uses the default, and says what cannot be applied", () => {
  assert.doesNotMatch(withSession({ ...live, current: { model: "a/sonnet", thinking: "high" } }), /Current session/);
  assert.match(withSession({ ...live, current: { model: "a/sonnet" } }), /Current session/, "same model, different level: still offered");
  const auto = withSession({ ...live, target: { model: "a/sonnet", thinking: "auto" } });
  assert.match(auto, /Auto thinking is not applied; the session keeps its current level\./);
  assert.match(auto, /to a\/sonnet<\/strong>/, "no level is named when none will be set");
  assert.doesNotMatch(withSession({ ...live, current: { model: "a/sonnet", thinking: "low" }, target: { model: "a/sonnet", thinking: "auto" } }), /Current session/, "auto changes nothing, so a session on the model needs no switch");
  const refused = withSession({ label: "x", busy: false, unavailable: "Not applied: the effective default has upstream routing that RPC cannot express." });
  assert.match(refused, /upstream routing/);
  assert.doesNotMatch(refused, /in this session<\/button>/);
});

test("Current session disables the button with the reason while the session is busy", () => {
  const html = withSession({ ...live, busy: true });
  assert.match(html, /<button type="button" disabled="" title="The session is busy\. Try again when it is idle\.">Use sonnet in this session<\/button>/);
});
