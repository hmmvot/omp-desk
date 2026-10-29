// Build entries for the OMP Desk extension.
//
//   src/extension.ts      -> out/extension.js          (VS Code extension host, CommonJS, `vscode` external)
//   src/webview/main.tsx  -> media/guest.js            (browser chat editor, IIFE loaded by the WebviewPanel)
//   src/webview/mermaid-preview/main.ts -> media/mermaid-preview.js (page of the diagram tab; loads media/mermaid.js)
//   src/webview/mermaid/entry.ts -> media/mermaid.js    (diagram renderer the chat page loads lazily, IIFE; options in scripts/mermaid-bundle.mjs)
//   src/webview/terminal/entry.ts -> media/terminal.js  (xterm.js terminal renderer the chat and shell pages load lazily, IIFE; options in scripts/terminal-bundle.mjs)
//   src/webview/shell/main.tsx -> media/shell.js       (browser folder-shell editor, IIFE)
//   src/omp/host-control.ts -> out/omp-host-control.mjs (native OMP extension loaded with `omp -e`, ESM factory)
//   src/broker/pty-broker.ts -> out/pty/pty-broker.js  (extension-owned PTY broker, detached Node process)
//
// The broker is not just a bundle: `out/pty/` is a *tree* — the entry, the
// owner-watch helper, and the `node-pty` package with its prebuilt native
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
import { mermaidBuildOptions, mermaidPreviewBuildOptions } from "./scripts/mermaid-bundle.mjs";
import { terminalBuildOptions } from "./scripts/terminal-bundle.mjs";
import { ensureKoffiAddon, nativeTarget } from "./scripts/native-assets.mjs";
import { recordPtyTreeDigestAfter, removePtyTreeDigest } from "./scripts/pty-tree-digest.mjs";

const watch = process.argv.includes("--watch");
/** Build only the broker tree: useful while working on the PTY surface alone. */
const ptyOnly = process.argv.includes("--pty");

/**
 * Makes the one import of `src/wiring/rare-subsystems.ts` (from `rare-subsystems-loader.ts`) a `require("./rare-subsystems.js")` of
 * the file the `rare-subsystems` target writes beside `out/extension.js`, instead of bundling the module in (ADR-0085).
 * @type {import("esbuild").Plugin}
 */
