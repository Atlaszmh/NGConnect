import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';
import { parseNewznabResults } from '../services/newznab';

export const nzbgeekRouter = Router();

// Search NZBGeek via Newznab API
nzbgeekRouter.get('/search', async (req: Request, res: Response) => {
  const { q, cat, limit = '100' } = req.query;

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
  url.searchParams.set('extended', '1'); // REQUIRED: grabs/usenetdate are only returned with extended=1

  if (cat && typeof cat === 'string') {
    url.searchParams.set('cat', cat);
  }

  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    res.json({ results: parseNewznabResults(data) });
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

// Hand a release to Sonarr/Radarr via release/push so their Completed Download
// Handling imports it (and Plex refreshes). Keeps all API keys server-side.
nzbgeekRouter.post('/send-to-arr', async (req: Request, res: Response) => {
  const { title, nzbUrl, pubDate, target } = req.body ?? {};

  // Guard for STRINGS (not just truthy): downloadUrl is built outside the
  // try/catch below, so a non-string nzbUrl would throw an unhandled 500 on
  // `.includes`. Mirrors /search's `typeof q !== 'string'` check.
  if (typeof nzbUrl !== 'string' || !nzbUrl || typeof title !== 'string' || !title) {
    res.status(400).json({ error: 'title and nzbUrl (strings) are required' });
    return;
  }
  if (target !== 'sonarr' && target !== 'radarr') {
    res.status(400).json({ error: "target must be 'sonarr' or 'radarr'" });
    return;
  }

  const base = target === 'sonarr' ? config.sonarr : config.radarr;

  // Append the NZBGeek API key server-side (same rule as send-to-sab).
  const downloadUrl = nzbUrl.includes('apikey')
    ? nzbUrl
    : `${nzbUrl}&apikey=${config.nzbgeek.apiKey}`;

  const payload = {
    title,
    downloadUrl,
    protocol: 'usenet', // current Sonarr/Radarr v3 value; verified only via the live grab test
    publishDate: pubDate || new Date().toISOString(),
  };

  try {
    const response = await fetch(`${base.url}/api/v3/release/push`, {
      method: 'POST',
      headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Pass the arr's status + body straight through so the UI can read the decision.
    const contentType = response.headers.get('content-type') || '';
    res.status(response.status);
    if (contentType.includes('application/json')) {
      const body = await response.json();
      // The arr echoes the pushed release incl. the keyed downloadUrl; scrub keys before returning.
      const scrubbed = JSON.parse(
        JSON.stringify(body).replace(/apikey=[^&"\\]+/gi, 'apikey=REDACTED')
      );
      res.json(scrubbed);
    } else {
      const text = await response.text();
      res.send(text.replace(/apikey=[^&"\\]+/gi, 'apikey=REDACTED'));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`send-to-arr [${target}] error:`, message);
    res.status(502).json({ error: `Could not connect to ${target}` });
  }
});
