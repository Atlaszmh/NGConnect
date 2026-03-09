import { Router } from 'express';
import { config } from '../config';
import { proxyRequest } from '../services/proxy';

export const sonarrRouter = Router();

sonarrRouter.all('/*path', (req, res) => {
  proxyRequest(req, res, {
    baseUrl: `${config.sonarr.url}/api/v3`,
    apiKey: config.sonarr.apiKey,
  });
});
