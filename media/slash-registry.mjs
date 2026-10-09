#!/usr/bin/env bun
/**
 * Print the installed OMP's builtin slash-command registry: each builtin's name, aliases and whether it
 * has a text-mode `handle` (the builtins `--mode rpc-ui` can run; the rest reach the model as text).
 *
 * The extension host is Node and the installed agent is TypeScript, so its registry module can only be
 * imported by Bun. This helper only imports and reads; it starts no session and writes nothing.
 *
 * Usage: bun slash-registry.mjs --package-root <dir>
 * Output: one JSON line on stdout, `{ok:true, commands:[{name, aliases, handled}]}` or `{ok:false}`.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const index = argv.indexOf("--package-root");
const root = index < 0 ? undefined : argv[index + 1];

function answer(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (root === undefined || !path.isAbsolute(root)) {
  answer({ ok: false });
  process.exit(1);
}
try {
  // The module path is the selected install's, known only at run time.
  const registry = await import(pathToFileURL(path.join(root, "src", "slash-commands", "builtin-registry.ts")).href);
  const commands = registry.BUILTIN_SLASH_COMMANDS_INTERNAL;
  if (!Array.isArray(commands)) throw new Error("no registry");
  answer({
    ok: true,
    commands: commands.map(command => ({
      name: String(command.name),
      aliases: Array.isArray(command.aliases) ? command.aliases.map(String) : [],
      handled: typeof command.handle === "function",
    })),
  });
  process.exit(0);
} catch {
  answer({ ok: false });
  process.exit(1);
}
