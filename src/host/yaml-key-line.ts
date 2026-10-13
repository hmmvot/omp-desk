/**
 * The 0-based line of a dotted setting's key in an OMP `config.yml`, for "open the file at this key".
 * OMP writes a setting as nested mappings (`lsp:` then `  diagnosticsOnWrite:`); a flat `lsp.diagnosticsOnWrite:`
 * key, which a hand edit may leave, is accepted too. Returns null when the key is absent, in which case the
 * caller opens the file at the top. Block mappings only: flow mappings (`{a: 1}`) are not searched.
 */
export function locateYamlKey(text: string, segments: readonly string[]): number | null {
  const lines = text.split(/\r?\n/);
  const keyAt = (line: string): { indent: number; key: string } | null => {
    const match = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s#:][^:#]*?))\s*:(?:\s|$)/.exec(line);
    return match === null ? null : { indent: match[1]!.length, key: match[2] ?? match[3] ?? match[4]! };
  };
  const nested = (): number | null => {
    let start = 0; let end = lines.length; let indent = -1;
    let found = -1;
    for (const segment of segments) {
      found = -1;
      let childIndent = -1;
      for (let index = start; index < end; index++) {
        const at = keyAt(lines[index]!);
        if (at === null) continue;
        if (childIndent === -1) childIndent = at.indent;
        if (at.indent <= indent) { end = index; break; }
        if (at.indent === childIndent && at.key === segment) { found = index; break; }
      }
      if (found === -1) return null;
      indent = keyAt(lines[found]!)!.indent;
      start = found + 1;
      end = lines.length;
    }
    return found;
  };
  const flat = (): number | null => {
    const dotted = segments.join(".");
    const index = lines.findIndex(line => keyAt(line)?.key === dotted);
    return index === -1 ? null : index;
  };
  return nested() ?? flat();
}
