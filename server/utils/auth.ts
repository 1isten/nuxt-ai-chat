// Auth stub. The original template uses `nuxt-auth-utils`'s `getUserSession`
// to identify the user (or anonymous browser session). For a single-user
// Electron app we don't need real auth; a constant identity is enough so the
// existing ownership / visibility checks still work.
//
// The original calls were left in place but routed through this stub so that
// re-enabling real auth later is a one-line swap.
//
// Shape mimics `nuxt-auth-utils` UserSession just enough for what handlers use.

import type { H3Event } from 'h3';

export interface AppUser {
  id: string;
  username: string;
  name?: string;
  email?: string;
  avatar?: string;
}

export interface AppSession {
  /** Anonymous session id; mirrors what nuxt-auth-utils used to put here. */
  id: string;
  user?: AppUser;
}

const DEFAULT_SESSION: AppSession = {
  id: 'local-session',
  user: {
    id: 'local-user',
    username: 'local',
  },
};

let _resolver: (event: H3Event) => AppSession | Promise<AppSession> = () => DEFAULT_SESSION;

/** Override the session resolver. Useful for an Electron-side server that
 *  embeds its own user model. */
export function setSessionResolver(resolver: (event: H3Event) => AppSession | Promise<AppSession>): void {
  _resolver = resolver;
}

export async function getUserSession(event: H3Event): Promise<AppSession> {
  return await _resolver(event);
}

export async function requireUserSession(event: H3Event): Promise<AppSession & { user: AppUser }> {
  const s = await getUserSession(event);
  if (!s.user) {
    const err = new Error('Unauthorized') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return s as AppSession & { user: AppUser };
}
