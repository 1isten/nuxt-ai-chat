import {
  FALLBACK_MODELS,
  GENERIC_REASONING_EFFORTS,
  formatTokenLimit,
  modelToSelectItem,
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_WIRE_API,
  type ModelMetadata,
  type ProviderSettings,
  type ReasoningEffort,
} from '#shared/utils/models';

export interface CopilotStatus {
  state: 'checking' | 'available' | 'unavailable';
  message?: string;
}

export interface OllamaModel {
  name: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
  contextLength?: number;
  capabilities: string[];
}

export interface OllamaStatus {
  /** Whether the local Ollama server answered. */
  available: boolean;
  version?: string;
  models: OllamaModel[];
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
  ollama?: {
    available: boolean;
    version?: string;
    models?: OllamaModel[];
    message?: string;
  };
}

/**
 * Settings used before the user changes anything: BYOK on, Ollama selected,
 * offline mode on. Ollama is the zero-configuration local default, so a fresh
 * install can chat without a GitHub Copilot login.
 */
export function createDefaultProviderSettings(): ProviderSettings {
  return {
    byok: true,
    offline: true,
    customModel: '',
    customReasoningEffortEnabled: false,
    customReasoningEffortSelection: 'medium',
    customReasoningEffort: '',
    provider: {
      type: 'ollama',
      baseUrl: OLLAMA_BASE_URL,
      apiKey: '',
      wireApi: OLLAMA_DEFAULT_WIRE_API,
    },
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
    createDefaultProviderSettings(),
    { mergeDefaults: true },
  );
  const reasoningEffortByModel = useLocalStorage<Record<string, ReasoningEffort>>('reasoningEffortByModel', {});

  const dynamicModels = useState<ModelOption[]>('copilot-models', () => FALLBACK_MODELS);
  const copilotStatus = useState<CopilotStatus>('copilot-status', () => ({ state: 'checking' }));
  const ollamaStatus = useState<OllamaStatus>('ollama-status', () => ({ available: false, models: [] }));

  /** True when requests are routed to a local Ollama server. */
  const isOllama = computed(() =>
    !!provider.value.byok && provider.value.provider?.type === 'ollama',
  );

  /** True when the CLI is configured to never contact GitHub. */
  const isOffline = computed(() => isOllama.value && provider.value.offline !== false);

  async function refreshModels() {
    copilotStatus.value = { state: 'checking' };
    try {
      // Tell the server when this client is local-only, so it does not ask the
      // (deliberately unauthenticated) Copilot CLI for the hosted catalogue.
      const wantsOffline = !!provider.value.byok
        && provider.value.provider?.type === 'ollama'
        && provider.value.offline !== false;
      const res = await $fetch<ModelsResponse>('/api/models', {
        query: wantsOffline ? { offline: 'true' } : undefined,
      });

      ollamaStatus.value = {
        available: res.ollama?.available ?? false,
        version: res.ollama?.version,
        models: res.ollama?.models ?? [],
        message: res.ollama?.message,
      };

      // In offline mode the server deliberately does not ask Copilot, so its
      // "unavailable" answer says nothing about the user's setup — do not turn
      // it into a warning state.
      if (!wantsOffline) {
        copilotStatus.value = res.copilot?.available === false
          ? { state: 'unavailable', message: res.copilot.message }
          : { state: 'available' };
      }

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

  /**
   * The model id actually sent with a request.
   *
   * Ollama has no notion of a "default model" server-side: an empty id is
   * answered with a bare 404 ("Resource not found on provider"), which surfaces
   * to the user as an opaque failure. So when the user has enabled Ollama but
   * never picked a model, fall back to the first local one.
   */
  const effectiveModel = computed(() => {
    if (!provider.value.byok) return model.value;
    const custom = provider.value.customModel?.trim();
    if (custom) return custom;
    if (provider.value.provider?.type === 'ollama') {
      return ollamaStatus.value.models[0]?.name ?? '';
    }
    return '';
  });

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

  /**
   * Only a non-BYOK (Copilot-hosted) request needs a working Copilot login.
   * Ollama/BYOK requests never depend on it.
   */
  const modelSetupRequired = computed(() =>
    !provider.value.byok && copilotStatus.value.state === 'unavailable',
  );

  const modelSetupMessage = computed(() =>
    copilotStatus.value.message
    || 'Sign in to GitHub Copilot in your terminal, or enable BYOK provider settings.',
  );

  /** Short human-readable status for the local Ollama server. */
  const ollamaStatusLabel = computed(() => {
    if (ollamaStatus.value.available) {
      const parts = [`Ollama ${ollamaStatus.value.version ?? ''}`.trim()];
      const count = ollamaStatus.value.models.length;
      parts.push(`${count} model${count === 1 ? '' : 's'}`);
      return parts.join(' · ');
    }
    return ollamaStatus.value.message || 'Ollama not reachable';
  });

  /**
   * Persist the auto-selected local model so the settings panel and the request
   * body agree on what is in use, instead of only diverging until the user
   * happens to open the panel.
   */
  function adoptFirstOllamaModel() {
    if (!provider.value.byok) return;
    if (provider.value.provider?.type !== 'ollama') return;
    if (provider.value.customModel?.trim()) return;
    const first = ollamaStatus.value.models[0]?.name;
    if (!first) return;
    provider.value = { ...provider.value, customModel: first };
  }

  watch(ollamaStatus, adoptFirstOllamaModel, { deep: true, immediate: true });

  /**
   * True when there is no usable model id, so a request must not be sent.
   *
   * An unreachable Ollama server also counts, even if a model name is still
   * cached locally: sending it would only produce the provider's opaque
   * "Resource not found" error.
   */
  const modelUnavailable = computed(() => {
    if (isOllama.value && !ollamaStatus.value.available) return true;
    return !effectiveModel.value;
  });

  /** Why no model is usable, for display next to the composer. */
  const modelUnavailableMessage = computed(() => {
    if (!modelUnavailable.value) return '';
    if (isOllama.value) {
      return ollamaStatus.value.available
        ? 'No local model is available. Pull a model with Ollama, then pick one in Provider Settings.'
        : ollamaStatus.value.message
          || 'Start Ollama and pull a model, then pick one in Provider Settings.';
    }
    if (provider.value.byok) {
      return 'No model is configured. Enter a model id in Provider Settings.';
    }
    return modelSetupMessage.value;
  });

  return {
    /** UI-bound currently-selected built-in model. */
    model,
    /** List shown in the menu. */
    models: dynamicModels,
    /** BYOK settings (cookie-backed). */
    provider,
    reasoningEffort,
    copilotStatus,
    ollamaStatus,
    ollamaStatusLabel,
    isOllama,
    isOffline,
    modelUnavailable,
    modelUnavailableMessage,
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
