<script setup lang="ts">
import {
  GENERIC_REASONING_EFFORTS,
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_WIRE_API,
  PROVIDER_DEFAULT_BASE_URLS,
  PROVIDER_TYPE_ITEMS,
  type ProviderSettings,
  type ProviderType,
  type ReasoningEffort,
} from '#shared/utils/models';

const {
  model,
  models,
  provider,
  reasoningEffort,
  copilotStatus,
  ollamaStatus,
  ollamaStatusLabel,
  isOllama,
  modelSetupRequired,
  modelSetupMessage,
  selectedModel,
  selectedModelContext,
  supportedReasoningEfforts,
  refreshModels,
  effectiveModel,
} = useModels();

/** The Responses wire is required for Ollama; other providers default to Chat Completions. */
function defaultWireApi(type: ProviderType): 'completions' | 'responses' {
  return type === 'ollama' ? OLLAMA_DEFAULT_WIRE_API : 'completions';
}

function normalize(p: ProviderSettings): ProviderSettings {
  const savedSelection = p.customReasoningEffortSelection
    ?? (GENERIC_REASONING_EFFORTS.includes(p.customReasoningEffort as ReasoningEffort)
      ? p.customReasoningEffort as ReasoningEffort
      : p.customReasoningEffort ? 'custom' : 'medium');

  const type = p.provider?.type ?? 'ollama';

  // Seed the per-kind URL memory with the currently selected kind. A saved
  // hand-typed URL (e.g. DeepSeek's Anthropic endpoint) is preserved for its
  // own kind and never leaks into another one.
  const baseUrlByType: Partial<Record<ProviderType, string>> = { ...p.baseUrlByType };
  const currentBaseUrl = p.provider?.baseUrl ?? '';
  if (currentBaseUrl) baseUrlByType[type] = currentBaseUrl;

  return {
    byok: p.byok ?? false,
    offline: p.offline ?? true,
    baseUrlByType,
    customModel: p.customModel ?? '',
    customReasoningEffortEnabled: p.customReasoningEffortEnabled ?? false,
    customReasoningEffortSelection: savedSelection,
    customReasoningEffort: savedSelection === 'custom' ? p.customReasoningEffort ?? '' : '',
    provider: {
      type,
      baseUrl: currentBaseUrl || PROVIDER_DEFAULT_BASE_URLS[type],
      apiKey: p.provider?.apiKey ?? '',
      bearerToken: p.provider?.bearerToken,
      // `undefined` means "not chosen": OpenAI then keeps the SDK default.
      wireApi: p.provider?.wireApi ?? (type === 'ollama' ? defaultWireApi(type) : undefined),
      headers: p.provider?.headers,
    },
  };
}

const open = ref(false);
const draft = ref<ProviderSettings>(normalize(provider.value));

function applyDefaultBaseUrl(p: ProviderSettings) {
  if (!p.provider) return;
  const type = p.provider.type ?? 'ollama';
  if (!p.provider.baseUrl) {
    p.provider.baseUrl = PROVIDER_DEFAULT_BASE_URLS[type];
  }
}

applyDefaultBaseUrl(draft.value);

onMounted(() => {
  void refreshModels();
});

watch(open, (v) => {
  if (v) {
    draft.value = normalize(JSON.parse(JSON.stringify(provider.value)));
    applyDefaultBaseUrl(draft.value);
  }
});

// Each provider kind keeps its own base URL. Switching kinds saves the URL for
// the kind being left and restores the one for the kind being entered, so a
// hand-typed endpoint is neither lost nor carried across (a DeepSeek Anthropic
// URL must never end up as Ollama's endpoint). Falling back to the kind's
// default happens only when that kind has no remembered URL yet.
function rememberBaseUrl(type: ProviderType | undefined, url: string | undefined) {
  if (!type || !draft.value.baseUrlByType) return;
  draft.value.baseUrlByType[type] = url ?? '';
}

watch(
  () => draft.value.provider?.baseUrl,
  (url) => rememberBaseUrl(draft.value.provider?.type, url),
);

