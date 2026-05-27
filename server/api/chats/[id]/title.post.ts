import { defineEventHandler, getValidatedRouterParams, readValidatedBody, createError } from 'h3';
import type { UIMessage } from 'ai';
import type { ProviderConfig } from '@github/copilot-sdk';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../../utils/db';
import { getUserSession } from '../../../utils/auth';
import { generateChatTitle } from '../../../utils/copilot';
import { createDefaultChatTitle, getFirstUserText } from '../../../utils/chatTitle';

const providerSchema = z.object({
  type: z.enum(['openai', 'anthropic']).optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  bearerToken: z.string().optional(),
  wireApi: z.enum(['completions', 'responses']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).optional();

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string() }).parse);
  const { model, provider } = await readValidatedBody(event, z.object({
    model: z.string().min(1),
    provider: providerSchema,
  }).parse);

  const userId = session.user?.id || session.id;
  const chat = await db().query.chats.findFirst({
    where: () => and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)),
    with: {
      messages: { orderBy: () => asc(schema.messages.createdAt) },
    },
  });

  if (!chat) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' });
  }

  const firstText = getFirstUserText(chat.messages as UIMessage[]);
  const fallbackTitle = createDefaultChatTitle(firstText);

  if (!firstText || (chat.title && chat.title !== fallbackTitle)) {
    return { title: chat.title || fallbackTitle, generated: false };
  }

  const abortController = new AbortController();
  event.node.res.on('close', () => abortController.abort());

  const generatedTitle = await generateChatTitle({
    chatId: id,
    model,
    provider: provider as ProviderConfig | undefined,
    prompt: firstText,
    signal: abortController.signal,
  });

  if (!generatedTitle) {
    return { title: chat.title || fallbackTitle, generated: false };
  }

  const current = await db().query.chats.findFirst({
    where: () => and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)),
  });

  if (!current || (current.title && current.title !== fallbackTitle)) {
    return { title: current?.title || fallbackTitle, generated: false };
  }

  const [updated] = await db().update(schema.chats)
    .set({ title: generatedTitle })
    .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)))
    .returning();

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' });
  }

  return { title: updated.title, generated: true };
});
