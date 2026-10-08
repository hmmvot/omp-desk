// Build entries for the OMP Desk extension.
//
//   src/extension.ts      -> out/extension.js          (VS Code extension host, CommonJS, `vscode` external)
//   src/webview/main.tsx  -> media/guest.js            (browser chat editor, IIFE loaded by the WebviewPanel)
//   src/webview/shell/main.tsx -> media/shell.js       (browser folder-shell editor, IIFE)
//   src/omp/host-control.ts -> out/omp-host-control.mjs (native OMP extension loaded with `omp -e`, ESM factory)
//   src/broker/pty-broker.ts -> out/pty/pty-broker.js  (extension-owned PTY broker, detached Node process)
//
// The broker is not just a bundle: `out/pty/` is a *tree* — the entry, the
// PowerShell identity probe, and the `node-pty` package with its prebuilt native
// addon, `conpty.dll` and `OpenConsole.exe`. `src/host/pty-runtime.ts` stages that
// whole tree into content-addressed global storage (ADR-0012) and proves it with
// `pty-broker.js --self-check` before any session runs from it.
//
// Run `node esbuild.mjs` for a one-shot build, `node esbuild.mjs --watch` while
// iterating, or `node esbuild.mjs --pty` to build only the broker tree.
import esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

const watch = process.argv.includes("--watch");
/** Build only the broker tree: useful while working on the PTY surface alone. */
const ptyOnly = process.argv.includes("--pty");

/** @type {Array<{ name: string, options: import("esbuild").BuildOptions }>} */
const targets = [
  {
    name: "extension",
    options: {
      entryPoints: ["src/extension.ts"],
      outfile: "out/extension.js",
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      // Provided by the extension host at runtime; everything else is bundled.
      external: ["vscode"],
      // The host-control module reads `import.meta.url` to locate its PowerShell
      // helper; in a CommonJS bundle that is expected to be empty and the
      // `__dirname` branch is the one that runs, so the esbuild warning is noise.
      logOverride: { "empty-import-meta": "silent" },
    },
  },
  {
    name: "guest",
    options: {
      entryPoints: ["src/webview/main.tsx"],
      outfile: "media/guest.js",
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: "react",
      // The guest document allows styles only through its nonced `<style>` element, so
      // the terminal stylesheet is imported as text and injected by the guest itself
      // rather than emitted as a file to link.
      loader: { ".css": "text" },
      // The Webview loads one script with no module resolution: bundle React and the wire.
      define: { "process.env.NODE_ENV": '"production"' },
    },
  },
  {
    // The folder-shell editor's renderer: the same Webview rules as the chat guest, a
    // different entry, loaded by the host-generated page from `media/shell.js`.
    name: "shell",
    options: {
      entryPoints: ["src/webview/shell/main.tsx"],
      outfile: "media/shell.js",
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: "react",
      loader: { ".css": "text" },
      define: { "process.env.NODE_ENV": '"production"' },
    },
  },
  {
    name: "settings",
    options: {
      entryPoints: ["src/webview/settings/main.tsx"], outfile: "media/settings.js",
      bundle: true, platform: "browser", format: "iife", target: "es2022",
      jsx: "automatic", jsxImportSource: "react",
      define: { "process.env.NODE_ENV": '"production"' },
    },
  },
  {
    name: "settings-worker",
    options: {
      entryPoints: ["src/omp/settings-worker.ts"], outfile: "out/settings-worker.mjs",
      bundle: true, platform: "node", format: "esm", target: "es2022",
      external: ["bun", "bun:sqlite"],
    },
  },
  {
    // Loaded by the launched native OMP process (`omp -e out/omp-host-control.mjs`).
    // The `.mjs` extension makes the ESM factory unambiguous without setting a
    // package-wide "type": "module", which would break the CommonJS extension bundle.
    name: "host-control",
    options: {
      entryPoints: ["src/omp/host-control.ts"],
      outfile: "out/omp-host-control.mjs",
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
    },
  },
  {
    // The detached PTY broker (`node out/pty/pty-broker.js ...`, see
    // `src/broker/pty-broker.ts`). `node-pty` is external and *staged as a package*
    // beside this bundle: the addon loads `conpty.dll`/`OpenConsole.exe` from paths
    // relative to its own directory, and a worker script from `__dirname`, so its
    // published layout has to survive both bundling boundaries and staging.
    name: "pty-broker",
    options: {
      entryPoints: ["src/broker/pty-broker.ts"],
      outfile: "out/pty/pty-broker.js",
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["node-pty"],
    },
  },
];

const shared = {
  sourcemap: true,
  logLevel: "info",
  // Preserve bundled MIT/@license banners for third-party attribution.
  legalComments: "eof",
};

/**
 * Ship the host-control PowerShell helper next to the extension bundle.
 *
 * The extension stages this file, together with the host-control module, into
 * extension global storage and runs PowerShell from that verified copy
 * (`src/runtime-assets.ts`), so nothing starts it out of the installed extension
 * folder. The copy here is still part of the build rather than a manual step, and
 * host control refuses visibly when staging finds no helper.
 */
async function copyControlHelper() {
  for (const name of ["verified-pipe.ps1", "session-lease-probe.ps1"]) {
    const source = path.join("src", "host", name);
    try {
      await fs.access(source);
    } catch {
      // No helper in this checkout: nothing to copy; staging reports it at run time.
      continue;
    }
    await fs.mkdir("out", { recursive: true });
    await fs.copyFile(source, path.join("out", name));
    console.log(`copied helper -> out/${name}`);
  }
}

