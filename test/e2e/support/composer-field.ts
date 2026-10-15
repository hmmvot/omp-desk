/**
 * How the Chat composer's field presents itself to the accessibility tree. The one place the e2e specs and tools learn
 * its role: `Desk.composer` builds its locator from these, and the MCP probe matches its snapshot lines with them.
 */
export const COMPOSER_ROLE = "textbox";
export const COMPOSER_NAME = "Message OMP";
