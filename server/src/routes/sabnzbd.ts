import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';

export const sabnzbdRouter = Router();

// SABnzbd uses query-param based API, not REST
sabnzbdRouter.get('/api', async (req: Request, res: Response) => {
  const url = new URL(`${config.sabnzbd.url}/api`);
  url.searchParams.set('apikey', config.sabnzbd.apiKey);
  url.searchParams.set('output', 'json');

  // Forward all query params except apikey
  Object.entries(req.query).forEach(([key, value]) => {
    if (key !== 'apikey' && typeof value === 'string') {
      url.searchParams.set(key, value);
    }
  });

  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('SABnzbd proxy error:', message);
    res.status(502).json({
      error: 'Service unavailable',
      message: `Could not connect to SABnzbd at ${config.sabnzbd.url}`,
    });
  }
});
