import type { BuildOptions } from "esbuild";

/** The esbuild options of the lazily loaded diagram renderer, `media/mermaid.js`. */
export const mermaidBuildOptions: BuildOptions;

/** The esbuild options of the diagram tab's page script, `media/mermaid-preview.js`. */
export const mermaidPreviewBuildOptions: BuildOptions;
