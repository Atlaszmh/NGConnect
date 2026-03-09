import { Router } from 'express';
import { config } from '../config';
import { proxyRequest } from '../services/proxy';

export const radarrRouter = Router();

radarrRouter.all('/*path', (req, res) => {
  proxyRequest(req, res, {
    baseUrl: `${config.radarr.url}/api/v3`,
    apiKey: config.radarr.apiKey,
  });
});
