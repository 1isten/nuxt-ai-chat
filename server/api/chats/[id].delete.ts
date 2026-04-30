import { defineEventHandler, getValidatedRouterParams } from 'h3';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../utils/db';
import { getUserSession } from '../../utils/auth';
import { dropCopilotSession } from '../../utils/copilot';

// NOTE: Original implementation also deleted blob files for the chat.
// Blob/file-upload code paths have been disabled in this fork — see
// server/api/upload/* — so the blob cleanup has been removed.

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string() }).parse);

  const userId = session.user?.id || session.id;

  const result = await db().delete(schema.chats)
    .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)))
    .returning();

  // Best-effort drop of the Copilot session associated with this chat.
  await dropCopilotSession(id);

  return result;
});
