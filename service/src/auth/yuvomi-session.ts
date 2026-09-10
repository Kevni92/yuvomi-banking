import { config } from '../config.js';

export type PermissionLevel = 'none' | 'read' | 'write';

export interface YuvomiUser {
  id: number;
  display_name?: string;
  role?: string;
  permissions?: {
    modules?: Record<string, PermissionLevel>;
  };
}

type JsonRecord = Record<string, unknown>;
const SESSION_CACHE_TTL_MS = 3_000;
const sessionCache = new Map<string, { expiresAt: number; user: YuvomiUser }>();

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'none' || value === 'read' || value === 'write';
}

/**
 * Normalize the current Yuvomi response ({ user, permissions }) while keeping
 * compatibility with the older documented { data: { user } } envelope.
 */
export function normalizeYuvomiUser(body: unknown): YuvomiUser {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  const candidate =
    asRecord(root?.user) ??
    asRecord(data?.user) ??
    (data && 'id' in data ? data : null);

  if (!candidate) {
    throw new Error('Yuvomi auth response did not contain a user.');
  }

  const rawId = candidate.id;
  const id = typeof rawId === 'number' ? rawId : Number(rawId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Yuvomi auth response contained an invalid user id.');
  }

  const permissionSource =
    asRecord(candidate.permissions) ??
    asRecord(root?.permissions) ??
    asRecord(data?.permissions);
  const modules: Record<string, PermissionLevel> = {};
  const rawModules = asRecord(permissionSource?.modules);

  for (const [key, value] of Object.entries(rawModules ?? {})) {
    if (isPermissionLevel(value)) modules[key] = value;
  }

  return {
    id,
    ...(typeof candidate.display_name === 'string'
      ? { display_name: candidate.display_name }
      : {}),
    ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
    permissions: { modules }
  };
}

export async function resolveYuvomiUser(cookieHeader?: string): Promise<YuvomiUser | null> {
  if (!cookieHeader) return null;

  const cached = sessionCache.get(cookieHeader);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  if (cached) sessionCache.delete(cookieHeader);

  const response = await fetch(`${config.yuvomiInternalUrl}/api/v1/auth/me`, {
    headers: {
      cookie: cookieHeader,
      accept: 'application/json'
    },
    redirect: 'manual'
  });

  if (response.status === 401 || response.status === 403) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Yuvomi auth check failed with HTTP ${response.status}`);
  }

  const user = normalizeYuvomiUser(await response.json());
  sessionCache.set(cookieHeader, { expiresAt: Date.now() + SESSION_CACHE_TTL_MS, user });
  return user;
}

export function bankingPermission(user: YuvomiUser): 'none' | 'read' | 'write' {
  const permission = user.permissions?.modules?.['ext:banking'];
  return permission === 'read' || permission === 'write' ? permission : 'none';
}
