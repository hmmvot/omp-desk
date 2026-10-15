// The native addon Desk ships next to the extension bundle: koffi's prebuilt `koffi.node`, one file per VSIX
// (ADR-0076). Nothing is compiled. The x64 addon comes from the optional package `npm ci` installs on this
// machine; the other architecture's comes from the npm tarball the lockfile already pins, checked against the
// integrity recorded there. Either way the file must be the exact bytes pinned below and must be built for the
// architecture the VSIX targets, so a version bump is a reviewed change to the two digests.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const KOFFI_VERSION = "3.3.3";

/** PE `Machine` values: what the Windows loader compares with the process architecture. */
export const PE_MACHINE = { "win32-x64": 0x8664, "win32-arm64": 0xaa64 };

/** Per target: the optional npm package that carries the addon, where it sits in it, and its pinned SHA-256. */
export const KOFFI_PINS = {
  "win32-x64": {
    packageName: "@koromix/koffi-win32-x64",
    member: "win32_x64/koffi.node",
    sha256: "f7af4982457657d2e7ad46acb076614ed7122d6efbdbfbc75f21ec12681fa121",
  },
  "win32-arm64": {
    packageName: "@koromix/koffi-win32-arm64",
    member: "win32_arm64/koffi.node",
    sha256: "902e5e1a5d949b8ff361ffd5897f87863e3506747ac701875250988cf930bdf3",
  },
};

/** `win32-x64` or `win32-arm64` for the target a build is for: `OMP_DESK_TARGET`, else this machine. */
export function nativeTarget(env = process.env, arch = process.arch) {
  const requested = env.OMP_DESK_TARGET;
  if (requested !== undefined && requested !== "") {
    if (!(requested in KOFFI_PINS)) throw new Error(`OMP_DESK_TARGET must be win32-x64 or win32-arm64, got "${requested}"`);
    return requested;
  }
  const host = `win32-${arch}`;
  if (!(host in KOFFI_PINS)) throw new Error(`no koffi addon is pinned for ${host}`);
  return host;
}

/** The PE `Machine` field of a Windows image, or `null` when the bytes are not one. */
export function peMachine(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return null;
  const header = bytes.readUInt32LE(0x3c);
  if (header + 6 > bytes.length || bytes.readUInt32LE(header) !== 0x00004550) return null;
  return bytes.readUInt16LE(header + 4);
}

/** Throws unless `bytes` are the pinned addon for `target` and are built for it. */
export function assertKoffiAddon(bytes, target, label) {
  const pin = KOFFI_PINS[target];
  const machine = peMachine(bytes);
  if (machine !== PE_MACHINE[target]) {
    throw new Error(`${label} is not a ${target} image (PE machine ${machine === null ? "none" : `0x${machine.toString(16)}`}, expected 0x${PE_MACHINE[target].toString(16)})`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pin.sha256) {
    throw new Error(`${label} has sha256 ${sha256}, not the ${pin.sha256} pinned for koffi ${KOFFI_VERSION} ${target} in scripts/native-assets.mjs`);
  }
}

/** The bytes of the first member of a tar archive whose name ends with `suffix`, or `null`. */
export function extractTarMember(tar, suffix) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tar.toString("utf8", offset, offset + 100).replace(/\0[\s\S]*$/, "");
    if (name === "") return null;
    const size = Number.parseInt(tar.toString("ascii", offset + 124, offset + 136).replace(/\0[\s\S]*$/, "").trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) return null;
    if (name.endsWith(suffix)) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Download the locked tarball of `target`'s package and return the addon in it; refuses on an integrity mismatch before using a byte. */
async function fetchLockedAddon(root, target) {
  const pin = KOFFI_PINS[target];
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  const entry = lock.packages?.[`node_modules/${pin.packageName}`];
  if (entry?.version !== KOFFI_VERSION || typeof entry.resolved !== "string" || typeof entry.integrity !== "string") {
    throw new Error(`package-lock.json does not pin ${pin.packageName}@${KOFFI_VERSION} with a tarball and an integrity`);
  }
  const response = await fetch(entry.resolved);
  if (!response.ok) throw new Error(`could not download ${entry.resolved}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const dash = entry.integrity.indexOf("-");
  const algorithm = entry.integrity.slice(0, dash);
  if (createHash(algorithm).update(archive).digest("base64") !== entry.integrity.slice(dash + 1)) {
    throw new Error(`${entry.resolved} does not match the integrity recorded in package-lock.json`);
  }
  const member = extractTarMember(gunzipSync(archive), `/${pin.member}`);
  if (member === null) throw new Error(`${entry.resolved} holds no ${pin.member}`);
  return Buffer.from(member);
}

/**
 * Path of a verified `koffi.node` for `target`.
 *
 * The installed optional package is used when it is there. Otherwise the locked tarball is
 * downloaded once into `node_modules/.cache/omp-desk/` (a build input, not shipped from there).
 * `npm ci --omit=optional` leaves neither the package nor, without a network, a way to get the
 * file: that fails here, with the reason, and never falls back to a source build.
 */
export async function ensureKoffiAddon(target = nativeTarget(), root = process.cwd()) {
  const pin = KOFFI_PINS[target];
  const installed = path.join(root, "node_modules", pin.packageName, ...pin.member.split("/"));
  if (existsSync(installed)) {
    assertKoffiAddon(await fs.readFile(installed), target, installed);
    return installed;
  }
  const cached = path.join(root, "node_modules", ".cache", "omp-desk", `koffi-${KOFFI_VERSION}-${target}`, "koffi.node");
  if (existsSync(cached)) {
    try {
      assertKoffiAddon(await fs.readFile(cached), target, cached);
      return cached;
    } catch {
      // A damaged cache is fetched again below.
    }
  }
  const bytes = await fetchLockedAddon(root, target);
  assertKoffiAddon(bytes, target, `the koffi ${KOFFI_VERSION} ${target} addon from the locked tarball`);
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, bytes);
  return cached;
}
