// Blob delete disabled — see [chatId].put.ts for context.
import { defineEventHandler, createError } from 'h3';

export default defineEventHandler(() => {
  throw createError({ statusCode: 501, statusMessage: 'File uploads are disabled' });
});

/* Original implementation:
import { blob } from 'hub:blob'
import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const { username } = user

  const { pathname } = await getValidatedRouterParams(event, z.object({
    pathname: z.string().min(1)
  }).parse)

  if (!pathname.startsWith(`${username}/`)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'You do not have permission to delete this file'
    })
  }

  await blob.del(pathname)

  return sendNoContent(event)
})
*/
