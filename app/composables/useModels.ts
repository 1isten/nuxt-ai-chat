import { FALLBACK_MODELS, modelToSelectItem, type ProviderSettings } from '#shared/utils/models';

export interface ModelOption {
  label: string;
  value: string;
  icon: string;
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

  const dynamicModels = useState<ModelOption[]>('copilot-models', () => FALLBACK_MODELS);

  async function refreshModels() {
    try {
      const res = await $fetch<{ models: { id: string; name: string }[] }>('/api/models');
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

  return {
    /** UI-bound currently-selected built-in model. */
    model,
    /** List shown in the menu. */
    models: dynamicModels,
    /** BYOK settings (cookie-backed). */
    provider,
    refreshModels,
    effectiveModel,
    effectiveProvider,
  };
}
