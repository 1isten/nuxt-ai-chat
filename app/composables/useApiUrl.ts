/**
 * Returns a fully-qualified URL for an /api path, honouring
 * `runtimeConfig.public.apiBase`. Use for callers that bypass `$fetch`
 * (e.g. the AI SDK's `DefaultChatTransport` which calls native `fetch`).
 */
export function useApiUrl(path: string): string {
  const apiBase = (useRuntimeConfig().public.apiBase as string | undefined) || '';
  if (!apiBase) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return apiBase.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
}
