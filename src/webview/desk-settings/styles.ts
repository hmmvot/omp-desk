/** Stylesheet of the Settings view page; theme colours come only from the VS Code theme variables. */
export const DESK_SETTINGS_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.45}
button,input,select,textarea{font:inherit}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bar{position:sticky;top:0;z-index:2;padding:8px 12px 6px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-panel-border,transparent)}
.search{position:relative;display:flex;align-items:center}
.search input{width:100%;padding:4px 26px 4px 6px}
.search .clear{position:absolute;right:2px}
.count{margin:4px 0 0;font-size:12px;color:var(--vscode-descriptionForeground);min-height:17px}
main{padding:0 12px 24px}
h2{margin:14px 0 4px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-descriptionForeground))}
.setting{padding:10px 0 12px;border-bottom:1px solid var(--vscode-panel-border,transparent)}
.setting:last-child{border-bottom:0}
.head{display:flex;align-items:flex-start;gap:6px}
.title{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}
label.title{display:block;cursor:default}
label.check{display:flex;align-items:flex-start;gap:6px;cursor:pointer}
label.check input{margin:2px 0 0}
.actions{display:flex;align-items:center;gap:2px;flex:none}
.key{display:block;font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere;margin:1px 0 0}
.desc{margin:6px 0 0;color:var(--vscode-descriptionForeground)}
.desc p{margin:0 0 4px}
.desc.clamp{max-height:4.4em;overflow:hidden}
.desc code,.preview{font-family:var(--vscode-editor-font-family);font-size:.95em}
.desc code{background:var(--vscode-textCodeBlock-background);padding:0 3px;border-radius:3px}
.control{margin:8px 0 0}
.option-desc{margin:4px 0 0;font-size:12px;color:var(--vscode-descriptionForeground)}
button{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:3px;background:none;color:var(--vscode-foreground);cursor:pointer;padding:2px 4px;line-height:16px}
button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}
button:disabled{opacity:.5;cursor:default}
button.link{padding:0;color:var(--vscode-textLink-foreground);border-radius:0}
button.link:hover:not(:disabled){background:none;color:var(--vscode-textLink-activeForeground);text-decoration:underline}
input[type=text],input[type=search],textarea,select{width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border,transparent));border-radius:2px;padding:4px 6px}
select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border-color:var(--vscode-dropdown-border,var(--vscode-panel-border,transparent))}
textarea{min-height:56px;resize:vertical}
input::placeholder{color:var(--vscode-input-placeholderForeground)}
input[aria-invalid=true],textarea[aria-invalid=true]{border-color:var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground))}
input:focus,select:focus,textarea:focus,button:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
input[type=checkbox],input[type=radio]{accent-color:var(--vscode-checkbox-selectBackground,var(--vscode-focusBorder));flex:none}
.badge{display:inline-block;padding:0 6px;border-radius:9px;font-size:11px;font-weight:400;line-height:16px;white-space:nowrap;border:1px solid var(--vscode-panel-border,currentColor);color:var(--vscode-descriptionForeground)}
.badge.set{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-color:transparent}
.targets{border:0;margin:6px 0 0;padding:0;display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--vscode-descriptionForeground)}
.targets label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.note{margin:4px 0 0;font-size:12px;color:var(--vscode-descriptionForeground)}
.note.warn,.deprecated{color:var(--vscode-editorWarning-foreground)}
.message{margin:6px 0 0;font-size:12px;display:flex;gap:4px;align-items:flex-start}
.message.error,.invalid{color:var(--vscode-errorForeground)}
.invalid{margin:4px 0 0;font-size:12px}
.preview{margin:0;padding:6px 8px;max-height:96px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background);border-radius:3px}
.test{margin:8px 0 0}
.test button{padding:2px 12px;color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));background:var(--vscode-button-secondaryBackground,transparent);border-color:var(--vscode-button-border,var(--vscode-panel-border,transparent))}
.test button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground))}
.test .message{display:block;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{padding:20px 4px;text-align:center;color:var(--vscode-descriptionForeground)}
@media (forced-colors:active){button:focus-visible{outline:2px solid CanvasText}}
`;
