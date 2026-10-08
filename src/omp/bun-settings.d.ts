// These modules exist in the Bun worker only; the VS Code extension host never loads them.
declare module "bun" {
  export const YAML: { parse(content: string): unknown; stringify(value: unknown, replacer?: null, indent?: number): string };
}
declare module "bun:sqlite" {
  interface SettingsDatabase {
    close(): void;
    serialize(): Uint8Array;
    query(sql: string): { get(): unknown; all(): Record<string, string | number>[] };
  }
  export class Database implements SettingsDatabase {
    constructor(path: string, options?: { readonly: boolean });
    static deserialize(bytes: Uint8Array): Database;
    close(): void;
    serialize(): Uint8Array;
    query(sql: string): { get(): unknown; all(): Record<string, string | number>[] };
  }
}
