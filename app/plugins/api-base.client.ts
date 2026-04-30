import { ofetch } from 'ofetch';

/**
 * Prefixes all `$fetch` / `useFetch` requests to `/api/*` with
 * `runtimeConfig.public.apiBase` when it's set. This lets the static SPA
 * built via `nuxt generate` talk to a separately-hosted h3 server (e.g.
 * inside Electron) without changing every call site.
 *
 * Native `fetch` calls (e.g. those issued by the AI SDK transport) are not
 * affected — those URLs are pre-prefixed at the call site using
 * `useApiUrl()`.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const apiBase = (useRuntimeConfig().public.apiBase as string | undefined) || '';
  if (!apiBase) return;

  const originalFetch = globalThis.$fetch;

  const wrapped = ofetch.create({
    baseURL: apiBase,
    // ofetch only applies baseURL when the request URL is relative; absolute
    // URLs are passed through unchanged, which is what we want.
    credentials: 'include',
  });

  // Replace both globalThis.$fetch (used by useFetch) and the Nuxt app's
  // $fetch reference. We keep raw access to the original under $rawFetch
  // in case someone needs it.
  nuxtApp.provide('rawFetch', originalFetch);
  // @ts-expect-error overwrite global
  globalThis.$fetch = wrapped;
});
