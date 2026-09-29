<script setup lang="ts">
import { Chat } from '@ai-sdk/vue';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import { DEFAULT_CHAT_TITLE } from '#shared/utils/chatTitle';

const route = useRoute();
const toast = useToast();
const { effectiveModel, effectiveProvider, effectiveReasoningEffort, isOffline, isOllama, ollamaStatus, modelSetupRequired, modelSetupMessage, modelUnavailable, modelUnavailableMessage } = useModels();
const { enabledSkills } = useSkills();
const { csrf, headerName } = useCsrf();

const { data } = await useFetch(`/api/chats/${route.params.id}`, {
  key: `chat-${route.params.id}`,
  cache: 'no-store',
});

type ChatData = NonNullable<typeof data.value>;

const isOwner = computed(() => data.value?.isOwner ?? false);
const visibility = ref<'public' | 'private'>(data.value?.visibility ?? 'private');
const title = ref<string | null>(data.value?.title ?? null);
const titleGenerationAttempted = ref(false);

watch(() => data.value?.title, (next) => {
  title.value = next ?? null;
});

const {
  dropzoneRef,
  dragging,
  open,
  files,
  uploading,
  uploadedFiles,
  removeFile,
  clearFiles,
} = useFileUploadWithStatus(route.params.id as string);

const { data: votes } = await useLazyFetch(`/api/chats/${route.params.id}/votes`, {
  immediate: isOwner.value,
});

const input = ref('');

/**
 * The turn currently being waited on, or `null` when nothing is in flight.
 *
 * This is an id rather than a boolean so that stale callbacks cannot settle a
 * *newer* turn: a waiter only clears the state while the id it belongs to is
 * still the live one. A plain flag is exactly what made the wait row vanish on
 * every prompt after the first — the placeholder `sendMessage` pushes carries no
 * output yet, but an earlier turn's answer does, and any check that looks at the
 * whole conversation sees that answer and settles the new wait on the spot.
 *
 * The wait is driven from here rather than from `UChatMessages`' own indicator
 * on purpose: that requires the last assistant message to have *zero parts*,
 * while the server writes a `data-chat-title` part about a second into the turn,
 * so it goes false for the rest of the prefill (measured: the indicator was
 * absent for a whole 51s wait, until the answer began).
 */
const activeTurn = ref<number | null>(null);
let turnCounter = 0;

/** Arm the wait for a fresh turn. Called on every send path and on `submitted`/`streaming`. */
function beginTurn() {
  turnCounter += 1;
  activeTurn.value = turnCounter;
}

/** Settle the wait — but only if `turn` (default: the current turn) is still the live one. */
function endTurn(turn = activeTurn.value) {
  if (turn === activeTurn.value) activeTurn.value = null;
}

const chat = new Chat({
  id: data.value?.id,
  messages: data.value?.messages,
  transport: new DefaultChatTransport({
    api: useApiUrl(`/api/chats/${data.value?.id}`),
    headers: { [headerName]: csrf },
    body: () => ({
      model: effectiveModel.value,
      provider: effectiveProvider.value,
      offline: isOffline.value,
      reasoningEffort: effectiveReasoningEffort.value,
      enabledSkills: enabledSkills.value,
    }),
  }),
  onData: async (dataPart) => {
    if (dataPart.type === 'data-chat-title') {
      await refreshNuxtData('chats');
      const chatsCache = useNuxtData<{ id: string; label: string }[]>('chats');
      const updated = chatsCache.data.value?.find((c) => c.id === data.value!.id);
      if (updated && updated.label !== DEFAULT_CHAT_TITLE) {
        title.value = updated.label;
      }
    }
  },
  onError(error) {
    endTurn();
    let message = error.message;
    if (typeof message === 'string' && message[0] === '{') {
      try {
        message = JSON.parse(message).message || message;
      } catch {
        // keep original message on malformed JSON
      }
    }

    toast.add({
      description: message,
      icon: 'i-lucide-alert-circle',
      color: 'error',
      duration: 0,
    });
  },
  onFinish: ({ messages }) => {
    updateCachedMessages(messages);
    void refreshNuxtData(`chat-${data.value!.id}`);
  },
});

