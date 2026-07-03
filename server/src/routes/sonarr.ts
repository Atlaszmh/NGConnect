import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';
import { proxyRequest } from '../services/proxy';
import { ensureSeries } from '../services/arrAdd';

export const sonarrRouter = Router();

// Add a series (whole show monitored) AND search all missing episodes immediately.
sonarrRouter.post('/add-series', async (req: Request, res: Response) => {
  const { tvdbId, seasons } = req.body ?? {};
  if (typeof tvdbId !== 'number' || tvdbId <= 0) {
    res.status(400).json({ error: 'tvdbId (positive number) is required' });
    return;
  }
  if (seasons !== undefined && (!Array.isArray(seasons) || !seasons.every((n) => Number.isInteger(n) && n >= 0))) {
    res.status(400).json({ error: 'seasons must be an array of non-negative integers' });
    return;
  }
  try {
    const { added } = await ensureSeries(config.sonarr, tvdbId, Array.isArray(seasons) ? seasons : null, true);
    res.json({ added });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Add series failed';
    console.error('sonarr add-series error:', message);
    res.status(502).json({ error: message });
  }
});

sonarrRouter.all('/*path', (req, res) => {
  proxyRequest(req, res, {
    baseUrl: `${config.sonarr.url}/api/v3`,
    apiKey: config.sonarr.apiKey,
  });
});
