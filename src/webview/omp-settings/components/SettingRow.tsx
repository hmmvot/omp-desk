import { entryBadges, shownValue } from "../model";
import { BooleanControl, EnumControl, MultiSelectControl, NumberControl, NumericControl, TextControl } from "./Controls";
import type { ConfigEntry, ConfigLayer, ConfigValue } from "../../../protocol/omp-config-model";

/** One setting: label, description, badges and the control for the layer being edited. Presentation only. */
export interface SettingRowProps {
  readonly entry: ConfigEntry;
  readonly layer: ConfigLayer;
  /** The layer's file exists, so Open in YAML has something to open. */
  readonly layerFileExists: boolean;
  /** The layer cannot be written in this scope (global scope has no project folder). */
  readonly layerUnavailable: boolean;
  readonly busy: boolean;
  readonly showTab: string | null;
  onSet(value: ConfigValue): void;
  onReset(): void;
  onOpen(): void;
}

export function SettingRow({ entry, layer, layerFileExists, layerUnavailable, busy, showTab, onSet, onReset, onOpen }: SettingRowProps) {
  const { value, inherited } = shownValue(entry, layer);
  const writable = entry.writable[layer] && !layerUnavailable;
  const disabled = busy || !writable;
  const control = entry.control;
  const common = { entry, value, inherited, disabled, onCommit: onSet };
  const layerSet = entry.layers[layer].state !== "unset";
  return <li className={`row${entry.visible ? "" : " hidden-by-condition"}`} data-setting={entry.id}>
    <div className="row-head">
      <strong className="row-label">{entry.label}</strong>
      {showTab !== null && <span className="badge muted">{showTab}</span>}
      <code className="row-id">{entry.id}</code>
    </div>
    {entry.warning && <p className="row-warning" role="note">{entry.warning}</p>}
    <p className="row-description muted">{entry.description}</p>
    {entry.condition && <p className="row-condition small muted">{entry.condition.note}</p>}
    <div className="row-badges">{entryBadges(entry).map(badge => <span key={badge.text} className={`badge ${badge.tone}`} title={badge.title}>{badge.text}</span>)}</div>
    {entry.readOnly
      ? <div className="row-readonly"><p className="small">{entry.readOnly.note}</p>
        {entry.readOnly.reason !== "secret" && <button type="button" className="secondary" disabled={!layerFileExists || layerUnavailable} onClick={onOpen}>Open {layer} YAML at this key</button>}</div>
      : <div className="row-control">
        {control?.kind === "boolean" && <BooleanControl {...common} control={control} />}
        {control?.kind === "enum" && <EnumControl {...common} control={control} />}
        {control?.kind === "number" && <NumberControl {...common} control={control} />}
        {control?.kind === "numeric" && <NumericControl key={String(value)} {...common} control={control} />}
        {control?.kind === "text" && <TextControl key={String(value)} {...common} control={control} />}
        {control?.kind === "multiselect" && <MultiSelectControl key={JSON.stringify(value)} {...common} control={control} />}
        <button type="button" className="secondary" disabled={busy || layerUnavailable || !layerSet} title={`Remove this setting from the ${layer} layer`} onClick={onReset}>Reset</button>
        {inherited && writable && <span className="small muted">Not set in the {layer} layer</span>}
      </div>}
  </li>;
}