function updateCachedMessages(messages: UIMessage[]) {
  const chatCache = useNuxtData<ChatData>(`chat-${data.value!.id}`);
  if (chatCache.data.value) {
    chatCache.data.value = { ...chatCache.data.value, messages: messages as ChatData['messages'] };
  }
}

function updateChatData(nextData: ChatData) {
  const chatCache = useNuxtData<ChatData>(`chat-${nextData.id}`);
  chatCache.data.value = nextData;
  chat.messages = nextData.messages;
  title.value = nextData.title ?? null;
  visibility.value = nextData.visibility;
}

function updateCachedTitle(nextTitle: string) {
  title.value = nextTitle;

  const chatsCache = useNuxtData<{ id: string; label: string }[]>('chats');
  if (chatsCache.data.value) {
    chatsCache.data.value = chatsCache.data.value.map((chat) =>
      chat.id === data.value!.id ? { ...chat, label: nextTitle } : chat,
    );
  }

  const chatCache = useNuxtData<ChatData>(`chat-${data.value!.id}`);
  if (chatCache.data.value) {
    chatCache.data.value = { ...chatCache.data.value, title: nextTitle, messages: chat.messages as ChatData['messages'] };
  }
}

async function generateTitleOnce() {
  if (
    titleGenerationAttempted.value
    || !isOwner.value
    || !data.value?.id
    || !title.value
    || modelSetupRequired.value
    // Without this the request goes out with an empty `model` (BYOK selected
    // but nothing configured yet) and the server rejects it with a 400. The
    // watcher below re-runs this once a model becomes usable.
    || modelUnavailable.value
  ) {
    return;
  }

  // Set only once the request is really being made: setting it while bailing
  // out above would permanently suppress title generation for this page.
  titleGenerationAttempted.value = true;

  try {
    const result = await $fetch<{ title: string | null; generated: boolean }>(`/api/chats/${data.value.id}/title`, {
      method: 'POST',
      headers: { [headerName]: csrf },
      body: {
        model: effectiveModel.value,
        provider: effectiveProvider.value,
        offline: isOffline.value,
      },
    });

    if (result.generated && result.title) {
      updateCachedTitle(result.title);
    }
  } catch (error) {
    console.warn('[chat-title] failed to generate title', error);
  }
}

async function handleSubmit(e: Event) {
  e.preventDefault();
  // Sending without a resolved model id would reach the provider as an opaque
  // "Resource not found" 404, so block it at the source.
  if (input.value.trim() && !uploading.value && !modelSetupRequired.value && !modelUnavailable.value) {
    beginTurn();
    chat.sendMessage({
      text: input.value,
      files: uploadedFiles.value.length > 0 ? uploadedFiles.value : undefined,
    });
    input.value = '';
    clearFiles();
  }
}

const editingMessageId = ref<string | null>(null);

function startEdit(message: UIMessage) {
  if (editingMessageId.value) return;

  editingMessageId.value = message.id;
}

async function saveEdit(message: UIMessage, text: string) {
  try {
    await $fetch(`/api/chats/${data.value!.id}/messages`, {
      method: 'DELETE',
      headers: { [headerName]: csrf },
      body: { messageId: message.id, type: 'edit' },
    });
  } catch {
    toast.add({ description: 'Failed to save edit.', icon: 'i-lucide-alert-circle', color: 'error' });
    return;
  }

  editingMessageId.value = null;
  beginTurn();
  chat.sendMessage({ text, messageId: message.id });
}

async function regenerateMessage(message: UIMessage) {
  try {
    await $fetch(`/api/chats/${data.value!.id}/messages`, {
      method: 'DELETE',
      headers: { [headerName]: csrf },
      body: { messageId: message.id, type: 'regenerate' },
    });
  } catch {
    toast.add({ description: 'Failed to regenerate.', icon: 'i-lucide-alert-circle', color: 'error' });
    return;
  }

  beginTurn();
  chat.regenerate({ messageId: message.id });
}

function getVote(messageId: string) {
  const vote = votes.value?.find((v) => v.messageId === messageId);
  if (!vote) return null;
  return !!vote.isUpvoted;
}

