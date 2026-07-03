import { Router } from 'express';
import type { Request, Response } from 'express';

export const healthRouter = Router();

// Unauthenticated, always-on liveness probe used by the auto-deploy updater.
// Must not depend on NODE_ENV or any downstream service.
healthRouter.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});
