import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { metadataStore, sanitizeModelId } from '../services/metadataStore.js';

const router: ExpressRouter = Router();

function sessionIdOf(req: Request, query?: Record<string, unknown>): string | undefined {
  const header = req.headers['x-metadata-session'];
  const fromHeader = typeof header === 'string' ? header : undefined;
  const raw = fromHeader ?? (typeof query?.['session'] === 'string' ? query['session'] : undefined);
  return raw ? sanitizeModelId(raw) : undefined;
}

/**
 * GET /api/metadata/current
 * Returns the model for this session, or the most recent one.
 */
router.get('/current', (req: Request, res: Response) => {
  const stored = metadataStore.get(sessionIdOf(req, req.query as Record<string, unknown>));
  res.json({
    success: true,
    metadata: stored?.metadata ?? null,
    info: stored?.info ?? null,
  });
});

/**
 * GET /api/metadata
 * Lists the models held for each session (no metadata payload).
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, models: metadataStore.list() });
});

/**
 * DELETE /api/metadata/current
 * Clears this session's model (or all of them when no session is given).
 */
router.delete('/current', (req: Request, res: Response) => {
  metadataStore.clear(sessionIdOf(req));
  res.json({ success: true });
});

export { router as metadataRouter };
