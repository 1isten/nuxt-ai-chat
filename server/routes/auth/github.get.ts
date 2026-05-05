// GitHub OAuth route disabled — auth is handled by a stub (server/utils/auth.ts).
// Original implementation preserved below for reference.
import { defineEventHandler, sendRedirect } from 'h3';

export default defineEventHandler((event) => sendRedirect(event, '/'));

/* Original implementation:
import { db, schema } from 'hub:db'
import { and, eq } from 'drizzle-orm'

export default defineOAuthGitHubEventHandler({
  async onSuccess(event, { user: ghUser }) {
    const session = await getUserSession(event)

    let user = await db.query.users.findFirst({
      where: () => and(
        eq(schema.users.provider, 'github'),
        eq(schema.users.providerId, ghUser.id.toString())
      )
    })
    if (!user) {
      [user] = await db.insert(schema.users).values({
        id: session.id,
        name: ghUser.name || '',
        email: ghUser.email || '',
        avatar: ghUser.avatar_url || '',
        username: ghUser.login,
        provider: 'github',
        providerId: ghUser.id.toString()
      }).returning()
    } else {
      // Assign anonymous chats with session id to user
      await db.update(schema.chats).set({
        userId: user.id
      }).where(eq(schema.chats.userId, session.id))
    }

    await setUserSession(event, { user })

    return sendRedirect(event, '/')
  },
  onError(event, error) {
    console.error('GitHub OAuth error:', error)
    return sendRedirect(event, '/')
  }
})
*/
