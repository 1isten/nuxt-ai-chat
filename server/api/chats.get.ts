import { defineEventHandler } from 'h3';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../utils/db';
import { getUserSession } from '../utils/auth';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);

  return await db().query.chats.findMany({
    where: () => eq(schema.chats.userId, session.user?.id || session.id),
    orderBy: () => desc(schema.chats.createdAt),
  });
});
