import { fileLayerFor, highlightParts, isModified, rowNotes, shownValue } from "../model";
import type { View } from "../model";
import { BooleanControl, EnumControl, MultiSelectControl, NumberControl, NumericControl, TextControl } from "./Controls";
import { Icon } from "./Icon";
import type { ConfigEntry, ConfigLayer, ConfigValue } from "../../../protocol/omp-config-model";

/** One setting, laid out like VS Code's Settings editor: "Tab › Group: Label", id, description, control, notes. Presentation only. */
export interface SettingRowProps {
  readonly entry: ConfigEntry;
  /** The tab's label, for the "Tab › Group: " prefix. */
  readonly tabLabel: string;
  readonly view: View;
  /** The file Open config would open exists. */
  readonly layerFileExists: boolean;
  readonly busy: boolean;
  /** The search words to mark. */
  readonly terms: readonly string[];
  onSet(value: ConfigValue): void;
  onReset(): void;
  onOpen(layer: ConfigLayer): void;
}

function Marked({ text, terms }: { readonly text: string; readonly terms: readonly string[] }) {
  return <>{highlightParts(text, terms).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)}</>;
}

const WHY: Record<string, string> = {
  secret: "Credential", complex: "Complex value", "runtime-options": "Choices come from OMP at run time", "condition-unknown": "Newer visibility rule", oversize: "Too large to show", unsupported: "No fixed choices",
};

export function SettingRow({ entry, tabLabel, view, layerFileExists, busy, terms, onSet, onReset, onOpen }: SettingRowProps) {
  const { value, inherited } = shownValue(entry, view);
  const effective = view === "effective";
  const writable = !effective && entry.writable[view];
  const disabled = busy || !writable;
  const control = entry.control;
  const common = { entry, value, inherited, disabled, onCommit: onSet };
  const layer = fileLayerFor(entry, view);
  const secret = entry.readOnly?.reason === "secret";
  const state = effective ? null : entry.layers[view];
  const title = entry.description.length > 300 ? `${entry.description.slice(0, 300)}…` : entry.description;
  return <li className={`srow${isModified(entry, view) ? " mod" : ""}`} data-setting={entry.id}>
    <div className="srow-head">
      <span className="st"><span className="cat">{tabLabel}{entry.group ? ` › ${entry.group}` : ""}: </span><Marked text={entry.label} terms={terms} /></span>
      <span className="row-actions">
        {!effective && state !== null && state.state !== "unset" && entry.readOnly === null && <button type="button" className="btn icon ghost" disabled={busy} title={`Reset: remove this key from the ${view} config`} aria-label={`Reset ${entry.label}`} onClick={onReset}><Icon name="discard" /></button>}
        {!secret && <button type="button" className="btn icon ghost" disabled={!layerFileExists} title={layerFileExists ? "Open the config file at this key" : "That config file does not exist yet"} aria-label={`Open ${entry.label} in the ${layer} config file`} onClick={() => onOpen(layer)}><Icon name="go-to-file" /></button>}
      </span>
    </div>
    <div className="sid"><Marked text={entry.id} terms={terms} /></div>
    <div className="sdesc"><Marked text={title} terms={terms} /></div>
    {entry.warning && <div className="swarn" role="note"><Icon name="warning" /><div>{entry.warning}</div></div>}
    <div className="sctl">
      {entry.readOnly
        ? <span className="row-readonly"><Icon name={secret ? "lock" : "go-to-file"} /><span className="small muted" title={entry.readOnly.note}>{WHY[entry.readOnly.reason] ?? entry.readOnly.reason}</span>
          {state !== null && <span className="tag">{state.state === "unset" ? "not set" : secret || !state.summary ? "set" : state.summary}</span>}
          <span className="small">{entry.readOnly.note}</span></span>
        : <>
          {control?.kind === "boolean" && <BooleanControl {...common} control={control} />}
          {control?.kind === "enum" && <EnumControl {...common} control={control} />}
          {control?.kind === "number" && <NumberControl {...common} control={control} />}
          {control?.kind === "numeric" && <NumericControl key={String(value)} {...common} control={control} />}
          {control?.kind === "text" && <TextControl key={String(value)} {...common} control={control} />}
          {control?.kind === "multiselect" && <MultiSelectControl key={JSON.stringify(value)} {...common} control={control} />}
        </>}
    </div>
    <div className="snote">{rowNotes(entry, view).map((note, index) => <span key={index} className={`note ${note.tone}`} title={note.title}>{note.text}</span>)}</div>
  </li>;
}
