/** DOM-native tool presentation; only code, source and process output use monospace. */
export const TOOL_STYLES = `
.omp-native-tool .omp-tool-head { align-items: center; flex-wrap: nowrap; min-width: 0; }
.omp-native-tool .omp-tool-name, .omp-native-tool .omp-tool-digest { font-family: inherit; font-size: inherit; }
.omp-native-tool .omp-tool-head > .codicon, .omp-native-tool .omp-tool-name, .omp-native-tool .omp-tool-head > .omp-chip { flex: none; }
.omp-native-tool .omp-tool-head > .omp-native-tool-meta, .omp-native-tool .omp-tool-head > .omp-empty-note { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.omp-native-tool .omp-tool-head > .omp-tool-elapsed { flex: none; margin-left: auto; overflow: visible; }
.omp-native-tool .omp-tool-head--intent .omp-tool-digest, .omp-native-tool .omp-tool-head--inline .omp-tool-digest { flex: 0 1 auto; max-width: 60%; }
.omp-native-tool .omp-tool-head--intent .omp-tool-aux--intent { flex: 1 1 0; max-width: none; }
.omp-native-tool-meta { color: var(--omp-muted); font-size: 11px; }
/* Calm rows: a 26 px pitch, no success mark, a quiet name, the target in the foreground, links coloured only under the pointer. */
.omp-row--assistant:has(> .omp-body-block > .omp-native-tool) { padding-block: 0; }
.omp-native-tool { margin: 0; }
.omp-native-tool .omp-tool-head { padding: 3px 8px; }
.omp-native-tool .omp-tool-name { font-weight: 400; color: var(--omp-muted); }
.omp-native-tool .omp-tool-digest { color: var(--vscode-foreground); }
.omp-native-tool[data-tool-status="complete"] .omp-tool-head > .codicon:not(.codicon-chevron-right):not(.codicon-chevron-down):not(.codicon-blank) { font-size: 14px; color: var(--omp-muted); }
.omp-native-tool .omp-tool-digest .omp-file-link { color: var(--vscode-foreground); }
.omp-native-tool .omp-tool-head:hover .omp-tool-digest .omp-file-link, .omp-native-tool .omp-tool-digest .omp-file-link:focus-visible { color: var(--vscode-textLink-foreground); }
/* The row's muted words are read on the hover surface too: they take the foreground there. */
.omp-native-tool .omp-tool-head:hover .omp-tool-name, .omp-native-tool .omp-tool-head:focus-visible .omp-tool-name, .omp-native-tool .omp-tool-head:hover .omp-tool-aux, .omp-native-tool .omp-tool-head:hover .omp-native-tool-meta { color: var(--vscode-foreground); }
.omp-diff-stat { white-space: nowrap; }
.omp-diff-stat--add { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed)); }
.omp-diff-stat--del { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground)); }
.omp-native-tool .omp-tool-head > .omp-tool-counter { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }
/* A card that started a background job: its status chip in the head, and Cancel at the head's right edge (a sibling of the head button, never inside it). */
.omp-native-tool--job-cancel { position: relative; }
.omp-native-tool--job-cancel > .omp-tool-head { padding-right: 76px; }
.omp-job-cancel { position: absolute; top: 3px; right: 6px; height: 20px; padding: 0 8px; border: 1px solid var(--omp-border); border-radius: var(--omp-radius); background: var(--vscode-editor-background); color: var(--vscode-foreground); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; }
.omp-job-cancel:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.omp-job-cancel:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-job-cancel:disabled { opacity: 0.55; cursor: default; }
.omp-native-tool .omp-tool-head > .omp-job-chip { flex: none; padding: 0 6px; border: 1px solid var(--omp-border); border-radius: 10px; font-size: 11px; line-height: 16px; color: var(--omp-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.omp-job-chip--running { border-color: var(--vscode-charts-blue); color: var(--vscode-charts-blue); }
.omp-job-chip--completed { color: var(--vscode-testing-iconPassed); }
.omp-job-chip--failed { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
.omp-native-tool .omp-tool-body { padding: 4px 12px 8px 30px; }
.omp-wait-title-short { display: none; }
@media (max-width: 300px) {
	.omp-wait-title-full { display: none; }
	.omp-wait-title-short { display: inline; }
}
.omp-native-tool .omp-tool-head--static { flex-wrap: nowrap; cursor: default; }
.omp-native-tool .omp-tool-head--static:hover { background: none; }
.omp-native-tool .omp-tool-head--static .omp-tool-name { flex: none; }
.omp-native-tool .omp-tool-head--static .omp-tool-digest { flex: 0 1 auto; }
.omp-tool-aux { color: var(--omp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.omp-tool-aux--intent { flex: 0 1 auto; max-width: 45%; }
.omp-tool-aux--none { flex: none; }
.omp-native-tool .omp-tool-body { overflow-wrap: anywhere; }
.omp-output-marker { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 0; color: var(--omp-muted); font-size: 11px; }
.omp-output-more { display: inline-flex; align-items: center; gap: 4px; border: 0; padding: 1px 6px; background: transparent; color: var(--vscode-textLink-foreground); font: inherit; cursor: pointer; border-radius: var(--omp-radius); }
.omp-output-more:hover { text-decoration: underline; }
.omp-output-more:focus-visible, .omp-iconbtn:focus-visible, .omp-artifact-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.omp-output-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 2px 0 4px; font-size: 11px; color: var(--omp-muted); }
.omp-output-label { text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; }
.omp-output-spacer { flex: 1 1 0; }
.omp-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 0; border-radius: var(--omp-radius); background: transparent; color: var(--omp-muted); cursor: pointer; }
.omp-iconbtn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
.vscode-high-contrast .omp-iconbtn, .vscode-high-contrast-light .omp-iconbtn { border: 1px solid var(--vscode-contrastBorder); }
.omp-tool-input { margin-bottom: 6px; }
.omp-tool-raw { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--omp-border); }
.omp-tool-menu { position: relative; display: inline-flex; }
.omp-tool-menu-list { position: fixed; top: 0; left: 0; z-index: 30; display: flex; flex-direction: column; box-sizing: border-box; min-width: 190px; max-width: min(320px, 86vw); padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, var(--omp-border))); border-radius: var(--omp-radius-card); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3)); font-size: 12px; text-align: left; }
.vscode-high-contrast .omp-tool-menu-list, .vscode-high-contrast-light .omp-tool-menu-list { border-color: var(--vscode-contrastBorder); box-shadow: none; }
.omp-tool-menu-item { display: flex; align-items: flex-start; gap: 8px; width: 100%; box-sizing: border-box; padding: 4px 8px; border: 0; border-radius: var(--omp-radius); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.omp-tool-menu-item:hover:not([aria-disabled="true"]), .omp-tool-menu-item:focus-visible:not([aria-disabled="true"]) { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
.omp-tool-menu-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-tool-menu-item[aria-disabled="true"] { cursor: default; opacity: 0.75; }
.omp-tool-menu-item > .codicon { flex: none; margin-top: 2px; }
.omp-tool-menu-label { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.omp-tool-menu-reason { color: var(--omp-muted); font-size: 11px; }
/* An output bar that holds only the ⋯ menu (a running call with nothing to copy yet) takes no row: the menu sits in the body's top-right corner, which the body reserves as a gutter. */
.omp-native-tool .omp-tool-body { position: relative; }
.omp-native-tool .omp-tool-body--menu-only { min-height: 28px; padding-right: 34px; }
.omp-output-bar--menu-only { position: absolute; top: 2px; right: 6px; display: block; margin: 0; }
.omp-tool-footer { margin-top: 6px; color: var(--omp-muted); font-size: 11px; overflow-wrap: anywhere; }
.omp-tool-footer-warn { color: var(--vscode-editorWarning-foreground); }
.omp-artifact-link { border: 0; background: transparent; padding: 0; font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
/* A sticky element sticks inside the padding of its scroller, so the toolbar reaches back over the transcript's top padding. */
.omp-tool-toolbar { position: sticky; top: calc(-1 * var(--omp-transcript-pad-top, 0px)); z-index: 2; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 -4px 4px; padding: 3px 4px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--omp-border); }
.omp-tool-filter { flex: 1 1 120px; min-width: 0; max-width: 260px; box-sizing: border-box; height: 22px; padding: 0 6px; border: 1px solid var(--vscode-input-border, var(--omp-border)); border-radius: var(--omp-radius); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; font-size: 11px; }
.omp-tool-filter:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-tool-filter-count { color: var(--omp-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.omp-iconbtn[aria-pressed="true"] { color: var(--vscode-foreground); background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
/* The windowed full view: a block of fixed-height rows in the normal flow of the transcript. There is no scroller of its own: it clips sideways only. */
.omp-window { position: relative; overflow-x: auto; overflow-y: hidden; padding-bottom: 14px; box-sizing: content-box; font-family: var(--omp-mono); font-size: var(--omp-mono-size); background: var(--vscode-textCodeBlock-background); border-radius: var(--omp-radius); }
.omp-window-layer { position: absolute; left: 0; min-width: 100%; }
.omp-window .omp-pre { background: transparent; line-height: var(--omp-row-h); overflow: visible; }
.omp-window .omp-native-code-line, .omp-window .omp-native-diff .omp-pre > span { height: var(--omp-row-h); }
/* Code never wraps: every block of rows scrolls sideways. Only the reader's explicit Wrap (the toolbar switch) wraps them. */
.omp-rows--wrap .omp-pre { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.omp-prose-clip { max-height: 21em; overflow: hidden; }
.omp-native-tool .omp-tool-head > .omp-gist { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--omp-muted); font-variant-numeric: tabular-nums; }
.omp-gist--err { color: var(--vscode-errorForeground); }
.omp-gist--warn { color: var(--vscode-editorWarning-foreground); }
@media (max-width: 460px) { .omp-gist-opt { display: none; } }
.omp-native-agent-head--compact { cursor: default; flex-wrap: nowrap; overflow: hidden; white-space: nowrap; padding: 2px 0; }
.omp-native-agent-head--compact strong { overflow: hidden; text-overflow: ellipsis; }
.omp-native-tool--skipped { opacity: .7; }
.omp-native-list, .omp-native-answers, .omp-native-checklist { list-style: none; padding: 0; margin: 4px 0; }
.omp-native-list > li, .omp-native-answers > li, .omp-native-checklist > li { padding: 3px 0; }
.omp-native-path { overflow-wrap: anywhere; }
.omp-native-selected, .omp-native-diff-add { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed)); }
.omp-native-error { color: var(--vscode-errorForeground); }
.omp-native-warning { color: var(--vscode-editorWarning-foreground); }
.omp-native-match { background: var(--vscode-editor-findMatchHighlightBackground); }
.omp-native-line-number { display: inline-block; min-width: 3em; margin-right: 10px; text-align: right; color: var(--vscode-editorLineNumber-foreground, var(--omp-muted)); user-select: none; }
.omp-native-code-line, .omp-native-diff .omp-pre > span { display: block; min-height: 1em; }
.omp-native-diff .omp-pre { padding: 0; }
.omp-native-diff .omp-pre > span { padding: 0 6px; }
.omp-native-diff-sign { display: inline-block; width: 1em; }
.omp-native-diff-add { background: var(--vscode-diffEditor-insertedLineBackground, var(--vscode-diffEditor-insertedTextBackground)); }
.omp-native-diff-remove { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-testing-iconFailed)); background: var(--vscode-diffEditor-removedLineBackground, var(--vscode-diffEditor-removedTextBackground)); }
.omp-native-diff-hunk { color: var(--vscode-editorInfo-foreground); background: var(--vscode-editorWidget-background); }
.omp-native-diff-file { color: var(--vscode-foreground); font-weight: 600; background: var(--vscode-editorGroupHeader-tabsBackground); }
.omp-native-agent { border-left: 2px solid var(--omp-border); margin: 6px 0; }
.omp-native-agent-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; width: 100%; border: none; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; padding: 5px 8px; }
.omp-native-agent-head:hover { background: var(--vscode-list-hoverBackground); }
.omp-native-agent-body, .omp-native-agent-activity { padding: 4px 10px; }
.omp-native-agent-activity { color: var(--omp-muted); }
.omp-native-agent--failed, .omp-native-agent--merge-failed { border-color: var(--vscode-errorForeground); }
.omp-native-finding { border-left: 2px solid var(--vscode-editorWarning-foreground); padding: 4px 8px; margin: 4px 0; }
.omp-native-finding-location { color: var(--omp-muted); font-size: 11px; }
.omp-native-todo--completed, .omp-native-todo--abandoned { color: var(--omp-muted); }
.omp-native-todo--completed > .codicon { color: var(--vscode-testing-iconPassed); }
.omp-native-todo--abandoned > .codicon { color: var(--omp-muted); }
.omp-native-config-change { display: flex; align-items: baseline; gap: 6px; }
.omp-native-job-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.omp-native-job-label { color: var(--omp-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-native-job-description { color: var(--omp-muted); white-space: pre-line; }
.omp-native-job-head--row { flex-wrap: nowrap; align-items: center; min-width: 0; }
.omp-native-job-head--row > * { flex: none; }
.omp-native-job-head--row > .omp-native-job-label { flex: 1 1 0; min-width: 0; }
.omp-native-job-head--row > .omp-native-job-duration { margin-left: auto; font-variant-numeric: tabular-nums; }
.omp-native-job-head--row > strong { flex: 0 1 auto; min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-native-irc .omp-irc-route { flex: 0 1 auto; min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omp-native-irc .omp-irc-kind { flex: none; color: var(--omp-muted); font-size: 11px; }
.omp-native-irc .omp-irc-preview { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--omp-muted); font-size: 11px; }
.omp-native-irc .omp-tool-body p { margin: 0 0 4px; }
/* JSON and newline-delimited JSON: a gutter for the fold button and the record number. */
.omp-json-gutter { position: relative; display: inline-block; width: 2.2ch; user-select: none; }
.omp-json[data-json-kind="ndjson"] .omp-json-gutter { width: 8ch; }
.omp-json[data-json-kind="ndjson"] .omp-json-gutter::before { content: attr(data-n); display: inline-block; width: 5ch; margin-right: 1ch; text-align: right; color: var(--vscode-editorLineNumber-foreground, var(--omp-muted)); }
.omp-json-twisty { position: absolute; right: 0; top: 0; width: 2ch; height: 100%; padding: 0; border: 0; background: transparent; color: var(--omp-muted); font: inherit; line-height: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.omp-json-twisty:hover { color: var(--vscode-foreground); }
.omp-json-twisty:focus-visible, .omp-json-ghost--fold:focus-visible, .omp-segment:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.omp-json-twisty .codicon { font-size: 11px; }
.omp-json-ghost { color: var(--omp-muted); font-style: italic; }
.omp-json-ghost--fold { border: 0; border-radius: var(--omp-radius); padding: 0; background: var(--vscode-editorWidget-background); font-family: inherit; font-size: inherit; cursor: pointer; }
.omp-json-ghost--fold:hover { color: var(--vscode-foreground); }
.omp-segmented { display: inline-flex; border: 1px solid var(--omp-border); border-radius: var(--omp-radius); overflow: hidden; }
.omp-segment { border: 0; padding: 0 7px; background: transparent; color: var(--omp-muted); font: inherit; line-height: 18px; cursor: pointer; }
.omp-segment:hover { color: var(--vscode-foreground); }
.omp-segment[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
.vscode-high-contrast .omp-segment[aria-pressed="true"], .vscode-high-contrast-light .omp-segment[aria-pressed="true"] { outline: 1px solid var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); outline-offset: -1px; }
/* Tables, stack traces and the light tint of error, warning and pass lines. Colour never carries the meaning alone: the words stay. */
.omp-row { display: block; min-height: 1em; }
.omp-grid-row { display: grid; column-gap: 2ch; white-space: pre; }
.omp-grid-row > span { overflow: hidden; text-overflow: ellipsis; }
.omp-cell--right { text-align: right; }
.omp-grid-row--head { color: var(--omp-muted); font-weight: 600; }
.omp-row--frame { color: var(--omp-muted); }
.omp-row--frame .omp-file-link { color: inherit; text-decoration: underline; }
.omp-tone--err { color: var(--vscode-errorForeground); }
.omp-tone--warn { color: var(--vscode-editorWarning-foreground); }
.omp-tone--pass { color: var(--vscode-testing-iconPassed); }
.omp-window .omp-row { height: var(--omp-row-h); }
.omp-fold-all { display: inline-flex; }
@media (max-width: 460px) { .omp-fold-all { display: none; } }
/* A tool's own error or note in full (a rejected yield names every offending field), and a label/value grid (an experiment's metric against its baseline). */
.omp-tool-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.omp-tool-kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 4px 0; }
.omp-tool-kv > dt { color: var(--omp-muted); }
.omp-tool-kv > dd { margin: 0; font-variant-numeric: tabular-nums; }
`;
