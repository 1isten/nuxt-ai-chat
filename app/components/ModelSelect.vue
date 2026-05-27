<script setup lang="ts">
import { GENERIC_REASONING_EFFORTS, type ProviderSettings, type ReasoningEffort } from '#shared/utils/models';

const {
  model,
  models,
  provider,
  reasoningEffort,
  copilotStatus,
  modelSetupRequired,
  modelSetupMessage,
  selectedModel,
  selectedModelContext,
  supportedReasoningEfforts,
  refreshModels,
  effectiveModel,
} = useModels();

function normalize(p: ProviderSettings): ProviderSettings {
  const savedSelection = p.customReasoningEffortSelection
    ?? (GENERIC_REASONING_EFFORTS.includes(p.customReasoningEffort as ReasoningEffort)
      ? p.customReasoningEffort as ReasoningEffort
      : p.customReasoningEffort ? 'custom' : 'medium');

  return {
    byok: p.byok ?? false,
    customModel: p.customModel ?? '',
    customReasoningEffortEnabled: p.customReasoningEffortEnabled ?? false,
    customReasoningEffortSelection: savedSelection,
    customReasoningEffort: savedSelection === 'custom' ? p.customReasoningEffort ?? '' : '',
    provider: {
      type: p.provider?.type ?? 'anthropic',
      baseUrl: p.provider?.baseUrl ?? '',
      apiKey: p.provider?.apiKey ?? '',
      bearerToken: p.provider?.bearerToken,
      wireApi: p.provider?.wireApi ?? 'completions',
      headers: p.provider?.headers,
    },
  };
}

const open = ref(false);
const draft = ref<ProviderSettings>(normalize(provider.value));

const DEFAULT_BASE_URLS: Record<'openai' | 'anthropic', string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

function applyDefaultBaseUrl(p: ProviderSettings) {
  if (!p.provider) return;
  const type = p.provider.type ?? 'anthropic';
  if (!p.provider.baseUrl) {
    p.provider.baseUrl = DEFAULT_BASE_URLS[type];
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

// Auto-prefill `baseUrl` when the user picks a provider type and no URL is set,
// or when the current URL still matches the previous type's default.
watch(() => draft.value.provider?.type, (next, prev) => {
  if (!next || !draft.value.provider) return;
  const current = draft.value.provider.baseUrl ?? '';
  const prevDefault = prev ? DEFAULT_BASE_URLS[prev] : '';
  if (!current || current === prevDefault) {
    draft.value.provider.baseUrl = DEFAULT_BASE_URLS[next];
  }
});

function save() {
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
            v-if="!draft.byok && copilotStatus.state === 'unavailable'"
            color="warning"
            variant="soft"
            icon="i-lucide-circle-alert"
            title="GitHub Copilot is not available locally"
            :description="modelSetupMessage"
          />

          <div class="text-xs text-muted">
            Bring your own Anthropic / OpenAI-compatible API key.
          </div>

          <UCheckbox v-model="draft.byok" label="Enable bring your own key (BYOK)" />

          <template v-if="draft.byok && draft.provider">
            <UFormField label="Provider Type" name="type">
              <USelect
                v-model="draft.provider.type"
                :items="[
                  { label: 'Anthropic / DeepSeek', value: 'anthropic' },
                  { label: 'OpenAI / OpenAI-compatible', value: 'openai' },
                ]"
                value-key="value"
                size="sm"
                class="w-full"
              />
            </UFormField>

            <UFormField label="API Key" name="apiKey" required>
              <UInput
                v-model="draft.provider.apiKey"
                size="sm"
                class="w-full"
                type="password"
                placeholder=""
              />
            </UFormField>

            <UFormField label="Model ID" name="customModel" required>
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
                :placeholder="`e.g. ${DEFAULT_BASE_URLS[draft.provider.type ?? 'anthropic']}` + (draft.provider.type === 'anthropic' ? ', https://api.deepseek.com/anthropic' : ', https://open.bigmodel.cn/api/paas/v4/')"
              />
            </UFormField>

            <UFormField v-if="draft.provider.type !== 'anthropic'" label="Wire API" name="wireApi">
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
          </template>

          <template v-else>
            <USeparator />

            <div class="text-xs text-muted">
              Currently sending requests as: <span class="font-mono">{{ effectiveModel }}</span>
              <template v-if="canConfigureReasoning && reasoningEffort"><span> · </span><span class="font-mono">{{ reasoningEffort }}</span></template>
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
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            label="Cancel"
            @click="cancel"
          />
          <UButton color="primary" label="Save" @click="save" />
        </div>
      </template>
    </UModal>
  </div>
</template>
