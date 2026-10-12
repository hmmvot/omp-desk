import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import type { Dispatch, KeyboardEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { isRecord } from "../../shared/guards.ts";
import { inputText, matchesQuery, parseInput } from "../../protocol/desk-settings.ts";
import type { DeskSettingsAction, DeskSettingsMessage, JsonValue, SettingView, Target } from "../../protocol/desk-settings.ts";
import { initialPageState, leaveDecision, needsWrite, readyToSave, reducePage } from "./page-state.ts";
import type { PageEvent, PageState } from "./page-state.ts";
import { DESK_SETTINGS_CSS } from "./styles";

interface PersistedState { query: string; targets: Record<string, Target> }
declare function acquireVsCodeApi(): {
  postMessage(message: DeskSettingsAction): void;
  getState(): unknown;
  setState(state: PersistedState): void;
};
const vscode = acquireVsCodeApi();

type ActionRequest = DeskSettingsAction extends infer A ? A extends DeskSettingsAction ? Omit<A, "requestId"> : never : never;

const LAYER_LABEL: Record<Target, string> = { user: "User", workspace: "Workspace" };
const LONG_DESCRIPTION = 150;
const NOTE_MS = 8000;

function persisted(): PersistedState {
  const raw = vscode.getState();
  if (!isRecord(raw)) return { query: "", targets: {} };
  const targets: Record<string, Target> = {};
  if (isRecord(raw.targets)) for (const [key, value] of Object.entries(raw.targets)) if (value === "user" || value === "workspace") targets[key] = value;
  return { query: typeof raw.query === "string" ? raw.query : "", targets };
}

/** `code` and **bold** spans, paragraphs; React nodes only, so schema text can never become markup. */
function inline(text: string): ReactNode[] {
  return text.split("\n\n").map((paragraph, index) => {
    const parts: ReactNode[] = [];
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0;
    for (let match = pattern.exec(paragraph); match; match = pattern.exec(paragraph)) {
      if (match.index > last) parts.push(paragraph.slice(last, match.index));
      parts.push(match[1] === undefined ? <strong key={match.index}>{match[2]}</strong> : <code key={match.index}>{match[1]}</code>);
      last = match.index + match[0].length;
    }
    if (last < paragraph.length) parts.push(paragraph.slice(last));
    return <p key={index}>{parts}</p>;
  });
}

/** The key whose text field has the focus, so a snapshot never replaces what is being typed. */
function editingKey(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return null;
  return active.closest("[data-key]")?.getAttribute("data-key") ?? null;
}

const send = (action: ActionRequest): string => {
  const requestId = crypto.randomUUID();
  vscode.postMessage({ ...action, requestId } as DeskSettingsAction);
  return requestId;
};

function usePage(): [PageState, Dispatch<PageEvent>] {
  const [state, dispatch] = useReducer(reducePage, initialPageState);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (!isRecord(event.data) || typeof event.data.type !== "string") return;
      const message = event.data as unknown as DeskSettingsMessage;
      if (message.type === "settings:state") {
        dispatch({ type: "state", groups: message.groups, workspace: message.workspace, editing: editingKey() });
      } else if (message.type === "settings:result") {
        dispatch({ type: "result", requestId: message.requestId, key: message.key, ok: message.ok, message: message.message });
      } else if (message.type === "settings:test") {
        dispatch({ type: "test-result", requestId: message.requestId, key: message.key, ok: message.ok, message: message.message });
      }
    };
    window.addEventListener("message", receive);
    vscode.postMessage({ action: "ready", requestId: crypto.randomUUID() });
    return () => window.removeEventListener("message", receive);
  }, []);
  // A success note fades; a failure stays until the next action on its row. Each fade is tied to its own request.
  const scheduled = useRef(new Set<string>());
  useEffect(() => {
    for (const [key, note] of Object.entries(state.notes)) {
      if (!note.ok || scheduled.current.has(`${key}:${note.requestId}`)) continue;
      scheduled.current.add(`${key}:${note.requestId}`);
      window.setTimeout(() => dispatch({ type: "expire", key, requestId: note.requestId }), NOTE_MS);
    }
  }, [state.notes]);
  return [state, dispatch];
}

