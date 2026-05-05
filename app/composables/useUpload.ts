/**
 * Stub replacing `useUpload` from `@nuxthub/core`.
 *
 * Blob uploads are currently disabled (the server returns 501). We keep the
 * call signature so existing call-sites compile; calling the returned
 * function rejects with a clear error.
 */
export function useUpload(_endpoint: string, _options?: {
  method?: string;
  headers?: Record<string, string>;
}) {
  return async function upload(_input: FormData | File | File[] | HTMLInputElement): Promise<unknown> {
    throw new Error('File uploads are disabled in this build.');
  };
}
