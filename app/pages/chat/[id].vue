<script setup lang="ts">
import { Chat } from '@ai-sdk/vue';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';

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
 * True from the moment a turn is sent until the stream settles.
 *
 * Set explicitly on every send/regenerate rather than inferred from
 * `chat.status`: the AI SDK flips to `streaming` as soon as the response
 * *headers* arrive, while the assistant placeholder message is installed a
 * tick later. A derived indicator therefore flickers off during that gap —
 * and that gap is exactly where a local model spends its whole prompt prefill.
 */
const pendingTurn = ref(false);

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
      if (updated && updated.label !== 'Untitled chat') {
        title.value = updated.label;
      }
    }
  },
  onError(error) {
    pendingTurn.value = false;
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
    pendingTurn.value = false;
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
  ) {
    return;
  }

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
    pendingTurn.value = true;
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
  pendingTurn.value = true;
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

  pendingTurn.value = true;
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
    pendingTurn.value = true;
    chat.regenerate();
  }
}

onMounted(() => {
  void bootstrapInitialAssistantResponse();
});

// Trigger one-shot LLM title generation whenever the chat has a (fallback)
// title and a model is ready. Covers both existing chats (title set on mount)
// and brand-new chats (title arrives via onData after the first turn).
watch(
  [title, modelSetupRequired],
  () => { void generateTitleOnce(); },
  { immediate: true },
);

/**
 * The wait before any content exists. For a local model this is prompt prefill:
 * the provider must read the entire system prompt and tool definitions before
 * the first token can be produced, and a new session has no cached prefix to
 * reuse. On a fast host it is imperceptible; locally it dominates a new chat.
 */
const awaitingFirstToken = computed(() => {
  if (!pendingTurn.value) return false;
  const messages = chat.messages as UIMessage[];
  return !messages.some(hasSubstantiveContent);
});

/**
 * Whether a message carries anything a user can actually see.
 *
 * Counting parts is not enough: the server writes its first chunks (the
 * assistant `start` and a `data-chat-title`) before the model has produced
 * anything, so the placeholder already holds an *empty* text part for the whole
 * wait. Only non-empty text/reasoning or a tool call means the model has begun.
 */
function hasSubstantiveContent(message: UIMessage): boolean {
  if (message.role !== 'assistant') return false;
  return (message.parts ?? []).some((part) => {
    if (part.type === 'text' || part.type === 'reasoning') return !!part.text?.trim();
    if (part.type.startsWith('tool-')) return true;
    // Side-channel parts (chat title, files, sources…) are not model output and
    // must not be mistaken for the answer having started.
    return false;
  });
}

/** Explain the wait only where it is actually long: a local model. */
const showFirstTokenNote = computed(() => awaitingFirstToken.value && isOllama.value);

/**
 * Sentinel id for the inline waiting row. It is styled like an assistant
 * message and rendered through the normal message flow so it inherits the list
 * spacing and alignment instead of floating below the whole list.
 */
const WAITING_ROW_ID = '__waiting-for-first-token__';

const renderMessages = computed<UIMessage[]>(() => {
  const messages = chat.messages as UIMessage[];
  if (!awaitingFirstToken.value) return messages;
  // `parts` must be non-empty: UChatMessages skips messages without parts, and
  // the placeholder part is never rendered because we own the #content slot.
  const row = { id: WAITING_ROW_ID, role: 'assistant', parts: [{ type: 'step-start' }] } as unknown as UIMessage;
  return [...messages, row];
});
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

            <template #content="{ message }">
              <!-- Inline waiting row: the local model is reading the whole prompt
                   before it can emit anything. Rendered as a message so it sits
                   flush with the rest of the conversation. -->
              <div v-if="message.id === WAITING_ROW_ID" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-pretty text-sm">
                <ChatIndicator />
                <UChatShimmer text="Waiting for first token…" class="text-sm" />
                <span v-if="showFirstTokenNote" class="w-full text-muted">
                  This may take a while for local models — depending on the hardware
                </span>
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
                :streaming="chat.status === 'streaming' && message.id === chat.messages[chat.messages.length - 1]?.id"
                :editing="editingMessageId === message.id"
                :vote="getVote(message.id)"
                @vote="(_message, isUpvoted) => vote(_message, isUpvoted)"
                @edit="startEdit"
                @regenerate="regenerateMessage"
              />
            </template>
          </UChatMessages>

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
