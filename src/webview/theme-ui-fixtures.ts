/** VS Code built-in theme tokens captured from an isolated workbench, with checkbox/widget/testing defaults resolved from the public color registry. */
const palettes = [
	{ name: "Dark Modern", bodyClass: "vscode-dark", colors: {
		foreground: "#cccccc", descriptionForeground: "#9d9d9d", "editor-background": "#1f1f1f", "editorWidget-background": "#202020",
		"input-background": "#313131", "input-foreground": "#cccccc", "input-border": "#3c3c3c", "button-background": "#0078d4", "button-foreground": "#ffffff", "button-hoverBackground": "#026ec1",
		"button-secondaryBackground": "rgba(0, 0, 0, 0)", "button-secondaryForeground": "#cccccc", "button-secondaryHoverBackground": "#2b2b2b", "button-border": "rgba(255, 255, 255, 0.1)", contrastBorder: "",
		"textPreformat-background": "#3c3c3c", "textPreformat-foreground": "#d0d0d0", "textCodeBlock-background": "#2b2b2b", "editorWarning-foreground": "#cca700",
		"inputValidation-warningBackground": "#352a05", "inputValidation-warningBorder": "#b89500", "panel-border": "#2b2b2b", focusBorder: "#0078d4",
		"editorHoverWidget-background": "#202020", "editorHoverWidget-foreground": "#cccccc", "editorHoverWidget-border": "rgba(204, 204, 204, 0.2)", "testing-iconPassed": "#73c991",
		errorForeground: "#f85149", "charts-blue": "#59a4f9", "textLink-foreground": "#4daafc", "list-hoverBackground": "#2a2d2e", "terminal-foreground": "#cccccc", "terminal-ansiBlue": "#2472c8",
		"checkbox-background": "#313131", "checkbox-foreground": "#cccccc", "checkbox-border": "#3c3c3c", "widget-border": "#313131", "testing-iconFailed": "#f88070",
	}, expected: { background: "rgb(31, 31, 31)", foreground: "rgb(204, 204, 204)", blue: "rgb(36, 114, 200)" } },
	{ name: "Light Modern", bodyClass: "vscode-light", colors: {
		foreground: "#3b3b3b", descriptionForeground: "#3b3b3b", "editor-background": "#ffffff", "editorWidget-background": "#f8f8f8",
		"input-background": "#ffffff", "input-foreground": "#3b3b3b", "input-border": "#cecece", "button-background": "#005fb8", "button-foreground": "#ffffff", "button-hoverBackground": "#0258a8",
		"button-secondaryBackground": "#e5e5e5", "button-secondaryForeground": "#3b3b3b", "button-secondaryHoverBackground": "#cccccc", "button-border": "rgba(0, 0, 0, 0.1)", contrastBorder: "",
		"textPreformat-background": "rgba(0, 0, 0, 0.12)", "textPreformat-foreground": "#3b3b3b", "textCodeBlock-background": "#f8f8f8", "editorWarning-foreground": "#bf8803",
		"inputValidation-warningBackground": "#f6f5d2", "inputValidation-warningBorder": "#b89500", "panel-border": "#e5e5e5", focusBorder: "#005fb8",
		"editorHoverWidget-background": "#f8f8f8", "editorHoverWidget-foreground": "#3b3b3b", "editorHoverWidget-border": "rgba(59, 59, 59, 0.2)", "testing-iconPassed": "#73c991",
		errorForeground: "#f85149", "charts-blue": "#0063d3", "textLink-foreground": "#005fb8", "list-hoverBackground": "#f2f2f2", "terminal-foreground": "#3b3b3b", "terminal-ansiBlue": "#0451a5",
		"checkbox-background": "#f8f8f8", "checkbox-foreground": "#3b3b3b", "checkbox-border": "#cecece", "widget-border": "#e5e5e5", "testing-iconFailed": "#b01011",
	}, expected: { background: "rgb(255, 255, 255)", foreground: "rgb(59, 59, 59)", blue: "rgb(4, 81, 165)" } },
	{ name: "High Contrast", bodyClass: "vscode-high-contrast", colors: {
		foreground: "#ffffff", descriptionForeground: "rgba(255, 255, 255, 0.7)", "editor-background": "#000000", "editorWidget-background": "#0c141f",
		"input-background": "#000000", "input-foreground": "#ffffff", "input-border": "#6fc3df", "button-background": "#000000", "button-foreground": "#ffffff", "button-hoverBackground": "#000000",
		"button-secondaryBackground": "", "button-secondaryForeground": "#ffffff", "button-secondaryHoverBackground": "", "button-border": "#6fc3df", contrastBorder: "#6fc3df",
		"textPreformat-background": "", "textPreformat-foreground": "#ffffff", "textCodeBlock-background": "#000000", "editorWarning-foreground": "#ffd370",
		"inputValidation-warningBackground": "#000000", "inputValidation-warningBorder": "#6fc3df", "panel-border": "#6fc3df", focusBorder: "#f38518",
		"editorHoverWidget-background": "#0c141f", "editorHoverWidget-foreground": "#ffffff", "editorHoverWidget-border": "#6fc3df", "testing-iconPassed": "#73c991",
		errorForeground: "#f48771", "charts-blue": "#59a4f9", "textLink-foreground": "#21a6ff", "list-hoverBackground": "rgba(255, 255, 255, 0.1)", "terminal-foreground": "#ffffff", "terminal-ansiBlue": "#0000ee",
		"checkbox-background": "#000000", "checkbox-foreground": "#ffffff", "checkbox-border": "#6fc3df", "widget-border": "#6fc3df", "testing-iconFailed": "",
	}, expected: { background: "rgb(0, 0, 0)", foreground: "rgb(255, 255, 255)", blue: "rgb(0, 0, 238)" } },
	{ name: "High Contrast Light", bodyClass: "vscode-high-contrast-light", colors: {
		foreground: "#292929", descriptionForeground: "rgba(41, 41, 41, 0.7)", "editor-background": "#ffffff", "editorWidget-background": "#ffffff",
		"input-background": "#ffffff", "input-foreground": "#292929", "input-border": "#0f4a85", "button-background": "#0f4a85", "button-foreground": "#ffffff", "button-hoverBackground": "#0f4a85",
		"button-secondaryBackground": "#ffffff", "button-secondaryForeground": "#292929", "button-secondaryHoverBackground": "", "button-border": "#0f4a85", contrastBorder: "#0f4a85",
		"textPreformat-background": "#09345f", "textPreformat-foreground": "#ffffff", "textCodeBlock-background": "#f2f2f2", "editorWarning-foreground": "#895503",
		"inputValidation-warningBackground": "#ffffff", "inputValidation-warningBorder": "#0f4a85", "panel-border": "#0f4a85", focusBorder: "#006bbd",
		"editorHoverWidget-background": "#ffffff", "editorHoverWidget-foreground": "#292929", "editorHoverWidget-border": "#0f4a85", "testing-iconPassed": "#007100",
		errorForeground: "#b5200d", "charts-blue": "#0063d3", "textLink-foreground": "#0f4a85", "list-hoverBackground": "rgba(15, 74, 133, 0.1)", "terminal-foreground": "#292929", "terminal-ansiBlue": "#0451a5",
		"checkbox-background": "#ffffff", "checkbox-foreground": "#292929", "checkbox-border": "#0f4a85", "widget-border": "#0f4a85", "testing-iconFailed": "",
	}, expected: { background: "rgb(255, 255, 255)", foreground: "rgb(41, 41, 41)", blue: "rgb(4, 81, 165)" } },
];

export const THEMES = palettes.map(({ name, bodyClass, colors, expected }) => ({
	name, bodyClass, expected,
	tokens: Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--vscode-${key}`, value])),
}));
