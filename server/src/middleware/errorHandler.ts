import type { Request, Response, NextFunction } from 'express';
import { createServiceLogger } from '../services/logger';

const log = createServiceLogger('http');

export function requestLogger(req: Request, _res: Response, next: NextFunction) {
  log.info(`${req.method} ${req.path}`, {
    query: Object.keys(req.query).length ? req.query : undefined,
  });
  next();
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  log.error(`Unhandled error on ${req.method} ${req.path}`, {
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message,
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
  });
}
