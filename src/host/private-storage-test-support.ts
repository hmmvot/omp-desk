import os from "node:os";

/** Synthetic identities only: fixtures never depend on the running account's SID. */
export const TEST_CURRENT_SID = "S-1-5-21-100-200-300-1001";
const FOREIGN_SID = "S-1-5-21-100-200-300-1002";
const WELL_KNOWN_SIDS: Record<string, string> = {
	"NT AUTHORITY\\SYSTEM": "S-1-5-18",
	"AUTHORITY\\SYSTEM": "S-1-5-18",
	"NT AUTHORITY\\СИСТЕМА": "S-1-5-18",
	"BUILTIN\\Administrators": "S-1-5-32-544",
	"BUILTIN\\Администраторы": "S-1-5-32-544",
	"NT SERVICE\\TrustedInstaller": "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
	"CREATOR OWNER": "S-1-3-0",
	"СОЗДАТЕЛЬ-ВЛАДЕЛЕЦ": "S-1-3-0",
	"OWNER RIGHTS": "S-1-3-4",
	"SELF": "S-1-5-10",
	"BUILTIN\\Users": "S-1-5-32-545",
	"BUILTIN\\Пользователи": "S-1-5-32-545",
	"Everyone": "S-1-1-0",
	"Все": "S-1-1-0",
	"NT AUTHORITY\\Authenticated Users": "S-1-5-11",
};

export function fixturePrincipal(name: string): string {
	if (/^S-1-/.test(name)) return name;
	const current = name === "WORKSTATION\\dev" || name === os.userInfo().username ||
		name === `${os.hostname()}\\${os.userInfo().username}` || name === "КОМПЬЮТЕР\\Иван";
	return `${WELL_KNOWN_SIDS[name] ?? (current ? TEST_CURRENT_SID : FOREIGN_SID)} (${name})`;
}

const RIGHTS: Record<string, number> = {
	F: 0x1f01ff, M: 0x1301bf, RX: 0x1200a9, R: 0x120089,
	W: 0x116, AD: 4, GW: 0x40000000, D: 0x10000, DC: 0x40,
	WDAC: 0x40000, WO: 0x80000, GA: 0x10000000, XY: 0x200,
};
const FLAGS: Record<string, true> = { OI: true, CI: true, I: true, IO: true, DENY: true, NP: true };

/** Simulate .NET SID readback from existing English and localized ACE fixtures. */
export function fixtureAcl(entries: readonly string[]): string {
	return JSON.stringify(entries.flatMap(entry => {
		const separator = entry.indexOf(":(");
		if (separator < 0) throw new Error("Malformed ACE fixture");
		const name = entry.slice(0, separator);
		const groups = [...entry.slice(separator + 1).matchAll(/\(([^()]*)\)/g)].map(match => match[1]!);
		// Mandatory labels are SACL entries, not returned by GetAccessRules.
		if (groups.some(group => group === "NW" || group === "NR" || group === "NX")) return [];
		const rights = groups.filter(group => !Object.hasOwn(FLAGS, group));
		const permissions = rights.reduce((mask, right) => {
			if (!Object.hasOwn(RIGHTS, right)) throw new Error(`Unknown ACE fixture right ${right}`);
			return mask | RIGHTS[right]!;
		}, 0);
		return [{ principal: fixturePrincipal(name), permissions, denied: groups.includes("DENY") }];
	}));
}
