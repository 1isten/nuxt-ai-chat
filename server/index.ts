/**
 * Single entry point that re-exports every server-side symbol the
 * standalone h3 server needs. Bundle this file (via `pnpm server:generate`)
 * into `server/index.min.js` and ship that single file from your Electron app
 * instead of copying the entire `server/` + `shared/` source trees.
 *
 * Build command (see package.json `server:generate`):
 *   esbuild server/index.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=server/index.min.js
 *
 * Bundled  = your own source under `server/` + `shared/`.
 * External = anything in node_modules (drizzle, h3, @libsql/client,
 * @github/copilot-sdk, ai, zod, etc.) — those stay as `import` statements
 * resolved at runtime via the electron app's `node_modules`.
 */

// --- DB ---
export { createDb, setDb, db, schema, type DbHandle, type CreateDbOptions } from './utils/db';

// --- Copilot ---
export { configureCopilot, stopCopilotClient } from './utils/copilot';

// --- API handlers ---
export { default as chatsGet } from './api/chats.get';
export { default as chatsPost } from './api/chats.post';
export { default as chatsIdGet } from './api/chats/[id].get';
export { default as chatsIdPost } from './api/chats/[id].post';
export { default as chatsIdDelete } from './api/chats/[id].delete';
export { default as messagesDelete } from './api/chats/[id]/messages.delete';
export { default as titlePatch } from './api/chats/[id]/title.patch';
export { default as visibilityPatch } from './api/chats/[id]/visibility.patch';
export { default as votesGet } from './api/chats/[id]/votes.get';
export { default as votesPost } from './api/chats/[id]/votes.post';
export { default as modelsGet } from './api/models.get';
export { default as skillsGet } from './api/skills.get';
export { default as uploadPut } from './api/upload/[chatId].put';
export { default as uploadDelete } from './api/upload/[...pathname].delete';
export { default as proxyDeepSeekChatCompletionsPost } from './api/proxy/deepseek/v1/chat/completions.post';