const rareSubsystemsExternal = {
  name: "rare-subsystems-external",
  setup(build) {
    build.onResolve({ filter: /(^|[\\/])rare-subsystems\.ts$/ }, () => ({ path: "./rare-subsystems.js", external: true }));
  },
};

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
      // The rarely used host code is the `rare-subsystems` target below, read by the first caller (ADR-0085).
      plugins: [rareSubsystemsExternal],
      // The host-control module reads `import.meta.url` to locate its PowerShell
      // helper; in a CommonJS bundle that is expected to be empty and the
      // `__dirname` branch is the one that runs, so the esbuild warning is noise.
      logOverride: { "empty-import-meta": "silent" },
    },
  },
  {
    // Provider login and logout, the Models / Agents / OMP Settings editors and the Desk Settings view: host code that most
    // windows never run. It carries its own copy of the shared modules it uses; `out/extension.js` reads it on first use.
    name: "rare-subsystems",
    options: {
      entryPoints: ["src/wiring/rare-subsystems.ts"],
      outfile: "out/rare-subsystems.js",
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["vscode"],
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
      // The Webview loads one script with no module resolution: bundle React and the wire. xterm.js is not part of it:
      // `media/terminal.js` is (see the `terminal` target), and the build fails if it slips back in.
      define: { "process.env.NODE_ENV": '"production"' },
    },
  },
  {
    // The chat page's diagram renderer, loaded by `guest.js` only when a reply has a mermaid block.
    // It is a script of its own so the 3.4 MB of mermaid never loads for a page that has no diagram.
    name: "mermaid",
    options: mermaidBuildOptions,
  },
  {
    // The diagram tab's page script ("Open diagram in a tab"); its document loads media/mermaid.js before it.
    name: "mermaid-preview",
    options: mermaidPreviewBuildOptions,
  },
  {
    // The chat page's and the shell page's terminal renderer: xterm.js, its addons and its stylesheet, loaded by `guest.js` and
    // `shell.js` only when a pane first shows a terminal. A script of its own so the page that never shows one never parses it.
    name: "terminal",
    options: terminalBuildOptions,
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
    // The full OMP settings editor's page (ADR-0071): message-only, like the Models/Agents page.
    name: "omp-settings",
    options: {
      entryPoints: ["src/webview/omp-settings/main.tsx"], outfile: "media/omp-settings.js",
      bundle: true, platform: "browser", format: "iife", target: "es2022",
      jsx: "automatic", jsxImportSource: "react",
      define: { "process.env.NODE_ENV": '"production"' },
    },
  },
  {
    // The Settings view's page (a webview view in the OMP Desk side bar): message-only, like the Models/Agents page.
    name: "desk-settings",
    options: {
      entryPoints: ["src/webview/desk-settings/main.tsx"], outfile: "media/desk-settings.js",
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
    name: "config-settings-worker",
    options: {
      entryPoints: ["src/omp/config-settings-worker.ts"], outfile: "out/config-settings-worker.mjs",
      bundle: true, platform: "node", format: "esm", target: "es2022",
      external: ["bun", "bun:sqlite"],
    },
  },
  {
    name: "inventory-worker",
    options: {
      entryPoints: ["src/omp/inventory-worker.ts"], outfile: "out/inventory-worker.mjs",
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
  {
    // The one-shot child that stages the native module and verifies the tree it lands in
    // (`node out/native-stage.js <packaged koffi.node> <storage directory>`, ADR-0076). It runs under the
    // extension host's own executable as Node, from the install folder, and lives for about a second.
    name: "native-stage",
    options: {
      entryPoints: ["src/runtime/native-stage.ts"],
      outfile: "out/native-stage.js",
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
    },
  },
];

const shared = {
  sourcemap: true,
  // A watch build stays readable for debugging; what ships is minified: the extension host parses
  // `out/extension.js` at every window start and a session editor parses `media/guest.js` when it
  // opens, and the unminified bundles were about twice the size (2.1 MB and 2.0 MB against 1.1 MB each).
  minify: !watch,
  logLevel: "info",
  // Preserve bundled MIT/@license banners for third-party attribution.
  legalComments: "eof",
};

/**
 * Ship koffi's prebuilt `koffi.node` as `out/native/koffi.node` (ADR-0076).
 *
 * One file per build: the architecture of `OMP_DESK_TARGET`, else of this machine, so a
 * platform-specific VSIX never carries another architecture's binary. The extension stages it
 * like every other file it loads (`src/wire/runtime-assets.ts`). `ensureKoffiAddon` refuses a
 * file that is not the pinned bytes or is built for another architecture, and never builds
 * koffi from source.
 */
async function copyNativeAddon() {
  const target = nativeTarget();
  const source = await ensureKoffiAddon(target, process.cwd());
  const destination = path.join("out", "native", "koffi.node");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  console.log(`copied native addon (${target}) -> ${destination.split(path.sep).join("/")}`);
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
 * Three things move here. The checked-in owner watcher is copied next to the broker entry
 * (the identity readings are in-process calls through `out/native/koffi.node`, which the staged
 * tree also carries, ADR-0076), and `node-pty` is copied as a
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
  const helpers = ["pty-owner-watch.ps1"];
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
      // Nothing to assemble until the helper exists; the runtime reports the tree as
      // incomplete rather than starting a broker that cannot watch its owners.
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

/** Targets whose inputs are checked against {@link assertBundleBoundary}. */
const boundaryChecked = new Set(["extension", "guest", "shell", "mermaid", "mermaid-preview", "terminal"]);

/**
 * Keeps what a page loads on demand out of the page's own bundle: the 3.4 MB diagram renderer (guest, diagram tab) and xterm.js
 * (guest, shell) — either slipping back in costs the page the megabytes or the 390 KB the designs
 * (docs/designs/2026-10-13-chat-mermaid-diagrams.md, docs/designs/2026-10-28-lazy-xterm-and-rarely-used-host-code.md) say it does
 * not pay — the two packages mermaid stubs out of its renderer, and the rarely used host code (`out/rare-subsystems.js`) out of
 * `out/extension.js`, which every window evaluates at start.
 * @param {string} name build target name
 * @param {string[]} inputs every file the target bundled
 */
function assertBundleBoundary(name, inputs) {
  const bundled = inputs.map(input => input.replaceAll("\\", "/"));
  const mermaid = input => input.includes("node_modules/mermaid/") || input.includes("node_modules/@mermaid-js/");
  const xterm = input => input.includes("node_modules/@xterm/");
  const rareHostCode = input => /src\/(host\/(omp-settings-editor|omp-config-editor|provider-login-flow|provider-login-rpc|desk-settings\/view)|wiring\/(rare-subsystems|provider-login-ui))\.ts$/.test(input);
  const forbidden = {
    extension: rareHostCode,
    guest: input => mermaid(input) || xterm(input),
    shell: xterm,
    "mermaid-preview": mermaid,
    terminal: input => mermaid(input) || /src\/webview\/(main|shell\/main)\.tsx$/.test(input),
    mermaid: input => input.includes("node_modules/elkjs/") || input.includes("node_modules/katex/"),
  }[name];
  const stray = forbidden === undefined ? [] : bundled.filter(forbidden);
  if (stray.length > 0) throw new Error(`${name} bundle pulled in files it must not contain (${stray.length}), first: ${stray[0]}`);
}

async function main() {
  const selected = ptyOnly ? targets.filter(({ name }) => name === "pty-broker") : targets;
  if (watch) {
    // A watch build rewrites the broker after every change, so no record is kept and the host hashes the tree itself.
    await removePtyTreeDigest();
    const contexts = await Promise.all(selected.map(({ options }) => esbuild.context({ ...shared, ...options })));
    await Promise.all(contexts.map(context => context.watch()));
    if (!ptyOnly) await copyCodicons();
    await copyNativeAddon();
    await copyPtyRuntime();
    console.log(`watching ${selected.length} build targets`);
    return;
  }
  // The host takes the recorded digest as the identity of the broker runtime instead of hashing the tree at every start, so a
  // record may exist only when the build that wrote it finished: it is removed before the first output and written last.
  const recorded = await recordPtyTreeDigestAfter(async () => {
    for (const { name, options } of selected) {
      const result = await esbuild.build({ ...shared, ...options, metafile: boundaryChecked.has(name) });
      if (result.metafile) assertBundleBoundary(name, Object.keys(result.metafile.inputs));
      console.log(`built ${name} -> ${options.outfile}`);
    }
    if (!ptyOnly) await copyCodicons();
    await copyNativeAddon();
    await copyPtyRuntime();
  });
  console.log(recorded === null ? "no pty tree digest recorded (tree incomplete)" : `recorded pty tree digest ${recorded.digest.slice(0, 12)} (${recorded.files} files) -> out/pty-tree.json`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
