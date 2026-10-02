# Run Kitty Run

3D square-spiral kitty runner (three.js): one long corridor of straight legs winding in to the goal room, with solo, local co-op and **online lobbies (up to 8 players)**.

Live: https://runkittyrun.fun (domain on Cloudflare, DNS only → the UpCloud box; Caddy gets the cert). The old free names (https://runkittyrun.80-47-225-25.nip.io, https://80-47-225-25.nip.io and the .sslip.io mirrors) redirect pages there but still serve /ws and /api for app builds.

## Run locally

```bash
npm install
npm start          # http://localhost:8080
```

## Patch notes

Player-facing notes live in `public/js/patchnotes.js` (newest first) and show on the title screen on desktop.
Add a line there whenever you ship something players will notice.

## Player feedback

Players can send feedback from the game (button shows while their kitty is down / on game over).
It's stored on the server in `/var/lib/run-kitty-run/feedback.jsonl`. Read it with:

```bash
scripts/feedback.sh          # newest last; add -n 20 for only the last 20
```

## Layout

- `public/` – the browser client (static files). `public/js/shared/` is the pure, deterministic game sim, used by both client and server.
- `server/index.js` – Node server: serves `public/` and runs lobbies over WebSockets at `/ws`.
- `deploy/` – systemd unit, Caddyfile (HTTPS), one-time `setup.sh`, and `deploy.sh`.
- `.github/workflows/deploy.yml` – every push to `main` is tested, then deployed to the UpCloud box.

## Online netcode, briefly

The server is authoritative and runs the sim at 60 Hz, broadcasting snapshots at 20 Hz. Clients run slightly ahead of
the server, send tick-tagged inputs, predict their own kitty, and reconcile on every snapshot. Wolves are deterministic
from the level seed, so every client simulates them locally; the server sends a few wolf positions per snapshot and a
client that drifts asks for a full wolf-state resync. The first player in a lobby is the host and starts the run; if they
leave, the next player in join order becomes host.

## Tests

```bash
node scripts/level-sync-test.mjs     # client mirror stays in sync across level changes
node scripts/playthrough-test.mjs    # a kitty following the path clears the level
node scripts/bot-test.mjs            # lobby/server behaviour (needs `npm start` running)
```
