<script setup lang="ts">
import type { ProviderSettings } from '#shared/utils/models';

const { model, models, provider, refreshModels, effectiveModel } = useModels();

function normalize(p: ProviderSettings): ProviderSettings {
  return {
    byok: p.byok ?? false,
    customModel: p.customModel ?? '',
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
</script>

<template>
  <div class="flex items-center gap-1">
    <USelectMenu
      v-model="selectModel"
      :items="selectItems"
      :disabled="provider.byok"
      size="sm"
      icon="i-lucide-sparkles"
      variant="ghost"
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
    />

    <UButton
      icon="i-lucide-settings-2"
      size="sm"
      color="neutral"
      variant="ghost"
      :title="provider.byok ? 'BYOK enabled \u2014 click to edit' : 'Provider settings'"
      @click="open = true"
    />

    <UModal v-model:open="open" title="Provider settings" :ui="{ content: 'max-w-lg' }">
      <template #body>
        <div class="space-y-4">
          <div class="text-xs text-muted">
            Bring your own Anthropic / OpenAI-compatible API key.
          </div>

          <UCheckbox v-model="draft.byok" label="Bring my own key (BYOK)" />

          <template v-if="draft.byok && draft.provider">
            <UFormField label="Provider type" name="type">
              <USelect
                v-model="draft.provider.type"
                :items="[
                  { label: 'Anthropic', value: 'anthropic' },
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

            <UFormField label="Model id" name="customModel" required>
              <UInput
                v-model="draft.customModel"
                size="sm"
                class="w-full"
                :placeholder="draft.provider.type === 'anthropic' ? 'e.g. claude-haiku-4.5' : 'e.g. gpt-4.1'"
              />
            </UFormField>

            <UFormField label="Base URL" name="baseUrl" required>
              <UInput
                v-model="draft.provider.baseUrl"
                size="sm"
                class="w-full"
                :placeholder="`e.g. ${DEFAULT_BASE_URLS[draft.provider.type ?? 'anthropic']}`"
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
          </template>

          <div v-else class="text-xs text-muted">
            Currently sending requests as: <span class="font-mono">{{ effectiveModel }}</span>
          </div>
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