async function vote(message: UIMessage, isUpvoted: boolean) {
  const snapshot = (votes.value ?? []).map((v) => ({ ...v }));
  const toggling = getVote(message.id) === isUpvoted;
  const next = toggling ? null : isUpvoted;

  votes.value = next === null
    ? (votes.value ?? []).filter((v) => v.messageId !== message.id)
    : [
        ...(votes.value ?? []).filter((v) => v.messageId !== message.id),
        { chatId: data.value!.id, messageId: message.id, isUpvoted: next },
      ];

  try {
    await $fetch(`/api/chats/${data.value!.id}/votes`, {
      method: 'POST',
      headers: { [headerName]: csrf },
      body: next === null ? { messageId: message.id } : { messageId: message.id, isUpvoted: next },
    });
  } catch {
    votes.value = snapshot;
    toast.add({
      description: 'Failed to save vote',
      icon: 'i-lucide-alert-circle',
      color: 'error',
    });
  }
}

async function bootstrapInitialAssistantResponse() {
  if (!isOwner.value || data.value?.messages.length !== 1) return;

  const latest = await $fetch<ChatData>(`/api/chats/${data.value.id}`, {
    cache: 'no-store',
  });
  updateChatData(latest);

  if (latest.messages.length === 1) {
    beginTurn();
    chat.regenerate();
  }
}

onMounted(() => {
  void bootstrapInitialAssistantResponse();
});

// Trigger one-shot LLM title generation whenever the chat has a (fallback)
// title and a model is ready. Covers both existing chats (title set on mount)
// and brand-new chats (title arrives via onData after the first turn).
// `modelUnavailable` is watched too: a chat opened before a model is chosen
// (or before Ollama's model list has loaded) must still get its title once one
// becomes usable.
watch(
  [title, modelSetupRequired, modelUnavailable],
  () => { void generateTitleOnce(); },
  { immediate: true },
);

/**
 * Whether the model has produced anything the user can actually see.
 *
 * This has to mean *visible*, not merely "a part exists". The server writes
 * several parts before the model has emitted a character:
 *   - the assistant `start` chunk installs an empty **text** part;
 *   - a `data-chat-title` chunk can arrive on the first turn (title generated);
 *   - the reasoning stream opens with an empty **reasoning** part, which is the
 *     one that caused the "empty window": treating it as output ended the wait
 *     while there was still nothing on screen, and the first real reasoning
 *     text only arrived tens of seconds later.
 * So text/reasoning only count once they carry a non-empty string, and tool
 * calls (which are real model output) count unconditionally.
 */
function hasModelOutput(message: UIMessage): boolean {
  if (message.role !== 'assistant') return false;
  const parts = (message.parts ?? []) as Array<{ type?: string; text?: string }>;
  return parts.some((part) => {
    if (part.type === 'text' || part.type === 'reasoning') {
      return typeof part.text === 'string' && part.text.trim().length > 0;
    }
    if (part.type?.startsWith('tool-')) return true;
    return false;
  });
}

/**
 * Whether this is the app's very first reply in this chat.
 *
 * That is the only turn whose wait includes loading the model and prefilling
 * the whole system prompt and tool schema set from cold, so it is the only one
 * that gets the "first token" wording and the hardware note. Later turns still
 * have to think before emitting anything, but they must not claim to be waiting
 * for a "first token".
 */
const isFirstTurn = computed(() => {
  const messages = chat.messages as UIMessage[];
  return messages.filter((message) => message.role === 'user').length === 1
    && !messages.some(hasModelOutput);
});

const showFirstTokenNote = computed(() => isFirstTurn.value && isOllama.value);

/**
 * Id of the synthetic row that carries the wait UI.
 *
 * A dedicated message is required rather than reusing the in-flight assistant
 * one: `UChatMessages` renders the list through its default slot, whose first
 * guard is `v-if="message.parts?.length"`, so a message with no parts is skipped
 * entirely. The server writes a `data-chat-title` part into the assistant
 * placeholder on the first turn only, which is why the wait used to appear for
 * the first prompt and never again — on every later turn the placeholder has
 * zero parts, nothing is rendered for it, and a wait row inside its `#content`
 * slot has no element to live in. Measured: the array held
 * `assistant:<id>:0` while the DOM rendered only the three older messages.
 */
const WAITING_ROW_ID = '__waiting-for-model__';

/**
 * What `UChatMessages` should render: the real messages, plus a synthetic
 * assistant row when the current turn has not produced a renderable message
 * yet. Once the placeholder gains its first part it renders normally and the
 * synthetic row drops out on its own, so there is no swap and no layout jump.
 */
