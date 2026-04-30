// Blob/file-upload feature is disabled in this fork.
// The original implementation used `hub:blob` (NuxtHub Blob) — see the
// project README for the full original code. To re-enable, restore the
// nuxt-auth-utils + @nuxthub/core wiring and the original blob handler.
//
// Returning 501 keeps the route discoverable while clearly signalling
// "not implemented" to the frontend (the frontend only calls /api/upload/*
// when the user is logged in, which never happens with the current auth stub).

import { defineEventHandler, createError } from 'h3';

export default defineEventHandler(() => {
  throw createError({ statusCode: 501, statusMessage: 'File uploads are disabled' });
});

/* Original implementation (preserved for reference):
import { blob } from 'hub:blob'
import { db, schema } from 'hub:db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const { chatId } = await getValidatedRouterParams(event, z.object({
    chatId: z.string()
  }).parse)

  const userId = user.id

  const chat = await db.query.chats.findFirst({
    where: () => eq(schema.chats.id, chatId)
  })

  if (chat && chat.userId !== userId) {
    throw createError({
      statusCode: 403,
      statusMessage: 'You do not have permission to upload files to this chat'
    })
  }

  const username = user.username

  return blob.handleUpload(event, {
    formKey: 'files',
    multiple: false,
    ensure: {
      maxSize: FILE_UPLOAD_CONFIG.maxSize,
      types: [...FILE_UPLOAD_CONFIG.types]
    },
    put: {
      addRandomSuffix: true,
      prefix: `${username}/${chatId}`
    }
  })
})
*/
