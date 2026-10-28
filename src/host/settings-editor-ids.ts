/**
 * The view types of the settings editors' webview panels.
 *
 * Known at activation, where the panel serializers that revive a restored panel are registered; the editors themselves
 * (`./omp-settings-editor.ts`, `./omp-config-editor.ts`) load with the first command or the first revived panel (ADR-0085).
 */

/** The Models and Agents editors (`ompDesk.openModels`, `ompDesk.openAgents`). */
export const SETTINGS_EDITOR_VIEW_TYPE = "omp.settings";

/** The full OMP settings editor (`ompDesk.openOmpSettings`, `/settings` in Chat). */
export const OMP_CONFIG_EDITOR_VIEW_TYPE = "ompDesk.ompSettings";