const renderMessages = computed<UIMessage[]>(() => {
  const messages = chat.messages as UIMessage[];
  if (activeTurn.value === null) return messages;

  const inFlight = messages.findLast((message) => message.role === 'assistant');
  if (!inFlight || (inFlight.parts ?? []).length > 0) return messages;

  const row = { id: WAITING_ROW_ID, role: 'assistant', parts: [{ type: 'step-start' }] } as unknown as UIMessage;
  return [...messages, row];
});

/**
 * End the wait as soon as the model produces anything.
 *
 * `deep` + watching the ref itself (rather than reading nested properties in
 * the getter) is load-bearing: the getter form stops firing after a completed
 * turn, because the AI SDK's `onFinish` bookkeeping replaces the message objects
 * and the old per-property dependency goes stale.
 *
 * What is checked matters just as much: the *in-flight* message, not the whole
 * conversation. `sendMessage` pushes the new assistant placeholder after the
 * previous turn's answer is already in the array, so checking every message
 * finds that answer and settles the new wait the instant it starts.
 */
watch(
  () => chat.messages,
  (messages) => {
    const inFlight = (messages as UIMessage[]).findLast((message) => message.role === 'assistant');
    if (inFlight && hasModelOutput(inFlight)) endTurn();
  },
  { deep: true },
);

// A new turn begins as soon as the client starts one, whichever arrives first;
// `beginTurn` is also called directly on every send path.
watch(
  () => chat.status,
  (status) => {
    if (status === 'submitted' || status === 'streaming') beginTurn();
    else if (status === 'ready') endTurn();
  },
);
</script>

