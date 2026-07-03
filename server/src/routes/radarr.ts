import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';
import { proxyRequest } from '../services/proxy';
import { ensureMovie } from '../services/arrAdd';

export const radarrRouter = Router();

// Add a movie to the library AND kick off Radarr's own search (grab -> SAB -> import -> Plex).
radarrRouter.post('/add-movie', async (req: Request, res: Response) => {
  const { tmdbId, imdbId } = req.body ?? {};
  // Require a positive tmdbId or a string imdbId. A non-positive tmdbId is skipped
  // by movieLookupTerm, so validating it here keeps bad input a 400, not a 502.
  const hasTmdb = typeof tmdbId === 'number' && tmdbId > 0;
  if (!hasTmdb && typeof imdbId !== 'string') {
    res.status(400).json({ error: 'tmdbId (positive number) or imdbId (string) is required' });
    return;
  }
  try {
    const { added } = await ensureMovie(config.radarr, { tmdbId, imdbId }, true);
    res.json({ added });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Add movie failed';
    console.error('radarr add-movie error:', message);
    res.status(502).json({ error: message });
  }
});

radarrRouter.all('/*path', (req, res) => {
  proxyRequest(req, res, {
    baseUrl: `${config.radarr.url}/api/v3`,
    apiKey: config.radarr.apiKey,
  });
});
