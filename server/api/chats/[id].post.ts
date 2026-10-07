import { defineEventHandler, getValidatedRouterParams, readValidatedBody, createError } from 'h3';
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../utils/db';
import { getUserSession } from '../../utils/auth';
import { isOllamaProvider, runChatTurn, dropCopilotSession } from '../../utils/copilot';
import { providerSchema } from '../../utils/providerSchema';
import { createDefaultChatTitle, getFirstUserText } from '../../utils/chatTitle';
import { SKILLS_DIR, discoverSkills, renderSkillsSystemMessage, selectEagerSkills } from '../../utils/skills';
import { HIDDEN_SKILL_NAMES } from '../../../shared/utils/skills';
import type { ReasoningEffortValue } from '../../../shared/utils/models';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);

  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string() }).parse);

  const { model, messages, provider, reasoningEffort, enabledSkills, offline } = await readValidatedBody(event, z.object({
    // An empty model id reaches the provider as a bare 404 ("Resource not found
    // on provider"), which explains nothing to the user. Reject it explicitly:
    // this is exactly what an unconfigured local setup would otherwise send.
    model: z.string().trim().min(1, 'A model must be selected before sending a message.'),
    messages: z.array(z.custom<UIMessage>()),
    provider: providerSchema,
    reasoningEffort: z.string().trim().min(1).optional(),
    /** Skill names the user has explicitly enabled. */
    enabledSkills: z.array(z.string()).optional(),
    /** Run the Copilot CLI with `COPILOT_OFFLINE=true` (local providers only). */
    offline: z.boolean().optional(),
  }).parse);

  const userId = session.user?.id || session.id;
  const chat = await db().query.chats.findFirst({
    where: () => and(eq(schema.chats.id, id), eq(schema.chats.userId, userId)),
    with: { messages: true },
  });
  if (!chat) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' });
  }

  if (messages.length < chat.messages.length) {
    return createNoopChatResponse();
  }

  // Auto-title: first user message text, shortened near 30 chars without cutting words.
  let newTitle: string | undefined;
  if (!chat.title) {
    newTitle = createDefaultChatTitle(getFirstUserText(messages));
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
  event.node.res.on('close', () => abortController.abort());

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
  // Local (Ollama) models inline only small skills: every injected character is
  // re-paid on each turn, and this machine's prefill is slow enough that a ~30k
  // token skill produces no answer at all. Large skills stay reachable through the
  // CLI's own <available_skills> catalogue + skill tool, which loads them on demand.
  //
  // Cloud models inline NOTHING and use the catalogue for everything. A catalogue entry
  // arrives with the CLI's "invoke the matching Skill before answering" instruction, which
  // is what actually makes a model follow a skill; a ~130 KB block of inlined skill text
  // carries no such framing and a strong model ignores it. Measured: a cloud session with
  // both bridge skills enabled never noticed `/api/frontend/extract` and hand-rolled an
  // extraction pipeline instead, although the same text sat in its system message.
  const eagerSkills = isOllamaProvider(provider) ? selectEagerSkills(enabledFull, true) : [];
  const skillsSystemFragment = renderSkillsSystemMessage(eagerSkills);
  // A skill is either inlined above OR reachable through the CLI's on-demand
  // catalogue — never both. Advertising an inlined skill as a tool to invoke hands
  // the model two contradictory orders ("this skill is already ACTIVE" vs the
  // catalogue's "invoke the Skill tool BEFORE generating any other response"), and a
  // small model resolves the conflict by announcing the invocation and stopping
  // without running anything. The catalogue is only needed when something was
  // deliberately left out of the system message.
  const needsSkillCatalogue = eagerSkills.length < enabledFull.length;

  return await runChatTurn({
    chatId: id,
    model,
    provider,
    offline,
    reasoningEffort: reasoningEffort as ReasoningEffortValue | undefined,
    prompt: promptText,
    attachments,
    forceNew: truncated,
    signal: abortController.signal,
    chatTitle: newTitle,
    skillDirectories: needsSkillCatalogue ? [SKILLS_DIR] : undefined,
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

function createNoopChatResponse(): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({ execute() {} }),
  });
}
