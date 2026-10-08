import { spawn } from "node:child_process";
import { SettingsRefusal } from "./omp-settings-core.ts";
import { isRecord as record } from "../guards.ts";
import type { ConfigRecord } from "./omp-settings-core";

/** No native diagnostic output is logged or returned: it can contain provider credentials. */
export function runSettingsWorker(input: {
  bunPath: string; helperPath: string; packageRoot: string; cwd: string; profile: string;
  request: ConfigRecord; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
}): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const child = spawn(input.bunPath, [input.helperPath], {
      cwd: input.cwd, env: { ...process.env, ...input.env, OMP_PROFILE: input.profile },
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false,
    });
    let output = "";
    let interruption: string | null = null;
    const stop = (reason: string): void => { interruption ??= reason; child.kill(); };
    const abort = (): void => stop("The settings operation was interrupted. Reload before retrying; explicit native operations may already have recorded usage or refreshed credentials.");
    const timeout = setTimeout(() => stop("The settings operation timed out. Reload before retrying; explicit native operations may have had partial effects."), input.request.action === "generate" ? 300_000 : 120_000);
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 8 * 1024 * 1024) stop("The installed OMP returned too much settings data.");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => { interruption ??= "The Bun settings worker could not be started."; });
    child.on("close", () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      if (interruption !== null) { reject(new SettingsRefusal(interruption)); return; }
      const line = output.split(/\r?\n/).findLast(line => line.startsWith("OMP_DESK_SETTINGS "));
      let receipt: unknown;
      try { receipt = JSON.parse(line?.slice("OMP_DESK_SETTINGS ".length) ?? ""); }
      catch { reject(new SettingsRefusal("The installed OMP did not return a settings result.")); return; }
      if (!record(receipt) || typeof receipt.ok !== "boolean") { reject(new SettingsRefusal("The settings worker returned an invalid result.")); return; }
      if (receipt.ok) resolve(receipt.result);
      else reject(new SettingsRefusal(typeof receipt.error === "string" ? receipt.error : "The settings operation failed."));
    });
    if (input.signal?.aborted) abort();
    else child.stdin.end(JSON.stringify({ ...input.request, packageRoot: input.packageRoot, cwd: input.cwd, profile: input.profile }));
  return promise;
}
