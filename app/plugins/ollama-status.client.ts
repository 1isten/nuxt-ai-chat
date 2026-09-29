/**
 * Keeps the Ollama status fresh without the user having to press anything.
 *
 * The status was only ever refreshed on mount, when the configured endpoint
 * changed, or by hand. Ollama is routinely started *after* the app — or the
 * laptop joins the LAN later — and until now that left the composer disabled
 * behind a stale "Ollama is not running at …" line that only a manual re-check
 * could clear.
 *
 * While the configured endpoint is unreachable this re-probes on a backoff, and
 * immediately when the tab becomes visible again (the moment a user comes back
 * after starting the server). It stops as soon as a probe succeeds, so a
 * working server is never polled, and it polls nothing at all in the background.
 *
 * A plugin owns the loop rather than a component watcher: components mount and
 * unmount, and the recovery has to outlive them.
 */
export default defineNuxtPlugin(() => {
  const { isOllama, ollamaStatus, ollamaProbing, refreshModels } = useModels();

  /** First re-check is quick (the server may still be starting), then back off. */
  const RETRY_MIN_MS = 5_000;
  const RETRY_MAX_MS = 60_000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = RETRY_MIN_MS;

  function stop() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { void attempt(); }, delay);
  }

  /** True while the app is showing "no Ollama" for a local provider. */
  function needsRecovery() {
    return isOllama.value && !ollamaStatus.value.available;
  }

  async function attempt() {
    timer = null;
    // Either there is nothing to recover, or the tab is in the background.
    // The visibility handler below restarts the loop in the latter case.
    if (!needsRecovery() || document.hidden) return;

    if (ollamaProbing.value) {
      // A probe is already in flight (manual refresh, endpoint change); retry on
      // the same delay rather than stacking a second request behind it.
      schedule();
      return;
    }

    await refreshModels();

    if (needsRecovery()) {
      delay = Math.min(delay * 2, RETRY_MAX_MS);
      schedule();
    } else {
      delay = RETRY_MIN_MS;
    }
  }

  watch([isOllama, () => ollamaStatus.value.available], ([ollama, available]) => {
    // Every new "unreachable" state starts over from the fast retry, so a fresh
    // failure (e.g. right after switching endpoints) is not stuck on a delay
    // that a previous, longer outage had backed off to.
    delay = RETRY_MIN_MS;
    if (!ollama || available) {
      stop();
      return;
    }
    schedule();
  }, { immediate: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !needsRecovery()) return;
    delay = RETRY_MIN_MS;
    stop();
    void attempt();
  });
});
