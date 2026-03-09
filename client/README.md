# NGConnect Client

React 19 + TypeScript + Vite 7 frontend for the NGConnect media server dashboard.

In development, this runs on `:5173` and proxies API calls to the Express backend on `:3001`.
In production, the built output (`dist/`) is served statically by the Express server — no separate process needed.

## Dev

```bash
npm run dev
```

Starts the Vite dev server at `http://localhost:5173`. API requests are proxied to `http://localhost:3001`.

## Build

```bash
npm run build
```

Outputs to `client/dist/`. The Express server picks this up automatically when `NODE_ENV=production`.

## Structure

```
src/
├── components/     # Layout, ServiceStatus, NotificationBell, ErrorBoundary
├── pages/          # Dashboard, TvShows, Movies, Downloads, Search, Vpn, Settings, Login
├── services/       # api.ts (axios instance), auth.ts (JWT token helpers)
└── hooks/          # usePolling (generic interval-based data fetching)
```

## Notes

- **Node.js 20.19+ or 22.12+ required** — Vite 7 uses `crypto.hash` which is unavailable in Node 18
- API base URL is configured via `vite.config.ts` proxy in dev; in production the frontend and API share the same origin
