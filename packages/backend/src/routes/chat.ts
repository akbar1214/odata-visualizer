import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { getSession } from '../services/sessionManager.js';
import { chat } from '../services/llmService.js';

const router: ExpressRouter = Router();

interface ChatRequest {
  sessionId: string;
  message: string;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const { sessionId, message } = req.body as ChatRequest;

    if (!sessionId || !message) {
      res.status(400).json({
        error: 'sessionId and message are required',
      });
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      res.status(404).json({
        error: 'Session not found. Please upload metadata first.',
      });
      return;
    }

    const result = await chat(session.metadata, message);

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(500).json({ error: message });
  }
});

export { router as chatRouter };
