import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { metadataStore } from '../services/metadataStore.js';

const router: ExpressRouter = Router();

/**
 * GET /api/metadata/current
 * Returns the metadata currently held for the uploaded file (or nulls).
 */
router.get('/current', (_req: Request, res: Response) => {
  const stored = metadataStore.get();
  res.json({
    success: true,
    metadata: stored?.metadata ?? null,
    info: stored?.info ?? null,
  });
});

/**
 * DELETE /api/metadata/current
 * Clears the current metadata (called when the user clears the diagram).
 */
router.delete('/current', (_req: Request, res: Response) => {
  metadataStore.clear();
  res.json({ success: true });
});

export { router as metadataRouter };
