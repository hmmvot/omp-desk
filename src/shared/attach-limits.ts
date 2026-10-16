/**
 * The numbers an attachment is bounded by, in one place for the composer, the protocol and the host
 * (docs/designs/2026-10-16-chat-document-attachments.md, decisions 9 and 14).
 */

/** The most characters one Chat message carries: the composer's send bound, and so the bound of one attached file. */
export const MAX_MESSAGE_CHARS = 200_000;

/**
 * Bytes of the largest file that can still hold `MAX_MESSAGE_CHARS` characters: 3 bytes per UTF-8 character plus a
 * 3-byte byte order mark. A file above it is refused unread.
 */
export const MAX_DOCUMENT_BYTES = MAX_MESSAGE_CHARS * 3 + 3;

/**
 * A structural guard on the length of every attachment array in the wire grammar and on the number of file blocks in one
 * message (decision 9). It bounds the parsers and the broker's 16 MiB stdin line; it is not a limit the user is told
 * about before it is reached.
 */
export const MAX_ATTACH_ITEMS = 1000;