function Description({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_DESCRIPTION;
  if (text === "") return null;
  return (
    <>
      <div id={id} className={long && !open ? "desc clamp" : "desc"}>{inline(text)}</div>
      {long ? <button type="button" className="link" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{open ? "Show less" : "Show more"}</button> : null}
    </>
  );
}

function resetHint(view: SettingView): string {
  const layers = view.resetLayers.map(layer => LAYER_LABEL[layer]).join(" and ");
  const user = view.resetLayers.includes("user") ? " The User value applies in every window." : "";
  return `Clears the ${layers} value${view.resetLayers.length > 1 ? "s" : ""} so the default applies.${user}`;
}

function Row({ view, page, dispatch, target, chooseTarget }: {
  view: SettingView;
  page: PageState;
  dispatch: Dispatch<PageEvent>;
  target: Target;
  chooseTarget(target: Target): void;
}) {
  const controlId = useId();
  const testButton = useRef<HTMLButtonElement>(null);
  const descId = `${controlId}-desc`;
  const optionId = `${controlId}-option`;
  const messageId = `${controlId}-message`;
  const invalidId = `${controlId}-invalid`;
  const note = page.notes[view.key];
  const draft = page.drafts[view.key];
  const pending = page.pending[view.key];
  const control = view.control;
  const shown = pending !== undefined ? pending.value : view.value;

  const write = (value: JsonValue): void => {
    const requestId = send({ action: "set", key: view.key, value, ...(view.targets.length > 1 ? { target } : {}) });
    dispatch({ type: "write", key: view.key, requestId, value });
  };

  const text = draft?.text ?? inputText(view.value);
  const parsed = draft === undefined ? null : parseInput(control, draft.text);
  const invalid = parsed !== null && !parsed.ok ? parsed.message : null;
  const save = (): void => {
    if (parsed === null || !parsed.ok) return;
    if (needsWrite(view, parsed.value, target)) write(parsed.value);
    else dispatch({ type: "draft", key: view.key, draft: undefined });
  };
  const leave = (toTest: boolean): void => {
    const decision = leaveDecision(draft, inputText(view.value), page.own[view.key]?.some(entry => !entry.acked) === true, toTest);
    if (decision === "defer") dispatch({ type: "defer", key: view.key });
    else if (decision === "adopt") dispatch({ type: "adopt", key: view.key });
    else if (decision === "save") save();
  };
  const textKeys = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && draft !== undefined) { event.stopPropagation(); dispatch({ type: "draft", key: view.key, draft: undefined }); }
    else if (event.key === "Enter" && (control.kind !== "string" || !control.multiline || event.ctrlKey)) { event.preventDefault(); save(); }
  };
  const selectedOption = control.kind === "enum" ? control.options.find(option => option.value === shown) : undefined;
  const describedBy = [
    view.description === "" ? "" : descId,
    selectedOption?.description === undefined ? "" : optionId,
    invalid === null ? "" : invalidId,
    note === undefined ? "" : messageId,
  ].filter(Boolean).join(" ") || undefined;
  const testState = page.tests[view.key];
  const testId = `${controlId}-test`;
  const runTest = (): void => {
    const tested = draft?.text ?? inputText(view.value);
    dispatch({ type: "test", key: view.key, requestId: send({ action: "test", key: view.key, value: tested }), tested });
  };

  const resetTitle = `${resetHint(view)}${view.defaultValue === undefined ? "" : ` Default: ${typeof view.defaultValue === "object" ? JSON.stringify(view.defaultValue) : String(view.defaultValue)}.`}`;
  const actions = (
    <span className="actions">
      <span className={view.source === "default" ? "badge" : "badge set"}>{view.source === "default" ? "Default" : `Set in ${LAYER_LABEL[view.source]}`}</span>
      {view.modified ? (
        <button type="button" aria-label={`Reset ${view.label} to its default. ${resetHint(view)}`} title={resetTitle}
          onClick={() => dispatch({ type: "forget", key: view.key, requestId: send({ action: "reset", key: view.key }) })}>
          <span className="codicon codicon-discard" aria-hidden="true" />
        </button>
      ) : null}
      <button type="button" aria-label={`Open ${view.label} in the Settings editor`} title="Open in the Settings editor"
        onClick={() => dispatch({ type: "request", key: view.key, requestId: send({ action: "open-editor", key: view.key }) })}>
        <span className="codicon codicon-gear" aria-hidden="true" />
      </button>
    </span>
  );

  let title: ReactNode = <label className="title" htmlFor={controlId}>{view.label}</label>;
  let body: ReactNode = null;
  if (control.kind === "boolean") {
    title = (
      <label className="title check">
        <input id={controlId} type="checkbox" checked={shown === true} aria-describedby={describedBy}
          onChange={event => write(event.currentTarget.checked)} />
        <span>{view.label}</span>
      </label>
    );
  } else if (control.kind === "enum") {
    const index = control.options.findIndex(option => option.value === shown);
    body = (
      <div className="control">
        <select id={controlId} value={index < 0 ? "" : String(index)} aria-describedby={describedBy}
          onChange={event => { const option = control.options[Number(event.currentTarget.value)]; if (option) write(option.value); }}>
          {index < 0 ? <option value="" disabled>{shown === undefined ? "(not set)" : `${String(shown)} (not a listed value)`}</option> : null}
          {control.options.map((option, optionIndex) => <option key={optionIndex} value={String(optionIndex)}>{option.label}</option>)}
        </select>
        {selectedOption?.description === undefined ? null : <div id={optionId} className="option-desc">{inline(selectedOption.description)}</div>}
      </div>
    );
  } else if (control.kind === "number" || control.kind === "string") {
    const multiline = control.kind === "string" && control.multiline;
    const common = {
      id: controlId, value: text, "aria-invalid": invalid !== null, "aria-describedby": describedBy,
      onChange: (event: { currentTarget: { value: string } }) => dispatch({ type: "draft", key: view.key, draft: { text: event.currentTarget.value, base: draft?.base ?? inputText(view.value) } }),
      onKeyDown: textKeys,
      // Moving to this row's Test button is not leaving the field: Test saves nothing, so the draft it tests stays unsaved.
      onBlur: (event: { relatedTarget: EventTarget | null }) => leave(event.relatedTarget !== null && event.relatedTarget === testButton.current),
    };
    body = (
      <div className="control">
        {multiline ? <textarea {...common} /> : <input type="text" inputMode={control.kind === "number" ? "decimal" : undefined} spellCheck={false} {...common} />}
        {invalid === null ? null : <div id={invalidId} className="invalid" role="alert">{invalid}</div>}
        {draft !== undefined && invalid === null ? <div className="note">{multiline ? "Ctrl+Enter or leaving the field saves; Esc cancels." : "Enter or leaving the field saves; Esc cancels."}</div> : null}
      </div>
    );
  } else {
    const preview = shown === undefined ? "(not set)" : JSON.stringify(shown, null, 2);
    body = (
      <div className="control">
        <pre className="preview" id={controlId} tabIndex={0} aria-label={`Current value of ${view.label}`}>{preview.length > 600 ? `${preview.slice(0, 600)}…` : preview}</pre>
        <button type="button" className="link" onClick={() => dispatch({ type: "request", key: view.key, requestId: send({ action: "open-json", key: view.key }) })}>Edit in {LAYER_LABEL[view.defaultTarget]} settings.json</button>
      </div>
    );
  }

  return (
    <article className="setting" data-key={view.key} aria-label={view.label}>
      <div className="head">{title}{actions}</div>
      <code className="key">{view.key}</code>
      {view.deprecation === undefined ? null : <div className="note deprecated">Deprecated: {view.deprecation}</div>}
      <Description id={descId} text={view.description} />
      {body}
      {view.test === true ? (
        <div className="test">
          <button type="button" ref={testButton} disabled={testState?.status === "running"} aria-describedby={testId}
            title="Try this value the way a launch would, without saving it. Empty tries the OMP found on PATH."
            onClick={runTest}>
            Test
          </button>
          <div id={testId} className={testState?.status === "done" && !testState.ok ? "message error" : "message"} role="status" aria-live="polite">
            {testState === undefined ? null : testState.status === "running"
              ? `Testing ${testState.tested === "" ? "the OMP on PATH" : testState.tested}…`
              : `${testState.ok ? "Works" : "Refused"} — tested ${testState.tested === "" ? "the PATH search" : testState.tested}: ${testState.message}`}
          </div>
        </div>
      ) : null}
      {view.targets.length > 1 && control.kind !== "json" ? (
        <fieldset className="targets">
          <legend className="sr">Save {view.label} to</legend>
          <span aria-hidden="true">Save to</span>
          {view.targets.map(layer => (
            <label key={layer}>
              <input type="radio" name={`${view.key}-layer`} checked={target === layer} onChange={() => chooseTarget(layer)} />
              {LAYER_LABEL[layer]}
            </label>
          ))}
        </fieldset>
      ) : null}
      {view.scopeNote === undefined ? null : <div className="note">{view.scopeNote}</div>}
      {view.folders.length === 0 ? null : <div className="note warn">Also set in folder settings of {view.folders.join(", ")}. OMP Desk reads this setting without a folder, so those values do not apply.</div>}
      <div id={messageId} className={note !== undefined && !note.ok ? "message error" : "message"} aria-live="polite">
        {note === undefined || note.message === "" ? null : note.message}
      </div>
    </article>
  );
}

