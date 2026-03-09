import type { Request, Response } from 'express';

interface ProxyOptions {
  baseUrl: string;
  apiKey: string;
  headerName?: string;
}

export async function proxyRequest(
  req: Request,
  res: Response,
  options: ProxyOptions
): Promise<void> {
  const { baseUrl, apiKey, headerName = 'X-Api-Key' } = options;
  const targetUrl = `${baseUrl}${req.path}`;
  const url = new URL(targetUrl);

  // Forward query parameters
  Object.entries(req.query).forEach(([key, value]) => {
    if (typeof value === 'string') {
      url.searchParams.set(key, value);
    }
  });

  const headers: Record<string, string> = {
    [headerName]: apiKey,
    'Content-Type': 'application/json',
  };

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(url.toString(), fetchOptions);
    const contentType = response.headers.get('content-type') || '';

    res.status(response.status);

    if (contentType.includes('application/json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const text = await response.text();
      res.send(text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Proxy error [${req.method} ${targetUrl}]:`, message);
    res.status(502).json({
      error: 'Service unavailable',
      message: `Could not connect to ${baseUrl}`,
    });
  }
}