/** File names of `node-pty` that the staged broker tree needs at run time. */
function ptyRuntimeFile(relative) {
  const posix = relative.split(path.sep).join("/");
  if (posix === "package.json") return true;
  if (!posix.startsWith("lib/")) return false;
  // The published library, minus its source maps and its own tests: the broker loads
  // `lib/index.js`, the Windows terminal internals, the `worker/` script it forks and
  // the `shared/` module that worker requires.
  return posix.endsWith(".js") && !posix.endsWith(".test.js");
}

/**
 * Prebuilt native directories to ship.
 *
 * With `OMP_DESK_TARGET=win32-x64|win32-arm64` (set by `scripts/package-vsix.mjs`) only
 * that target's directory ships, so a platform-specific VSIX never carries another
 * architecture's binaries. Without it, this host's directory and every Windows one
 * ship, which is what a local build and the tests use.
 */
function ptyPrebuildDirectories() {
  const target = process.env.OMP_DESK_TARGET;
  if (target !== undefined && target !== "") {
    if (target !== "win32-x64" && target !== "win32-arm64") {
      throw new Error(`OMP_DESK_TARGET must be win32-x64 or win32-arm64, got "${target}"`);
    }
    return [`prebuilds/${target}`];
  }
  const directories = [`prebuilds/${process.platform}-${process.arch}`];
  if (process.platform === "win32") {
    for (const arch of ["x64", "arm64"]) {
      const candidate = `prebuilds/win32-${arch}`;
      if (!directories.includes(candidate)) directories.push(candidate);
    }
  }
  return directories;
}

/**
 * Assemble the broker runtime tree under `out/pty/`.
 *
 * Three things move here. The two checked-in helpers — the identity probe and the
 * owner watcher — are copied next to the broker entry, and `node-pty` is copied as a
 * *package* (`package.json`, `lib/**`, and the prebuilt native directory for this
 * platform) under `node_modules/`, which is where the staged bundle resolves it from.
 * The native directory matters most: `conpty.node` loads `conpty/conpty.dll`, which
 * loads `OpenConsole.exe` from beside itself, so the prebuild's own layout is part of
 * the ABI, not an implementation detail.
 *
 * The destination is emptied first. It is a build output, not a staged copy: a file
 * left over from an earlier dependency version would be staged into the runtime tree
 * and would silently change what the broker runs from it.
 */
async function copyPtyRuntime() {
  const helpers = ["pty-process-probe.ps1", "pty-owner-watch.ps1"];
  const sources = helpers.map(name => ({ name, path: path.join("src", "host", name) }));
  const destination = path.join("out", "pty");
  const packageRoot = path.join("node_modules", "node-pty");
  const packageTarget = path.join(destination, "node_modules", "node-pty");
  const present = [];
  for (const source of sources) {
    try {
      await fs.access(source.path);
      present.push(source);
    } catch {
      // Nothing to assemble until both helpers exist; the runtime reports the tree as
      // incomplete rather than starting a broker that cannot prove identity or owners.
    }
  }
  if (present.length !== sources.length) return;
  await fs.rm(packageTarget, { recursive: true, force: true });
  await fs.mkdir(packageTarget, { recursive: true });
  for (const source of present) await fs.copyFile(source.path, path.join(destination, source.name));
  let copied = 0;
  const prebuilds = ptyPrebuildDirectories();
  const entries = await fs.readdir(packageRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = path.relative(packageRoot, path.join(entry.parentPath, entry.name));
    const posix = relative.split(path.sep).join("/");
    const wanted =
      ptyRuntimeFile(relative) ||
      (prebuilds.some(directory => posix.startsWith(`${directory}/`)) && !posix.endsWith(".pdb"));
    if (!wanted) continue;
    const target = path.join(packageTarget, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(packageRoot, relative), target);
    copied += 1;
  }
  console.log(`copied pty runtime -> out/pty (${copied} node-pty files, prebuilds: ${prebuilds.join(", ")})`);
}

async function copyCodicons() {
  const source = path.join("node_modules", "@vscode", "codicons", "dist");
  await fs.mkdir("media/codicons", { recursive: true });
  for (const file of ["codicon.css", "codicon.ttf"]) {
    await fs.copyFile(path.join(source, file), path.join("media", "codicons", file));
  }
  await fs.copyFile(path.join(source, "..", "LICENSE"), path.join("media", "codicons", "LICENSE"));
  await fs.copyFile(path.join(source, "..", "LICENSE-CODE"), path.join("media", "codicons", "LICENSE-CODE"));
}

async function main() {
  const selected = ptyOnly ? targets.filter(({ name }) => name === "pty-broker") : targets;
  if (watch) {
    const contexts = await Promise.all(selected.map(({ options }) => esbuild.context({ ...shared, ...options })));
    await Promise.all(contexts.map(context => context.watch()));
    if (!ptyOnly) { await copyControlHelper(); await copyCodicons(); }
    await copyPtyRuntime();
    console.log(`watching ${selected.length} build targets`);
    return;
  }
  for (const { name, options } of selected) {
    await esbuild.build({ ...shared, ...options });
    console.log(`built ${name} -> ${options.outfile}`);
  }
  if (!ptyOnly) { await copyControlHelper(); await copyCodicons(); }
  await copyPtyRuntime();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