function App() {
  const [page, dispatch] = usePage();
  const [query, setQuery] = useState(() => persisted().query);
  const [targets, setTargets] = useState<Record<string, Target>>(() => persisted().targets);
  useEffect(() => { vscode.setState({ query, targets }); }, [query, targets]);
  const total = useMemo(() => page.groups?.reduce((sum, group) => sum + group.settings.length, 0) ?? 0, [page.groups]);
  const visible = useMemo(
    () => (page.groups ?? [])
      .map(group => ({ group, settings: group.settings.filter(view => matchesQuery(view, group.title, query)) }))
      .filter(entry => entry.settings.length > 0),
    [page.groups, query],
  );
  // A draft left while a save was unanswered is saved once that save is answered and nothing changed from outside.
  useEffect(() => {
    for (const key of readyToSave(page)) {
      const view = page.groups?.flatMap(group => group.settings).find(candidate => candidate.key === key);
      const draft = page.drafts[key];
      if (view === undefined || draft === undefined) continue;
      const parsed = parseInput(view.control, draft.text);
      const target = targets[key] !== undefined && view.targets.includes(targets[key]!) ? targets[key]! : view.defaultTarget;
      if (!parsed.ok) continue;
      if (!needsWrite(view, parsed.value, target)) { dispatch({ type: "draft", key, draft: undefined }); continue; }
      const requestId = send({ action: "set", key, value: parsed.value, ...(view.targets.length > 1 ? { target } : {}) });
      dispatch({ type: "write", key, requestId, value: parsed.value });
    }
  }, [page, targets, dispatch]);
  const matching = visible.reduce((sum, entry) => sum + entry.settings.length, 0);
  return (
    <>
      <div className="bar" role="search">
        <div className="search">
          <label className="sr" htmlFor="filter">Search settings</label>
          <input id="filter" type="search" placeholder="Search settings" value={query} autoComplete="off" spellCheck={false}
            onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === "Escape" && query !== "") { event.stopPropagation(); setQuery(""); } }} />
          {query === "" ? null : (
            <button type="button" className="clear" aria-label="Clear the search" onClick={() => { setQuery(""); document.getElementById("filter")?.focus(); }}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="count" role="status">
          {page.groups === undefined ? "Reading settings…" : query.trim() === "" ? `${total} settings` : `${matching} of ${total} settings match`}
        </div>
      </div>
      <main>
        {page.groups === undefined ? null : visible.length === 0 ? <div className="empty">No settings match “{query}”.</div> : visible.map(({ group, settings }) => (
          <section key={group.id} aria-label={group.title}>
            <h2>{group.title}</h2>
            {settings.map(view => (
              <Row key={view.key} view={view} page={page} dispatch={dispatch}
                target={targets[view.key] !== undefined && view.targets.includes(targets[view.key]!) ? targets[view.key]! : view.defaultTarget}
                chooseTarget={layer => setTargets(previous => ({ ...previous, [view.key]: layer }))} />
            ))}
          </section>
        ))}
      </main>
    </>
  );
}

const style = document.createElement("style");
style.nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
style.textContent = DESK_SETTINGS_CSS;
document.head.appendChild(style);
const root = document.getElementById("root");
if (!root) throw new Error("The settings page container is missing.");
createRoot(root).render(<App />);
