/** A VS Code codicon, decorative: the words next to it carry the meaning. */
export function Icon({ name, spin = false }: { readonly name: string; readonly spin?: boolean }) {
  return <span aria-hidden="true" className={`codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}`} />;
}
