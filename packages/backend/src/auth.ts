import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Optional bearer-token authentication for the REST API. Health checks stay
 * open so uptime probes keep working. No-op when no token is configured.
 */
export function createApiAuth(token: string | undefined) {
  const expected = token?.trim();

  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.originalUrl.split('?')[0];
    if (!expected || path === '/api/health' || path === '/health') {
      next();
      return;
    }

    const header = req.headers['authorization'];
    const provided =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;

    if (provided) {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        next();
        return;
      }
    }

    res.status(401).json({
      success: false,
      error: 'Unauthorized: provide the API token as "Authorization: Bearer <token>"',
    });
  };
}
