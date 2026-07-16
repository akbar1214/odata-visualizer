import type { ODataMetadata } from '@odata-visualizer/shared';

interface Session {
  id: string;
  metadata: ODataMetadata;
  createdAt: number;
  lastAccessedAt: number;
}

const sessions = new Map<string, Session>();

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

setInterval(cleanup, CLEANUP_INTERVAL_MS);

export function createSession(id: string, metadata: ODataMetadata): Session {
  const session: Session = {
    id,
    metadata,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (session) {
    session.lastAccessedAt = Date.now();
  }
  return session;
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}