watch(() => draft.value.provider?.type, (next, prev) => {
  if (!next || !draft.value.provider || next === prev) return;

  // Capture what the previous kind was actually using before overwriting it.
  if (prev) rememberBaseUrl(prev, draft.value.provider.baseUrl);
  const remembered = draft.value.baseUrlByType?.[next];
  draft.value.provider.baseUrl = remembered || PROVIDER_DEFAULT_BASE_URLS[next];

  // Ollama must use Responses; reset the wire only when it is not an explicit
  // OpenAI choice, so a hand-picked OpenAI wire survives type toggling.
  if (next === 'ollama' || !draft.value.provider.wireApi) {
    draft.value.provider.wireApi = defaultWireApi(next);
  }

  if (next === 'ollama') selectFirstOllamaModel();
});

/** True while the draft targets a local Ollama server. */
const draftIsOllama = computed(() => draft.value.provider?.type === 'ollama');

/**
 * Fall back to the first model the local server actually has, so the field
 * never keeps a model id that this server cannot serve.
 */
function selectFirstOllamaModel() {
  const first = ollamaStatus.value.models[0]?.name;
  if (!first) return;
  const current = draft.value.customModel ?? '';
  if (!current || !ollamaStatus.value.models.some((m) => m.name === current)) {
    draft.value.customModel = first;
  }
}

// The local model list arrives asynchronously; fill in a default once it does.
watch(ollamaStatus, () => {
  if (draft.value.provider?.type === 'ollama') selectFirstOllamaModel();
}, { deep: true });

/** Local models offered for the draft's Ollama server, as select items. */
const ollamaModelItems = computed(() => {
  const current = draft.value.customModel ?? '';
  const items = ollamaStatus.value.models.map((m) => ({
    label: m.name,
    value: m.name,
    description: [
      m.parameterSize,
      m.quantization,
      // The effective context window only exists once Ollama has loaded the
      // model, so an unloaded model states that rather than showing nothing or
      // the model file's (much larger, irrelevant) training maximum.
      m.contextLength ? `ctx ${formatContext(m.contextLength)}` : 'ctx set at load',
      m.capabilities.includes('tools') ? 'tools' : undefined,
    ].filter(Boolean).join(' · '),
  }));
  // While the server list is still unknown, keep the current id visible so the
  // field is never blank; it disappears once a listed model is chosen.
  if (current && !items.some((item) => item.value === current) && items.length === 0) {
    items.unshift({ label: current, value: current, description: 'custom id' });
  }
  return items;
});

function formatContext(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function save() {
  // Ollama cannot run without a model id: fall back to the first local one.
  if (draft.value.byok && draft.value.provider?.type === 'ollama') {
    const models_ = ollamaStatus.value.models;
    const current = draft.value.customModel ?? '';
    if (!current.trim() || !models_.some((m) => m.name === current)) {
      draft.value.customModel = models_[0]?.name ?? '';
    }
  }
  provider.value = draft.value;
  open.value = false;
}

function cancel() {
  open.value = false;
}

const selectItems = computed(() => {
  if (provider.value.byok) {
    const label = provider.value.customModel || 'Custom model';
    return [{ label, value: label, icon: 'i-lucide-key' }];
  }
  return models.value;
});

const selectModel = computed({
  get: () => provider.value.byok ? (selectItems.value[0]?.value ?? '') : model.value,
  set: (v: string) => { if (!provider.value.byok) model.value = v; },
});

const reasoningLabels: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Xhigh',
};

const reasoningItems = computed(() =>
  supportedReasoningEfforts.value.map((value) => ({
    label: reasoningLabels[value],
    value,
  })),
);

const allReasoningItems: Array<{ label: string; value: ReasoningEffort | 'custom' }> = [
  ...GENERIC_REASONING_EFFORTS.map((value) => ({
    label: reasoningLabels[value],
    value,
  })),
  { label: 'Custom', value: 'custom' },
];

