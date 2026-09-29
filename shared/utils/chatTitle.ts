/**
 * The title shown/used while a chat has no real title yet.
 *
 * This lives in `shared/` because both sides need the exact same string:
 * the server stores and compares it (`server/utils/chatTitle.ts`,
 * `server/api/chats/[id]/title.post.ts`), and the client renders and
 * compares it while deciding whether a chat is still untitled
 * (`ChatTitle.vue`, `layouts/default.vue`, `pages/chat/[id].vue`).
 *
 * A chat is "untitled" when its `title` column is `null`/empty **or** when it
 * equals this fallback. Comparing against this constant rather than repeating
 * the literal keeps those checks honest — the literal used to be duplicated in
 * five places, where a single typo would silently turn a real title into an
 * "untitled" one (or vice versa).
 */
export const DEFAULT_CHAT_TITLE = 'Untitled chat';
