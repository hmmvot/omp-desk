// Capability probe for a launcher that cannot take Bun's flags on its command line (ADR-0075).
// OMP Desk runs `omp --version` once with this module preloaded and a nonce defined, both carried only by
// BUN_OPTIONS. The nonce comes back on stderr only when Bun honoured the preload and the define. Nothing else is
// read, written or started, and BUN_OPTIONS is put back as the real modules do.
const optionsBase = process.env.OMP_VSCODE_BUN_OPTIONS_BASE;
if (optionsBase !== undefined) {
  delete process.env.OMP_VSCODE_BUN_OPTIONS_BASE;
  if (optionsBase === "") delete process.env.BUN_OPTIONS;
  else process.env.BUN_OPTIONS = optionsBase;
}

export const RUNTIME_PROBE_MARKER = "OMP_DESK_RUNTIME_PROBE";

const nonce = typeof __OMP_VSCODE_PROBE_NONCE === "string" ? __OMP_VSCODE_PROBE_NONCE : "";
process.stderr.write(`${RUNTIME_PROBE_MARKER} ${nonce}\n`);