<template>
  <UDashboardPanel
    v-if="data?.id"
    id="chat"
    class="relative min-h-0"
    :ui="{ body: 'p-0 sm:p-0 overscroll-none' }"
  >
    <template #header>
      <Navbar>
        <template #title>
          <ChatTitle
            :chat-id="data!.id"
            :title="title"
            :is-owner="isOwner"
            @update:title="title = $event"
          />
        </template>

        <ChatVisibility
          v-if="isOwner"
          :chat-id="data!.id"
          :visibility="visibility"
          @update:visibility="visibility = $event"
        />
      </Navbar>
    </template>

    <template #body>
      <!-- File-upload feature disabled: ref="dropzoneRef" intentionally omitted to prevent drop handlers. -->
      <div class="flex flex-1">
        <DragDropOverlay v-if="false && isOwner" :show="dragging" />

        <UContainer class="flex-1 flex flex-col gap-4 sm:gap-6">
          <!--
            `self-start` keeps `UChatMessages` at its natural height instead of
            letting its `flex-1` root stretch to the bottom of the pane. Without
            it the message list claims the whole viewport regardless of how much
            is in it.
          -->
          <div class="flex w-full flex-col gap-4 self-start sm:gap-6">
            <UChatMessages
              should-auto-scroll
              :messages="renderMessages"
              :status="chat.status"
              :spacing-offset="isOwner ? 160 : 0"
              class="pt-(--ui-header-height) pb-4 sm:pb-6"
            >
              <template #files="{ message, parts }">
                <ChatFilePreview
                  v-for="(part, index) in parts"
                  :key="`${message.id}-${index}`"
                  :name="getFileName(part.url)"
                  :type="part.mediaType"
                  :preview-url="part.url"
                  size="3xl"
                />
              </template>

              <!--
                Claim the `indicator` slot with something hidden, so the component's
                built-in three-dot default never renders.

                It cannot be used to *show* the wait: it only renders while
                `showIndicator()` is true, which requires the last assistant message
                to have *zero parts*. The server writes a `data-chat-title` part
                about a second into the turn, so the condition is already false for
                the rest of the prefill (measured: `data-slot="indicator"` absent
                for a whole 51s wait). The same is true of the empty-slot
                suppression people assume works — there was simply nothing there.
              -->
              <template #indicator>
                <span hidden aria-hidden="true" />
              </template>

              <!--
                The wait row matches *two* kinds of message on purpose, and both
                are needed:
                  - the synthetic `WAITING_ROW_ID`, which is the only thing on
                    screen while the placeholder still has zero parts (every turn
                    after the first, since `UChatMessages` skips partless
                    messages);
                  - the real in-flight assistant message, which is what renders on
                    the first turn, because the server writes a `data-chat-title`
                    part into it about a second in. Matching only the synthetic row
                    removed the first prompt's indicator entirely: `isFirstTurn`
                    is false for a row that carries no output, so it took the
                    three-dot branch and the "first token" wording never appeared.

                Behaving as one element matters too: the two never show at the same
                time (the synthetic row is only added while the placeholder has no
                parts), so the wording switches from "first token" to dots exactly
                where it used to.
              -->
              <template #content="{ message }">
                <div
                  v-if="activeTurn !== null && (message.id === WAITING_ROW_ID || (message.role === 'assistant' && !hasModelOutput(message)))"
                  class="text-pretty text-sm"
                >
                  <!-- First reply: name the wait, because it includes loading the
                       model and prefilling everything from cold. -->
                  <div v-if="isFirstTurn" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <ChatIndicator />
                    <UChatShimmer text="Waiting for first token…" class="text-sm" />
                    <span v-if="showFirstTokenNote" class="w-full text-muted">
                      This may take a while for local models — depending on the hardware
                    </span>
                  </div>

                  <!-- Later replies: the same three-dot affordance the component
                       renders by default. -->
                  <div v-else class="flex h-6 items-center gap-1 py-3" aria-label="Waiting for the model">
                    <span class="size-2 rounded-full bg-elevated motion-safe:animate-[bounce_1s_infinite]" />
                    <span class="size-2 rounded-full bg-elevated motion-safe:animate-[bounce_1s_0.15s_infinite]" />
                    <span class="size-2 rounded-full bg-elevated motion-safe:animate-[bounce_1s_0.3s_infinite]" />
                  </div>
                </div>

                <ChatMessageContent
                  v-else
                  :message="message"
                  :editing="isOwner && editingMessageId === message.id"
                  @save="saveEdit"
                  @cancel-edit="editingMessageId = null"
                />
              </template>

              <template v-if="isOwner" #actions="{ message }">
                <ChatMessageActions
                  :message="message"
                  :streaming="chat.status === 'streaming'"
                  :editing="editingMessageId === message.id"
                  :vote="getVote(message.id)"
                  @vote="(_message, isUpvoted) => vote(_message, isUpvoted)"
                  @edit="startEdit"
                  @regenerate="regenerateMessage"
                />
              </template>
            </UChatMessages>
          </div>

          <UAlert
            v-if="isOwner && modelUnavailable"
            color="warning"
            variant="soft"
            icon="i-lucide-circle-alert"
            :title="isOllama ? (ollamaStatus.available ? 'No local model available' : 'Ollama server not reachable') : 'GitHub Copilot is not available locally'"
            :description="modelUnavailableMessage"
          />

          <UChatPrompt
            v-if="isOwner"
            v-model="input"
            :error="chat.error"
            :disabled="uploading || modelUnavailable"
            variant="subtle"
            class="sticky bottom-0 [view-transition-name:chat-prompt] rounded-b-none z-10"
            :ui="{ base: 'px-1.5' }"
            :placeholder="'Describe what to build'"
            @submit="handleSubmit"
          >
            <template v-if="files.length > 0" #header>
              <ChatFiles :files="files" @remove="removeFile" />
            </template>

            <template #footer>
              <div class="flex items-center gap-1">
                <ChatFileUploadButton v-if="false" :open="open" />
                <SkillSelect />
                <ModelSelect />
              </div>

              <UChatPromptSubmit
                :color="input ? 'primary' : 'neutral'"
                :variant="input ? 'solid' : 'ghost'"
                icon="i-lucide-send-horizontal"
                submitted-color="neutral"
                submitted-variant="soft"
                submitted-icon="i-mdi-square-rounded"
                streaming-color="error"
                streaming-variant="soft"
                streaming-icon="i-mdi-square-rounded"
                size="sm"
                :status="chat.status"
                :disabled="uploading || modelUnavailable"
                @stop="chat.stop()"
                @reload="chat.regenerate()"
              />
            </template>
          </UChatPrompt>
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>

  <UContainer v-else class="flex-1 flex flex-col gap-4 sm:gap-6">
    <UError :error="{ statusMessage: 'Chat not found', statusCode: 404 }" class="min-h-full" />
  </UContainer>
</template>
