/** DOM-native tool presentation; only code, source and process output use monospace. */
export const TOOL_STYLES = `
.omp-native-tool .omp-tool-head { align-items: center; flex-wrap: nowrap; min-width: 0; }
.omp-native-tool .omp-tool-name, .omp-native-tool .omp-tool-digest { font-family: inherit; font-size: inherit; }
.omp-native-tool .omp-tool-head > .codicon, .omp-native-tool .omp-tool-name, .omp-native-tool .omp-tool-head > .omp-chip { flex: none; }
.omp-native-tool .omp-tool-head > .omp-native-tool-meta, .omp-native-tool .omp-tool-head > .omp-empty-note { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.omp-native-tool .omp-tool-head > .omp-tool-elapsed { flex: none; margin-left: auto; overflow: visible; }
.omp-native-tool .omp-tool-head--intent .omp-tool-digest, .omp-native-tool .omp-tool-head--inline .omp-tool-digest { flex: 0 1 auto; max-width: 60%; }
.omp-native-tool .omp-tool-head--intent .omp-tool-aux--intent { flex: 1 1 0; max-width: none; }
.omp-native-tool-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
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
.omp-native-preview-window { overflow: hidden; line-height: 1.45; }
.omp-native-preview-window--code { font-size: var(--omp-mono-size); }
.omp-native-preview-window--tail { display: flex; flex-direction: column; justify-content: flex-end; }
.omp-native-preview-window-content { flex: 0 0 auto; }
.omp-native-preview-window .omp-pre { max-height: none; overflow: visible; line-height: inherit; }
.omp-native-preview-window--code .omp-pre { font-size: inherit; }
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
.omp-native-code-line { white-space: pre-wrap; }
.omp-native-diff .omp-pre { padding: 0; }
.omp-native-diff .omp-pre > span { padding: 0 6px; white-space: pre-wrap; }
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
.omp-native-todo--completed, .omp-native-todo--abandoned { color: var(--vscode-descriptionForeground); }
.omp-native-todo--completed > .codicon { color: var(--vscode-testing-iconPassed); }
.omp-native-todo--abandoned > .codicon { color: var(--vscode-descriptionForeground); }
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
`;
