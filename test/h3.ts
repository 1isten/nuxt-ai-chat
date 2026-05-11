import { createServer } from 'node:http';
import { createApp, createRouter, defineEventHandler, handleCors, toNodeListener } from 'h3';

import {
  createDb,
  setDb,
  configureCopilot,
  stopCopilotClient,
  chatsGet,
  chatsPost,
  chatsIdGet,
  chatsIdPost,
  chatsIdDelete,
  messagesDelete,
  titlePatch,
  visibilityPatch,
  votesGet,
  votesPost,
  modelsGet,
  skillsGet,
  uploadPut,
  uploadDelete,
} from '../server';

async function main() {
  const dbPath = process.env.DB_PATH || './.data/ai.db';
  const port = Number(process.env.PORT || 18040);

  // 1) DB
  const db = await createDb({ path: dbPath });
  setDb(db);
  console.log(`[server] db ready at ${dbPath}`);

  // 2) Copilot
  configureCopilot({
    workingDirectory: process.cwd(),
    gitHubToken: process.env.COPILOT_GITHUB_TOKEN,
  });

  // 3) Routes
  const app = createApp();

  const allowList = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allowAny = allowList.includes('*');

  app.use(defineEventHandler((event) => {
    handleCors(event, {
      origin: (origin) => {
        if (allowAny) return true;
        if (!origin) return false;
        return allowList.some((allowed) => origin.startsWith(allowed));
      },
      // Explicit list — browsers reject `*` for methods/headers when
      // `Access-Control-Allow-Credentials: true`.
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token', 'csrf-token'],
      credentials: true,
      preflight: { statusCode: 204 },
    });
  }));

  const router = createRouter();

  // router.get('/health', defineEventHandler(() => ({ ok: true })));
  router.get('/api/chats', chatsGet);
  router.post('/api/chats', chatsPost);
  router.get('/api/chats/:id', chatsIdGet);
  router.post('/api/chats/:id', chatsIdPost);
  router.delete('/api/chats/:id', chatsIdDelete);
  router.delete('/api/chats/:id/messages', messagesDelete);
  router.patch('/api/chats/:id/title', titlePatch);
  router.patch('/api/chats/:id/visibility', visibilityPatch);
  router.get('/api/chats/:id/votes', votesGet);
  router.post('/api/chats/:id/votes', votesPost);
  router.get('/api/models', modelsGet);
  router.get('/api/skills', skillsGet);
  router.put('/api/upload/:chatId', uploadPut);
  router.delete('/api/upload/**:pathname', uploadDelete);

  app.use(router);

  // 4) Test server
  const server = createServer(toNodeListener(app));
  server.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      console.log(`[server] ${sig} received, shutting down…`);
      server.close();
      void stopCopilotClient().finally(() => process.exit(0));
    });
  }
}

void main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
