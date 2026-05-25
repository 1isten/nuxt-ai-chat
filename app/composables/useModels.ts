import { FALLBACK_MODELS, GENERIC_REASONING_EFFORTS, formatTokenLimit, modelToSelectItem, type ModelMetadata, type ProviderSettings, type ReasoningEffort } from '#shared/utils/models';

export interface CopilotStatus {
  state: 'checking' | 'available' | 'unavailable';
  message?: string;
}

export interface ModelOption {
  label: string;
  value: string;
  icon: string;
  description?: string;
  contextWindowTokens?: number;
  maxPromptTokens?: number;
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

interface ModelsResponse {
  models: ModelMetadata[];
  copilot?: {
    available: boolean;
    message?: string;
  };
}

/**
 * Manages the currently selected model + (optional) BYOK provider settings.
 *
 * Persisted to localStorage (works in SPA + Electron without cookies).
 *
 * - When `provider.byok` is false, `model` is one of the Copilot CLI's
 *   advertised models (loaded from /api/models). The `provider` field sent
 *   over the wire is `undefined`.
 * - When `provider.byok` is true, `provider.provider` and `provider.customModel`
 *   are sent to the server, which forwards them to Copilot SDK as ProviderConfig.
 */
export function useModels() {
  const model = useLocalStorage<string>('model', FALLBACK_MODELS[0]!.value);

  const provider = useLocalStorage<ProviderSettings>(
    'provider',
    { byok: false },
    { mergeDefaults: true },
  );
  const reasoningEffortByModel = useLocalStorage<Record<string, ReasoningEffort>>('reasoningEffortByModel', {});

  const dynamicModels = useState<ModelOption[]>('copilot-models', () => FALLBACK_MODELS);
  const copilotStatus = useState<CopilotStatus>('copilot-status', () => ({ state: 'checking' }));

  async function refreshModels() {
    copilotStatus.value = { state: 'checking' };
    try {
      const res = await $fetch<ModelsResponse>('/api/models');
      copilotStatus.value = res.copilot?.available === false
        ? { state: 'unavailable', message: res.copilot.message }
        : { state: 'available' };

      if (res.models?.length) {
        dynamicModels.value = res.models.map(modelToSelectItem);
        // Auto-select first if current value is no longer valid
        if (!dynamicModels.value.some((m) => m.value === model.value)) {
          model.value = dynamicModels.value[0]!.value;
        }
      }
    } catch (err) {
      // Keep fallback list silently
      console.warn('[useModels] failed to load /api/models', err);
      copilotStatus.value = {
        state: 'unavailable',
        message: 'Unable to check local GitHub Copilot. Confirm the API server is running, or enable BYOK provider settings.',
      };
    }
  }

  /** What the front-end sends as `model` in chat requests. */
  const effectiveModel = computed(() =>
    provider.value.byok && provider.value.customModel
      ? provider.value.customModel
      : model.value,
  );

  /** What the front-end sends as `provider` in chat requests, if any. */
  const effectiveProvider = computed(() =>
    provider.value.byok ? provider.value.provider : undefined,
  );

  const selectedModel = computed(() =>
    dynamicModels.value.find((item) => item.value === model.value),
  );

  const selectedModelContext = computed(() =>
    formatTokenLimit(selectedModel.value?.contextWindowTokens),
  );

  const supportedReasoningEfforts = computed(() => {
    if (provider.value.byok) return [];
    const selected = selectedModel.value;
    if (!selected?.supportsReasoningEffort) return [];
    return selected.supportedReasoningEfforts?.length
      ? selected.supportedReasoningEfforts
      : GENERIC_REASONING_EFFORTS;
  });

  const reasoningEffort = computed<ReasoningEffort | undefined>({
    get: () => {
      const supported = supportedReasoningEfforts.value;
      if (!supported.length) return undefined;
      const saved = reasoningEffortByModel.value[model.value];
      if (saved && supported.includes(saved)) return saved;
      const defaultEffort = selectedModel.value?.defaultReasoningEffort;
      if (defaultEffort && supported.includes(defaultEffort)) return defaultEffort;
      return supported[0];
    },
    set: (value) => {
      if (!value) return;
      reasoningEffortByModel.value = {
        ...reasoningEffortByModel.value,
        [model.value]: value,
      };
    },
  });

  const effectiveReasoningEffort = computed(() => {
    if (provider.value.byok) {
      if (!provider.value.customReasoningEffortEnabled) return undefined;
      const selection = provider.value.customReasoningEffortSelection ?? 'medium';
      if (selection === 'custom') {
        return provider.value.customReasoningEffort?.trim() || undefined;
      }
      return selection;
    }

    const effort = reasoningEffort.value;
    return effort && supportedReasoningEfforts.value.includes(effort) ? effort : undefined;
  });

  const modelSetupRequired = computed(() =>
    !provider.value.byok && copilotStatus.value.state === 'unavailable',
  );

  const modelSetupMessage = computed(() =>
    copilotStatus.value.message
    || 'Sign in to GitHub Copilot in your terminal, or enable BYOK provider settings.',
  );

  return {
    /** UI-bound currently-selected built-in model. */
    model,
    /** List shown in the menu. */
    models: dynamicModels,
    /** BYOK settings (cookie-backed). */
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
    effectiveProvider,
    effectiveReasoningEffort,
  };
}
