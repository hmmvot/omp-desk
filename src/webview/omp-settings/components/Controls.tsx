import { useId, useState } from "react";
import { moveMember, numberOptionFor, optionNumberValue, sameList, toggleMember } from "../model";
import { parseNumericInput } from "../../../protocol/omp-config-model";
import type { ConfigControl, ConfigEntry, ConfigValue } from "../../../protocol/omp-config-model";

/**
 * One control per setting kind. Presentation only: each takes the value to show and calls `onCommit` with the
 * value to save; none knows layers, files or the host. Replace these and `styles.ts` to restyle the editor.
 */
export interface ControlProps<K extends ConfigControl["kind"]> {
  readonly entry: ConfigEntry;
  readonly control: Extract<ConfigControl, { kind: K }>;
  readonly value: ConfigValue | undefined;
  /** The value comes from another layer or the default, not from the layer being edited. */
  readonly inherited: boolean;
  readonly disabled: boolean;
  readonly onCommit: (value: ConfigValue) => void;
}

export function BooleanControl({ entry, value, inherited, disabled, onCommit }: ControlProps<"boolean">) {
  return <label className="switch-row"><span className="sw"><input type="checkbox" aria-label={entry.label} checked={value === true} disabled={disabled} onChange={event => onCommit(event.target.checked)} /><i /></span>
    <span className={`small${inherited ? " muted" : ""}`}>{value === true ? "On" : "Off"}</span></label>;
}

export function EnumControl({ entry, control, value, inherited, disabled, onCommit }: ControlProps<"enum">) {
  const current = typeof value === "string" && control.options.some(option => option.value === value) ? value : "";
  return <select aria-label={entry.label} value={current} disabled={disabled} className={inherited ? "inherited" : ""} onChange={event => { if (event.target.value) onCommit(event.target.value); }}>
    {current === "" && <option value="" disabled>{typeof value === "string" ? `${value} (not a listed choice)` : "Choose…"}</option>}
    {control.options.map(option => <option key={option.value} value={option.value} title={option.description}>{option.label}</option>)}
  </select>;
}

export function NumberControl({ entry, control, value, inherited, disabled, onCommit }: ControlProps<"number">) {
  const known = numberOptionFor(control.options, typeof value === "number" ? value : undefined);
  return <select aria-label={entry.label} value={known?.value ?? ""} disabled={disabled} className={inherited ? "inherited" : ""}
    onChange={event => { const option = control.options.find(candidate => candidate.value === event.target.value); if (option) onCommit(optionNumberValue(option)); }}>
    {known === undefined && <option value="" disabled>{typeof value === "number" ? `${value} (not a listed choice)` : "Choose…"}</option>}
    {control.options.map(option => <option key={option.value} value={option.value} title={option.description}>{option.label}</option>)}
  </select>;
}

/** A typed number, checked by the same rule the worker applies; an invalid entry is explained inline and never sent. */
export function NumericControl({ entry, control, value, inherited, disabled, onCommit }: ControlProps<"numeric">) {
  const base = typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState(base);
  const dirty = draft !== base;
  const parsed = parseNumericInput(draft, control.integer);
  const message = dirty && "error" in parsed ? parsed.error : null;
  const commit = (): void => { if (dirty && "value" in parsed) onCommit(parsed.value); };
  return <span className="text-control">
    <input type="text" inputMode="decimal" aria-label={entry.label} aria-invalid={message !== null} aria-describedby={message === null ? undefined : `${entry.id}-error`} value={draft} disabled={disabled}
      className={inherited && !dirty ? "inherited" : ""} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } else if (event.key === "Escape") setDraft(base); }} />
    <button type="button" disabled={disabled || !dirty || !("value" in parsed)} onClick={commit}>Save</button>
    {message !== null && <span id={`${entry.id}-error`} role="alert" className="small field-error">{message}</span>}
  </span>;
}

export function TextControl({ entry, value, inherited, disabled, onCommit }: ControlProps<"text">) {
  const base = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState(base);
  const dirty = draft !== base;
  const commit = (): void => { if (dirty) onCommit(draft); };
  return <span className="text-control">
    <input type="text" aria-label={entry.label} value={draft} disabled={disabled} maxLength={4096} className={inherited && !dirty ? "inherited" : ""}
      onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } else if (event.key === "Escape") setDraft(base); }} />
    <button type="button" disabled={disabled || !dirty} onClick={commit}>Save</button>
  </span>;
}

export function MultiSelectControl({ entry, control, value, inherited, disabled, onCommit }: ControlProps<"multiselect">) {
  const base = Array.isArray(value) ? [...value] as string[] : [];
  const [draft, setDraft] = useState<readonly string[]>(base);
  const dirty = !sameList(draft, base);
  const group = useId();
  const order = control.ordered ? [...draft, ...control.options.map(option => option.value).filter(item => !draft.includes(item))] : control.options.map(option => option.value);
  return <fieldset className={`multi${inherited && !dirty ? " inherited" : ""}`} aria-label={entry.label} disabled={disabled}>
    <ul className="multi-list">
      {order.map(item => {
        const option = control.options.find(candidate => candidate.value === item);
        const position = draft.indexOf(item);
        return <li key={item}>
          <label className="check"><input type="checkbox" name={group} checked={position >= 0} onChange={() => setDraft(toggleMember(draft, item, control.options, control.ordered))} />
            <span>{control.ordered && position >= 0 ? `${position + 1}. ` : ""}{option?.label ?? item}</span></label>
          {control.ordered && position >= 0 && <span className="move">
            <button type="button" className="icon" aria-label={`Move ${option?.label ?? item} up`} disabled={position === 0} onClick={() => setDraft(moveMember(draft, item, -1))}>↑</button>
            <button type="button" className="icon" aria-label={`Move ${option?.label ?? item} down`} disabled={position === draft.length - 1} onClick={() => setDraft(moveMember(draft, item, 1))}>↓</button>
          </span>}
        </li>;
      })}
    </ul>
    <span className="toolbar"><button type="button" disabled={!dirty} onClick={() => onCommit([...draft])}>Save</button>
      <button type="button" className="secondary" disabled={!dirty} onClick={() => setDraft(base)}>Discard</button></span>
  </fieldset>;
}
