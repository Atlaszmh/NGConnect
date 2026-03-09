import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';

export const nzbgeekRouter = Router();

// Search NZBGeek via Newznab API
nzbgeekRouter.get('/search', async (req: Request, res: Response) => {
  const { q, cat, limit = '50' } = req.query;

  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: 'Search query (q) is required' });
    return;
  }

  const url = new URL(`${config.nzbgeek.baseUrl}/api`);
  url.searchParams.set('apikey', config.nzbgeek.apiKey);
  url.searchParams.set('t', 'search');
  url.searchParams.set('q', q);
  url.searchParams.set('o', 'json');
  url.searchParams.set('limit', String(limit));

  if (cat && typeof cat === 'string') {
    url.searchParams.set('cat', cat);
  }

  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('NZBGeek search error:', message);
    res.status(502).json({
      error: 'Search failed',
      message: `Could not connect to NZBGeek`,
    });
  }
});

// Get NZB download URL (proxied to keep API key server-side)
nzbgeekRouter.get('/download/:guid', async (req: Request, res: Response) => {
  const guid = req.params.guid as string;
  const url = new URL(`${config.nzbgeek.baseUrl}/api`);
  url.searchParams.set('apikey', config.nzbgeek.apiKey);
  url.searchParams.set('t', 'get');
  url.searchParams.set('id', guid);

  try {
    const response = await fetch(url.toString());
    const contentType = response.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType);
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('NZBGeek download error:', message);
    res.status(502).json({ error: 'Download failed' });
  }
});

// Send an NZB to SABnzbd by URL
nzbgeekRouter.post('/send-to-sab', async (req: Request, res: Response) => {
  const { title, nzbUrl } = req.body;

  if (!nzbUrl) {
    res.status(400).json({ error: 'nzbUrl is required' });
    return;
  }

  // Build the actual NZBGeek download URL with API key
  const downloadUrl = nzbUrl.includes('apikey')
    ? nzbUrl
    : `${nzbUrl}&apikey=${config.nzbgeek.apiKey}`;

  const sabUrl = new URL(`${config.sabnzbd.url}/api`);
  sabUrl.searchParams.set('apikey', config.sabnzbd.apiKey);
  sabUrl.searchParams.set('mode', 'addurl');
  sabUrl.searchParams.set('name', downloadUrl);
  sabUrl.searchParams.set('output', 'json');
  if (title) {
    sabUrl.searchParams.set('nzbname', title);
  }

  try {
    const response = await fetch(sabUrl.toString());
    const data = await response.json();
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Send to SABnzbd error:', message);
    res.status(502).json({ error: 'Failed to send to SABnzbd' });
  }
});
