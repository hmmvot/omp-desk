/**
 * The OMP Settings page, laid out like VS Code's Settings editor (variant S1 of the 2026-10-13 proposal): header, search and
 * filter chips, the Global / Project / Effective switch, a table of contents beside one long list. Replace this and `components/`
 * to restyle; nothing here touches data or the host.
 */
export const OMP_SETTINGS_CSS = `
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.45}
#root{height:100%}
main{height:100%;min-height:420px;max-width:1500px;margin:auto;padding:16px 24px 10px;display:flex;flex-direction:column;overflow:auto}
h1{font-size:22px;font-weight:600;margin:0;line-height:1.2}
p{margin:4px 0}
button,input,select{font:inherit;color:inherit}
code{font-family:var(--vscode-editor-font-family);font-size:12px;overflow-wrap:anywhere}
.muted{color:var(--vscode-descriptionForeground)}.small{font-size:12px}.xs{font-size:11px}
.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px 14px;flex-wrap:wrap;margin-bottom:10px}
.sub{font-size:12px;color:var(--vscode-descriptionForeground);margin:2px 0 0}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:3px 10px;cursor:pointer;line-height:18px;white-space:nowrap}
.btn:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-button-secondaryBorder,var(--vscode-button-border,transparent))}
.btn.sec:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
.btn.icon{padding:2px 4px;min-width:24px;justify-content:center}
.btn.ghost{background:none;border-color:transparent;color:var(--vscode-textLink-foreground);padding:2px 6px}
.btn.ghost:hover:not(:disabled){background:var(--vscode-list-hoverBackground)}
.btn:disabled{opacity:.5;cursor:default}
.btn.chip{padding:1px 8px}
.vscode-high-contrast .btn,.vscode-high-contrast .btn.sec,.vscode-high-contrast-light .btn,.vscode-high-contrast-light .btn.sec{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-contrastBorder)}
.vscode-high-contrast .btn[aria-pressed=true],.vscode-high-contrast-light .btn[aria-pressed=true]{outline:1px solid var(--vscode-contrastActiveBorder)}
.vscode-high-contrast .btn.ghost,.vscode-high-contrast-light .btn.ghost{border-color:transparent}
input[type=text],input[type=search],select{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;padding:3px 6px;min-width:0;max-width:100%}
select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border-color:var(--vscode-dropdown-border,var(--vscode-panel-border));min-width:150px}
input:focus,select:focus,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.inherited{opacity:.7}
input:disabled,select:disabled{opacity:.6}
.searchbar{display:flex;flex-direction:column;gap:8px}
.searchbox{position:relative;display:flex;align-items:center}.searchbox>.codicon{position:absolute;left:8px;opacity:.7;pointer-events:none}.searchbox>input{padding:5px 8px 5px 28px;width:100%}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.layerbar{display:flex;gap:2px;border-bottom:1px solid var(--vscode-panel-border);margin:10px 0 4px;align-items:flex-end;flex-wrap:wrap;justify-content:space-between}
.layerbar [role=tablist]{display:flex;flex-wrap:wrap}
.layerbar .lt{background:none;border:0;border-bottom:2px solid transparent;padding:6px 12px;cursor:pointer;color:var(--vscode-panelTitle-inactiveForeground);display:inline-flex;gap:6px;align-items:center;margin-bottom:-1px}
.layerbar .lt[aria-selected=true]{color:var(--vscode-panelTitle-activeForeground);border-bottom-color:var(--vscode-panelTitle-activeBorder);font-weight:600}
.layerbar .lt:disabled{opacity:.45;cursor:default}
.layerbar .lt:hover:not(:disabled){color:var(--vscode-panelTitle-activeForeground)}
.vscode-high-contrast .layerbar .lt[aria-selected=true],.vscode-high-contrast-light .layerbar .lt[aria-selected=true]{border-bottom-width:3px}
.count-note{padding:0 6px 6px}
.pill{display:inline-block;padding:0 6px;border-radius:9px;font-size:11px;line-height:16px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:nowrap}
.vscode-high-contrast .pill,.vscode-high-contrast-light .pill{background:transparent;border:1px solid var(--vscode-contrastBorder);color:var(--vscode-foreground)}
.tag{display:inline-block;padding:0 5px;border-radius:2px;font-size:11px;line-height:16px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);white-space:nowrap}
.status{min-height:20px;margin:2px 0 6px;font-size:12px;display:flex;gap:6px;align-items:center}.status.error{color:var(--vscode-errorForeground)}
.notices{margin:6px 0;padding:4px 12px;border-left:3px solid var(--vscode-editorWarning-foreground)}
.s1grid{flex:1 1 0;min-height:280px;display:grid;grid-template-columns:230px minmax(0,1fr);border:1px solid var(--vscode-panel-border);border-radius:3px;overflow:hidden}
.toc{overflow:auto;border-right:1px solid var(--vscode-panel-border);padding:6px 0;font-size:13px}
.toc button{display:flex;width:100%;gap:6px;align-items:center;background:none;border:0;color:inherit;text-align:left;padding:3px 10px;cursor:pointer}
.toc button:hover{background:var(--vscode-list-hoverBackground)}
.toc button.t{font-weight:600;padding-top:5px}
.toc button.g{padding-left:24px;font-size:12.5px;color:var(--vscode-descriptionForeground)}
.toc button[aria-current=true]{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-foreground)}
.vscode-high-contrast .toc button[aria-current=true],.vscode-high-contrast-light .toc button[aria-current=true]{outline:1px solid var(--vscode-contrastActiveBorder);outline-offset:-1px;background:transparent}
.toc .cnt{margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground)}
.mdot{width:6px;height:6px;border-radius:50%;background:var(--vscode-settings-modifiedItemIndicator,var(--vscode-textLink-foreground));flex:none}
.list{overflow:auto;min-width:0;position:relative}
.s1gh{position:sticky;top:0;z-index:3;background:var(--vscode-editor-background);padding:10px 18px 4px;margin:0;font-size:15px;font-weight:600;border-bottom:1px solid var(--vscode-panel-border)}
.s1gh .lead{font-size:12px;font-weight:400;color:var(--vscode-descriptionForeground)}
.s1gh2{padding:10px 18px 2px;margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);font-weight:600}
.rows{list-style:none;margin:0;padding:0}
.srow{position:relative;padding:10px 14px 12px 18px;border-bottom:1px solid var(--vscode-panel-border);content-visibility:auto;contain-intrinsic-size:auto 110px}
.srow.mod::before{content:"";position:absolute;left:4px;top:10px;bottom:12px;width:3px;border-radius:2px;background:var(--vscode-settings-modifiedItemIndicator,var(--vscode-textLink-foreground))}
.srow:hover{background:var(--vscode-list-hoverBackground)}
.srow-head{display:flex;gap:6px;align-items:flex-start;justify-content:space-between}
.st{font-weight:600}.st .cat{font-weight:400;color:var(--vscode-descriptionForeground)}
.row-actions{display:flex;flex:none}
.sid{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground)}
.sdesc{font-size:12.5px;color:var(--vscode-descriptionForeground);margin:2px 0 6px;max-width:80ch}
.sctl{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:4px}
.snote{font-size:12px;color:var(--vscode-descriptionForeground);display:flex;gap:2px 12px;flex-wrap:wrap;margin-top:4px}
.note.error{color:var(--vscode-errorForeground)}.note.warning{color:var(--vscode-editorWarning-foreground)}.note.env{color:var(--vscode-charts-orange,var(--vscode-editorWarning-foreground))}
.note.info{color:var(--vscode-foreground)}
.swarn{display:flex;gap:8px;align-items:flex-start;font-size:12px;border-left:3px solid var(--vscode-editorWarning-foreground);background:var(--vscode-inputValidation-warningBackground);padding:4px 8px;margin:4px 0;max-width:80ch}
.swarn .codicon{color:var(--vscode-editorWarning-foreground);margin-top:2px}
.row-readonly{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
mark{background:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33));color:inherit;border-radius:2px}
.switch-row{display:inline-flex;gap:8px;align-items:center;margin:0}
.sw{position:relative;display:inline-block;width:30px;height:16px;flex:none;vertical-align:middle}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:1}
.sw input:disabled{cursor:default}
.sw i{position:absolute;inset:0;border-radius:8px;background:var(--vscode-input-background);border:1px solid var(--vscode-checkbox-border,var(--vscode-input-border,var(--vscode-panel-border)))}
.sw i::after{content:"";position:absolute;left:2px;top:2px;width:10px;height:10px;border-radius:50%;background:var(--vscode-descriptionForeground);transition:transform .1s}
.sw input:checked+i{background:var(--vscode-button-background);border-color:transparent}
.sw input:checked+i::after{transform:translateX(14px);background:var(--vscode-button-foreground)}
.sw input:disabled+i{opacity:.55}
.sw input:focus-visible+i{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.vscode-high-contrast .sw input:checked+i,.vscode-high-contrast-light .sw input:checked+i{background:transparent;border-color:var(--vscode-contrastActiveBorder)}
.vscode-high-contrast .sw input:checked+i::after,.vscode-high-contrast-light .sw input:checked+i::after{background:var(--vscode-foreground)}
.text-control{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}.text-control input{min-width:240px}
.field-error{color:var(--vscode-errorForeground)}
label.check{display:inline-flex;gap:6px;align-items:center}
fieldset.multi{border:1px solid var(--vscode-panel-border);border-radius:2px;margin:0;padding:6px 10px}
.multi-list{list-style:none;margin:0 0 6px;padding:0}.multi-list li{display:flex;gap:6px;align-items:center}.move{display:inline-flex;gap:2px}
fieldset.multi button{border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:2px 10px;cursor:pointer}
fieldset.multi button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
fieldset.multi button.icon{padding:0 6px}
fieldset.multi button:disabled{opacity:.5;cursor:default}
.text-control button{border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:2px 10px;cursor:pointer}
.text-control button:disabled{opacity:.5;cursor:default}
.footnote{display:flex;gap:6px;align-items:flex-start;margin:8px 0 0}
.empty{padding:30px;text-align:center}
@media (max-width:700px){.s1grid{grid-template-columns:minmax(0,1fr)}.toc{display:none}.page-head h1{font-size:18px}}
`;
