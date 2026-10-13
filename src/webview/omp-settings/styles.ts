export const OMP_SETTINGS_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.45}
main{max-width:960px;margin:auto;padding:20px 28px 64px}
h1{font-size:22px;font-weight:600;margin:0}h2{font-size:13px;font-weight:600;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground)}
p{margin:4px 0}
button,input,select{font:inherit}
button{border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:3px 10px;cursor:pointer}
button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
button:disabled{opacity:.5;cursor:default}
button.icon{padding:0 6px}
input[type=text],input[type=search],select{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;padding:3px 6px;min-width:0}
select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border-color:var(--vscode-dropdown-border,var(--vscode-panel-border))}
.inherited{opacity:.7}
input:focus,select:focus,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.muted{color:var(--vscode-descriptionForeground)}.small{font-size:12px}
code{font-family:var(--vscode-editor-font-family);font-size:12px;overflow-wrap:anywhere}
.header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.segmented{display:inline-flex}.segmented button{border-radius:0}.segmented button[aria-pressed=true]{background:var(--vscode-button-background)}.segmented button[aria-pressed=false]{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.search{width:100%;margin:12px 0 4px}
.tabs{display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--vscode-panel-border);margin:8px 0 12px}
.tabs button{background:none;color:var(--vscode-panelTitle-inactiveForeground);border:0;border-bottom:1px solid transparent;border-radius:0;padding:6px 10px;margin-bottom:-1px}
.tabs button[aria-selected=true]{color:var(--vscode-panelTitle-activeForeground);border-bottom-color:var(--vscode-panelTitle-activeBorder)}
.count{margin-left:4px;font-size:11px;color:var(--vscode-descriptionForeground)}
.lead{margin:0 0 6px}
.rows{list-style:none;margin:0;padding:0}
.row{border-bottom:1px solid var(--vscode-panel-border);padding:10px 0}
.row.hidden-by-condition{opacity:.65}
.row-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.row-id{color:var(--vscode-descriptionForeground)}
.row-description{margin:2px 0}.row-warning{color:var(--vscode-editorWarning-foreground)}.row-condition{margin:2px 0}
.row-badges{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0}
.row-control{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-top:4px}
.row-readonly{margin-top:4px}
.text-control{display:inline-flex;gap:6px}.text-control input{min-width:260px}
.field-error{color:var(--vscode-errorForeground)}
.badge{display:inline-block;padding:0 6px;border-radius:9px;font-size:11px;line-height:16px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}
.badge.layer{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-color:transparent}
.badge.env,.badge.warn{color:var(--vscode-editorWarning-foreground);border-color:currentColor}
label.check{display:inline-flex;gap:6px;align-items:center}
fieldset.multi{border:1px solid var(--vscode-panel-border);border-radius:2px;margin:0;padding:6px 10px}
.multi-list{list-style:none;margin:0 0 6px;padding:0}.multi-list li{display:flex;gap:6px;align-items:center}.move{display:inline-flex;gap:2px}
.status{min-height:20px;margin:8px 0}.status.error{color:var(--vscode-errorForeground)}
.notices{margin:8px 0;padding:4px 12px;border-left:3px solid var(--vscode-editorWarning-foreground)}
.footer{margin-top:24px}
.empty{padding:24px 0}
`;
