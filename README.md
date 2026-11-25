# Dogfight — Lab 08: Cloud Deployment, Monitoring & Chaos Verification

Public deployment: `https://lab8.fly.dev` (`APP_VERSION=v1.0.0`, region `fra`, internal port `3000`).

![Two players on Fly.io](./2026-11-2522-36-46-ezgif.com-video-to-gif-converter.gif)

## Run

```bash
npm install
npm run build
npm start
```

For Fly.io deployment and endpoint verification:

```bash
fly deploy
curl -s https://lab8.fly.dev/health
curl -s https://lab8.fly.dev/ready
```

## Architecture & Operations

| Component / Endpoint | Role in Lab 08 |
| :--- | :--- |
| `Dockerfile` & `fly.toml` | Builds the Node.js/TypeScript server (`PORT=3000`, `HOST=0.0.0.0`, `APP_VERSION=v1.0.0`) and runs on Fly.io (`force_https = true`, HTTP health check on `/health`) |
| `/health` & `/ready` | Return HTTP `200` with service status (`ok` / `ready`) and `version: "v1.0.0"` |
| `/metrics` | Exposes Prometheus metrics for traffic, connections, and rejection counters (`dogfight_rejections_total`) |
| `ALLOWED_ORIGINS` & limits | Rejects unauthorized WebSocket origins (`Unexpected server response: 400`, `CLOSE 1006`) and caps parallel/flood connections |
| UptimeRobot | External HTTP monitor watching `https://lab8.fly.dev/health` (`Up` / `200 OK`) |

## Verification & Results

| Check | Observed Result |
| :--- | :--- |
| Two-player match (`https://lab8.fly.dev`) | Two clients active in `Alpha (calm)` over `wss://`, `steps/s = 30.0`, `frames/s = 75.0`, `RTT ~ 32–33 ms` |
| External monitoring | UptimeRobot monitor active on `https://lab8.fly.dev/health` with `Up` status |
| Unauthorized `Origin` (`https://evil.example.com`) | With `ALLOWED_ORIGINS="https://lab8.fly.dev"`, WebSocket connection is rejected with HTTP `400` (`CLOSE 1006`) |
| Server restart reconnect (`fly apps restart lab8`) | Connected clients log shutdown/reconnecting and restore `connected` state in room |
| Flood connections & room isolation | Batch of parallel WebSocket flood connections is rejected with HTTP `400` (`CLOSE 1006`), while active rooms remain connected |

## Constraints & Next Steps

* Room state is held in memory without persistent storage across restarts; scale to 1 machine or stop unused Fly.io machines after testing to preserve free-tier quota.
* Non-blocking browser console notices remain for `AudioContext` resume after user gesture and missing `/favicon.ico` (`404`).
* Next steps: keep `lab8/README.md` and the GIF in the repository and tag the commit with `lab-08` and `v1.0.0`.

## Tags

* `lab-08`
* `v1.0.0`