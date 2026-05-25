import { defineEventHandler, getValidatedRouterParams, readValidatedBody, createError } from 'h3';
import type { UIMessage } from 'ai';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../utils/db';
import { getUserSession } from '../../utils/auth';
import { runChatTurn, dropCopilotSession } from '../../utils/copilot';
import { SKILLS_DIR, discoverSkills, renderSkillsSystemMessage } from '../../utils/skills';
import { HIDDEN_SKILL_NAMES } from '../../../shared/utils/skills';
import type { ProviderConfig } from '@github/copilot-sdk';
import type { ReasoningEffortValue } from '../../../shared/utils/models';

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

  const { model, messages, provider, reasoningEffort, enabledSkills } = await readValidatedBody(event, z.object({
    model: z.string().min(1),
    messages: z.array(z.custom<UIMessage>()),
    provider: providerSchema,
    reasoningEffort: z.string().trim().min(1).optional(),
    /** Skill names the user has explicitly enabled. */
    enabledSkills: z.array(z.string()).optional(),
  }).parse);

  const userId = session.user?.id || session.id;
  const chat = await db().query.chats.findFirst({
    where: () => and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)),
    with: { messages: true },
  });
  if (!chat) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' });
  }

  // Auto-title: first 30 chars of the first user message text
  let newTitle: string | undefined;
  if (!chat.title) {
    const first = messages.find((m) => m.role === 'user');
    const firstText = first?.parts?.find((p): p is { type: 'text'; text: string } =>
      typeof p === 'object' && p !== null && 'type' in p && (p as { type: string }).type === 'text',
    )?.text ?? 'Untitled chat';
    newTitle = firstText.slice(0, 30).trim() || 'Untitled chat';
    await db().update(schema.chats).set({ title: newTitle }).where(eq(schema.chats.id, id));
  }

  // Upsert the latest user message (matches original behavior).
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'user' && messages.length > 1) {
    await db().insert(schema.messages).values({
      id: lastMessage.id,
      chatId: id,
      role: 'user',
      parts: lastMessage.parts,
    }).onConflictDoUpdate({ target: schema.messages.id, set: { parts: lastMessage.parts } });
  }

  // Detect edit/regenerate: client truncated the message list relative to DB.
  const persistedCount = chat.messages.length + ((lastMessage?.role === 'user' && messages.length > 1) ? 1 : 0);
  const truncated = messages.length < persistedCount;

  // Extract latest user prompt + attachments.
  const parts = (lastMessage?.parts ?? []) as Array<Record<string, unknown>>;

  const promptText = parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim() || ' ';

  const attachments = parts
    .filter((p): p is { type: 'file'; mediaType?: string; url: string } =>
      p.type === 'file' && typeof p.url === 'string',
    )
    .map((p) => ({ type: 'file' as const, mediaType: p.mediaType, url: p.url }));

  if (truncated) await dropCopilotSession(id);

  const abortController = new AbortController();
  event.node.req.on('close', () => abortController.abort());

  // Resolve which skills to disable: every discovered skill that is NOT
  // explicitly enabled by the user, plus all hidden (dev-only) skills.
  const allSkills = await discoverSkills();
  const enabledSet = new Set(enabledSkills ?? []);
  const enabledFull = allSkills.filter(
    (s) => !HIDDEN_SKILL_NAMES.includes(s.name) && enabledSet.has(s.name),
  );
  const disabledSkills = [
    ...allSkills
      .map((s) => s.name)
      .filter((name) => !HIDDEN_SKILL_NAMES.includes(name) && !enabledSet.has(name)),
    ...HIDDEN_SKILL_NAMES,
  ];
  const skillsSystemFragment = renderSkillsSystemMessage(enabledFull);

  return await runChatTurn({
    chatId: id,
    model,
    provider: provider as ProviderConfig | undefined,
    reasoningEffort: reasoningEffort as ReasoningEffortValue | undefined,
    prompt: promptText,
    attachments,
    forceNew: truncated,
    signal: abortController.signal,
    chatTitle: newTitle,
    skillDirectories: allSkills.length ? [SKILLS_DIR] : undefined,
    disabledSkills,
    skillsSystemFragment,
    onFinish: async (assistantMessages) => {
      if (!assistantMessages.length) return;
      await db().insert(schema.messages).values(assistantMessages.map((m) => ({
        id: m.id,
        chatId: id,
        role: m.role as 'user' | 'assistant',
        parts: m.parts,
      }))).onConflictDoNothing();
    },
  });
});
