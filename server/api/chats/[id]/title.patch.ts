import { defineEventHandler, getValidatedRouterParams, readValidatedBody, createError } from 'h3';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../../utils/db';
import { getUserSession } from '../../../utils/auth';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string() }).parse);
  const { title } = await readValidatedBody(event, z.object({
    title: z.string().trim().min(1).max(100),
  }).parse);

  const userId = session.user?.id || session.id;
  const chat = await db().query.chats.findFirst({
    where: () => and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)),
  });
  if (!chat) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' });
  }

  const [updated] = await db().update(schema.chats)
    .set({ title })
    .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)))
    .returning();

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' });
  }

  return updated;
});