const canConfigureReasoning = computed(() =>
  !provider.value.byok && reasoningItems.value.length > 0,
);
</script>

<template>
  <div class="flex items-center gap-1">
    <USelectMenu
      v-model="selectModel"
      :items="selectItems"
      :disabled="provider.byok || modelSetupRequired"
      size="sm"
      icon="i-lucide-sparkles"
      :variant="modelSetupRequired ? 'soft' : 'ghost'"
      value-key="value"
      class="data-[state=open]:bg-elevated"
      :content="{
        align: 'start',
        side: 'bottom',
        sideOffset: 6,
      }"
      :ui="{
        content: 'min-w-fit',
        leadingIcon: 'text-default',
        trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-200',
      }"
    >
      <template #item-label="{ item }">
        <span :title="item.description">{{ item.label }}</span>
      </template>
      <template #item-description="{ item }">
        <span v-show="false">{{ item.description }}</span>
      </template>
    </USelectMenu>

    <UButton
      icon="i-lucide-settings-2"
      size="sm"
      :color="modelSetupRequired ? 'warning' : 'neutral'"
      :variant="modelSetupRequired ? 'soft' : 'ghost'"
      :title="modelSetupRequired ? 'GitHub Copilot unavailable - open provider settings' : provider.byok ? 'BYOK enabled - click to edit' : 'Provider settings'"
      @click="open = true"
    />

    <UModal v-model:open="open" title="Provider Settings" :ui="{ content: 'max-w-lg' }">
      <template #body>
        <div class="space-y-4">
          <UAlert
            v-if="draftIsOllama && !ollamaStatus.available"
            color="warning"
            variant="soft"
            icon="i-lucide-circle-alert"
            title="No local Ollama server responded"
            :description="ollamaStatus.message || `Start Ollama and pull a model, then reopen this panel. Expected at ${OLLAMA_BASE_URL}`"
          />

          <UAlert
            v-if="!draft.byok && copilotStatus.state === 'unavailable'"
            color="warning"
            variant="soft"
            icon="i-lucide-circle-alert"
            title="GitHub Copilot is not available locally"
            :description="modelSetupMessage"
          />

          <div class="text-xs text-muted">
            Bring your own provider key — or run models fully offline with Ollama.
          </div>

          <UCheckbox v-model="draft.byok" label="Enable bring your own key (BYOK)" />

          <template v-if="draft.byok && draft.provider">
            <UFormField label="Provider Type" name="type">
              <USelect
                v-model="draft.provider.type"
                :items="PROVIDER_TYPE_ITEMS"
                value-key="value"
                size="sm"
                class="w-full"
              />
            </UFormField>

            <!-- Ollama is local and keyless, so the field is hidden for it. -->
            <UFormField
              v-if="!draftIsOllama"
              label="API Key"
              name="apiKey"
              required
            >
              <UInput
                v-model="draft.provider.apiKey"
                size="sm"
                class="w-full"
                type="password"
                placeholder=""
              />
            </UFormField>

            <UFormField
              v-if="draftIsOllama"
              label="Model"
              name="ollamaModel"
              required
            >
              <USelectMenu
                v-model="draft.customModel"
                :items="ollamaModelItems"
                value-key="value"
                size="sm"
                class="w-full"
                icon="i-lucide-cpu"
                placeholder="Select a local model"
                :content="{ align: 'start', side: 'bottom', sideOffset: 6 }"
                :ui="{ content: 'min-w-fit' }"
              >
                <template #item-label="{ item }">
                  <span class="font-mono text-xs" :title="item.description">{{ item.label }}</span>
                </template>
                <template #item-description="{ item }">
                  <span>{{ item.description }}</span>
                </template>
              </USelectMenu>
            </UFormField>

            <UFormField
              v-else
              label="Model ID"
              name="customModel"
              required
            >
              <UInput
                v-model="draft.customModel"
                size="sm"
                class="w-full"
                :placeholder="draft.provider.type === 'anthropic' ? 'e.g. claude-opus-4.6, deepseek-v4-pro' : 'e.g. gpt-4.1, glm-5.1'"
              />
            </UFormField>

            <UFormField label="Base URL" name="baseUrl" required>
              <UInput
                v-model="draft.provider.baseUrl"
                size="sm"
                class="w-full"
                :placeholder="`e.g. ${PROVIDER_DEFAULT_BASE_URLS[draft.provider.type ?? 'ollama']}` + (draft.provider.type === 'anthropic' ? ', https://api.deepseek.com/anthropic' : draft.provider.type === 'ollama' ? '' : ', https://open.bigmodel.cn/api/paas/v4/')"
              />
            </UFormField>

            <!-- Wire API is field-locked per provider kind: Anthropic speaks the
                 Messages API, Ollama must use Responses, so neither is shown. -->
            <UFormField
              v-if="draft.provider.type === 'openai'"
              label="Wire API"
              name="wireApi"
            >
              <USelect
                v-model="draft.provider.wireApi"
                :items="[
                  { label: 'completions (default)', value: 'completions' },
                  { label: 'responses', value: 'responses' },
                ]"
                value-key="value"
                size="sm"
                class="w-full"
              />
            </UFormField>

            <USeparator />

            <UCheckbox
              v-model="draft.customReasoningEffortEnabled"
              label="Extra config options"
            />
            <template v-if="draft.customReasoningEffortEnabled">
              <UFormField
                label="Thinking Effort"
                name="customReasoningEffortSelection"
              >
                <USelect
                  v-model="draft.customReasoningEffortSelection"
                  :items="allReasoningItems"
                  value-key="value"
                  size="sm"
                  class="w-full"
                />
              </UFormField>

              <UFormField
                v-if="draft.customReasoningEffortSelection === 'custom'"
                label="Thinking Effort (Custom)"
                name="customReasoningEffort"
              >
                <UInput
                  v-model="draft.customReasoningEffort"
                  size="sm"
                  class="w-full"
                  placeholder="e.g. max"
                />
              </UFormField>
            </template>

            <UCheckbox
              v-if="draftIsOllama"
              v-model="draft.offline"
              label="Offline mode"
              help="Runs the Copilot CLI with COPILOT_OFFLINE=true so only the local model provider is used."
            />
          </template>

          <template v-else>
            <USeparator />

            <div class="text-xs text-muted">
              Currently sending requests as: <span class="font-mono">{{ effectiveModel }}</span>
              <template v-if="canConfigureReasoning && reasoningEffort">
                <span> · </span><span class="font-mono">{{ reasoningEffort }}</span>
              </template>
            </div>

            <UFormField
              v-if="canConfigureReasoning"
              label="Thinking Effort"
              name="reasoningEffort"
              :help="selectedModel?.defaultReasoningEffort ? `Default: ${reasoningLabels[selectedModel.defaultReasoningEffort]}` : undefined"
            >
              <USelect
                v-model="reasoningEffort"
                :items="reasoningItems"
                value-key="value"
                size="sm"
                class="w-full"
              />
            </UFormField>
          </template>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full items-center justify-between gap-3">
          <!-- Local server status sits opposite the actions so it is visible
               while deciding whether saving this configuration is safe. -->
          <div v-if="draftIsOllama" class="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <template v-if="ollamaStatus.available">
              <span class="size-1.5 shrink-0 rounded-full bg-success" />
              <span class="truncate">{{ ollamaStatusLabel }}</span>
            </template>
            <template v-else>
              <UIcon name="i-lucide-circle-alert" class="size-3.5 shrink-0 text-warning" />
              <span class="truncate">{{ ollamaStatus.message || 'Ollama not reachable' }}</span>
            </template>
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              color="neutral"
              variant="ghost"
              title="Re-check the local Ollama server"
              @click="refreshModels()"
            />
          </div>
          <span v-else />

          <div class="flex shrink-0 gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              label="Cancel"
              @click="cancel"
            />
            <UButton color="primary" label="Save" @click="save" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
