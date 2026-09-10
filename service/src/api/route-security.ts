import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { bankingPermission, type YuvomiUser } from '../auth/yuvomi-session.js';
import { config } from '../config.js';

export type SessionResolver = (cookieHeader?: string) => Promise<YuvomiUser | null>;

export async function resolveAuthorizedUser(
  request: Request,
  response: Response,
  resolveSession: SessionResolver,
  required: 'read' | 'write'
): Promise<YuvomiUser | null> {
  try {
    const user = await resolveSession(request.get('cookie') ?? undefined);
    if (!user) {
      response.status(401).json({ error: 'Not authenticated.' });
      return null;
    }
    const permission = bankingPermission(user);
    if (permission === 'none' || (required === 'write' && permission !== 'write')) {
      response.status(403).json({ error: 'Banking module access denied.' });
      return null;
    }
    return user;
  } catch {
    response.status(502).json({ error: 'Unable to verify Yuvomi session.' });
    return null;
  }
}

export function mutationIsAllowed(request: Request, response: Response): boolean {
  const origin = request.get('origin');
  if (!origin || !sameOrigin(origin, config.publicOrigin)) {
    response.status(403).json({ error: 'Origin check failed.' });
    return false;
  }
  const headerToken = request.get('x-banking-csrf');
  const cookieToken = cookieValue(request.get('cookie'), 'banking.csrf');
  if (!headerToken || !cookieToken || !safeTokenEqual(headerToken, cookieToken)) {
    response.status(403).json({ error: 'CSRF check failed.' });
    return false;
  }
  return true;
}

export function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

