import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertKoffiAddon, ensureKoffiAddon, extractTarMember, KOFFI_PINS, nativeTarget, peMachine } from "./native-assets.mjs";

function image(machine) {
  const bytes = Buffer.alloc(0x100);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

function tarOf(members) {
  const blocks = [];
  for (const [name, content] of members) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(content.length.toString(8).padStart(11, "0"), 124, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("native assets", () => {
  it("reads the PE machine and rejects anything else", () => {
    assert.equal(peMachine(image(0x8664)), 0x8664);
    assert.equal(peMachine(Buffer.from("MZ")), null);
    assert.equal(peMachine(Buffer.alloc(0x100)), null);
  });

  it("finds a member of a tar archive by its name's end", () => {
    const tar = tarOf([["package/package.json", Buffer.from("{}")], ["package/win32_arm64/koffi.node", Buffer.from("addon bytes")]]);
    assert.equal(extractTarMember(tar, "/win32_arm64/koffi.node")?.toString(), "addon bytes");
    assert.equal(extractTarMember(tar, "/missing"), null);
  });

  it("refuses an addon for the wrong architecture and one that is not the pinned build", () => {
    assert.throws(() => assertKoffiAddon(image(0xaa64), "win32-x64", "fixture"), /not a win32-x64 image/);
    assert.throws(() => assertKoffiAddon(image(0x8664), "win32-x64", "fixture"), /not the .* pinned/);
  });

  it("picks the target from OMP_DESK_TARGET, else this machine, and refuses an unknown one", () => {
    assert.equal(nativeTarget({ OMP_DESK_TARGET: "win32-arm64" }, "x64"), "win32-arm64");
    assert.equal(nativeTarget({}, "x64"), "win32-x64");
    assert.throws(() => nativeTarget({ OMP_DESK_TARGET: "linux-x64" }), /must be win32-x64 or win32-arm64/);
    assert.throws(() => nativeTarget({}, "ia32"), /no koffi addon is pinned/);
  });

  it("returns the installed x64 addon only when it is exactly the pinned bytes", { skip: process.arch !== "x64" }, async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const file = await ensureKoffiAddon("win32-x64", root);
    assert.match(file.split(path.sep).join("/"), new RegExp(`${KOFFI_PINS["win32-x64"].packageName}/win32_x64/koffi.node$`));
  });
});
