# NGConnect

A self-hosted media server dashboard that brings Sonarr, Radarr, SABnzbd, NZBGeek, and ProtonVPN together in one unified interface.

## Features

- **Dashboard** — Service health, active downloads, upcoming episodes at a glance
- **Global Status Bar** — Always-visible bar showing services, download speed/progress, and VPN status across all pages
- **TV Shows** — Browse and manage your Sonarr library
- **Movies** — Browse and manage your Radarr library
- **Downloads** — Real-time SABnzbd queue with pause/resume/delete controls
- **Search** — Search NZBGeek and send results directly to SABnzbd
- **VPN Monitor** — ProtonVPN connection status with automatic kill switch (pauses downloads if VPN drops)
- **Notifications** — In-app alerts for VPN events, download completions, and service issues
- **Authentication** — Optional username/password login with JWT

## Requirements

- [Node.js](https://nodejs.org) v20 or later
- [Sonarr](https://sonarr.tv), [Radarr](https://radarr.video), [SABnzbd](https://sabnzbd.org) running on your network
- [NZBGeek](https://nzbgeek.info) API key (for search)
- [ProtonVPN](https://protonvpn.com) (optional, for VPN monitoring)

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url> NGConnect
cd NGConnect
npm install
```

### 2. Configure

Copy the example environment file and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` with your service URLs and API keys:

```env
SONARR_URL=http://localhost:8989
SONARR_API_KEY=your_key_here

RADARR_URL=http://localhost:7878
RADARR_API_KEY=your_key_here

SABNZBD_URL=http://localhost:8080
SABNZBD_API_KEY=your_key_here

NZBGEEK_API_KEY=your_key_here
```

### 3. Build and run

```bash
npm run build
npm start
```

Open **http://localhost:3001** in your browser.

## Running the Server

### Option A: Double-click (easiest)

Double-click **`start.bat`** to launch the server in a console window. It will:
- Check that Node.js is installed
- Auto-build if this is the first run
- Start the server on port 3001

Double-click **`stop.bat`** to stop it.

### Option B: Install as Windows Service (auto-start at boot)

Right-click **`install-service.ps1`** → **Run with PowerShell** (as Administrator).

This creates a Windows Scheduled Task that:
- Starts NGConnect automatically when Windows boots
- Runs in the background (no console window)
- Auto-restarts up to 3 times if it crashes

To remove: right-click **`uninstall-service.ps1`** → **Run with PowerShell** (as Administrator).

### Option C: Command line

```bash
npm run build    # Build frontend + backend
npm start        # Start production server
```

For development with hot-reload:

```bash
npm run dev      # Starts client (:5173) and server (:3001) concurrently
```

## LAN Access

To access NGConnect from other devices on your network:

1. Open Windows Firewall for port 3001:
   ```powershell
   # Run as Administrator
   New-NetFirewallRule -DisplayName 'NGConnect' -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow -Profile Any
   ```

2. Access from other devices at `http://<your-pc-ip>:3001`

## Authentication (Optional)

To enable login, set these in `.env`:

```env
AUTH_USERNAME=admin
AUTH_PASSWORD_HASH=<bcrypt hash>
JWT_SECRET=<random string>
```

Generate a password hash:

```bash
cd server
npx tsx -e "import bcrypt from 'bcryptjs'; bcrypt.hash('yourpassword', 10).then(console.log)"
```

## VPN Monitoring

NGConnect monitors ProtonVPN by reading its local log file — no external API calls needed. When the VPN disconnects:

1. The status bar shows a red indicator
2. A notification is generated
3. If the kill switch is enabled, SABnzbd downloads are automatically paused
4. When VPN reconnects, downloads automatically resume

You can optionally set `HOME_IP=x.x.x.x` in `.env` for more reliable detection on first boot.

### Troubleshooting: Downloads resuming unexpectedly

If downloads resume on an unprotected network, check for **zombie server processes** from previous sessions. Multiple NGConnect instances running simultaneously can conflict — old instances with outdated VPN logic may send resume commands to SABnzbd.

To fix, kill all Node processes and start fresh:

```bash
# Stop all Node processes (Windows)
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"

# Then start a single clean server
npm start
```

Always use `stop.bat` before starting a new instance, or use the Windows Service (Scheduled Task) approach which manages a single instance automatically.

## Project Structure

```
NGConnect/
├── client/          # React 19 + Vite frontend
│   └── src/
│       ├── components/   # Layout, StatusBar, NotificationBell, etc.
│       ├── pages/        # Dashboard, TV, Movies, Downloads, Search, VPN, Settings
│       └── services/     # API client, auth
├── server/          # Express 5 + TypeScript backend
│   └── src/
│       ├── routes/       # API proxies (sonarr, radarr, sabnzbd, nzbgeek, system)
│       ├── services/     # VPN monitor, health monitor, notifications, logger
│       └── middleware/   # Auth, error handling
├── start.bat              # Double-click to start
├── stop.bat               # Double-click to stop
├── install-service.ps1    # Install as Windows startup service
├── uninstall-service.ps1  # Remove startup service
└── .env                   # Configuration (not committed)
```

## License

MIT
