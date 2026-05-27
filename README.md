# better-nodejs-vless-ws

VLESS + WebSocket proxy server for Node.js with full **xUDP** and **Mux.Cool** (xray-core multiplexing) support.

Enhanced from [eooce/node-ws](https://github.com/eooce/node-ws) (GPL-3.0) with AI assistance (Kimi K2.6).

---

## Features

- **VLESS over WebSocket** — standard VLESS protocol tunneling over WS
- **TCP proxying** — direct TCP stream forwarding
- **Legacy UDP** — UDP tunneling via VLESS framing
- **xUDP** — extended UDP multiplexing (xray-core)
- **Mux.Cool** — full xray-core connection multiplexing support
- **DNS cache** — built-in DNS resolver with TTL-based caching (300s TTL, 60s sweep)
- **Domain blocking** — Saved from [eooce/node-ws](https://github.com/eooce/node-ws) (GPL-3.0)
- **Admin dashboard** — live stats at `/admin-stats` (connections, streams, traffic, uptime)
- **Decoy page** — outputs a fake HTML page on non-proxy HTTP requests (or on failed authentication)
- **Zero-allocation hot path** — chunked buffer queue and reusable codec buffers for performance

---

## Client Compatibility

| Client | TCP | UDP / xUDP | Mux.Cool |
|---|---|---|---|
| v2rayN | ✅ | ✅ | ✅ |
| v2rayNG | ✅ | ✅ | ✅ |
| v2rayTun | ✅ | ✅ | ✅ |
| Happ | ✅ | ✅ | ✅ |
| Streisand | ✅ | ✅ | ✅ |
| NekoBox | ✅ | ✅ | ⚠️ |
| sing-box VT | ✅ | ✅ | ⚠️ |
| Hiddify | ✅ | ✅ | ⚠️ |
| Karing | ✅ | ✅ | ⚠️ |
| Shadowrocket | ✅ | ✅ | ⚠️ |

> [!CAUTION]
> **⚠️ sing-box based clients have compatibility issues with Mux.Cool.**

> [!NOTE]
> **TCP, Legacy UDP and XUDP are NOT affected by this issue**.

---

## Requirements

- Node.js 16+
- No external npm dependencies <-- used only Node.js built-ins (`net`, `dgram`, `dns`, `crypto`)

---

## Quick Start

```bash
git clone https://github.com/cocaococao/better-nodejs-vless-ws
cd better-nodejs-vless-ws
node appws.js
```

The server starts on port `3000` by default. Check the console output for your WebSocket path and UUID.

---

## Configuration

The configuration is done through environment variables.

| Variable | Default | Description |
|---|---|---|
| `UUID` | `7bd180e8-...` | VLESS authentication UUID |
| `WSPATH` | First 8 chars of UUID (can be changed through variables) | WebSocket path prefix |
| `PORT` / `SERVER_PORT` | `3000` | Listening port |

**Example:**

```bash
UUID=your-uuid-here WSPATH=mypath PORT=8080 node appws.js
```

---

## Client Configuration

- **Protocol:** VLESS
- **Address:** your server IP or domain
- **Port:** your configured port
- **UUID:** your configured UUID (or first 8 chars of UUID)
- **Network:** WebSocket
- **WS Path:** `/<WSPATH>` (e.g. `/7bd180e8`)
- **TLS:** depends (see below)

---

## Running Behind a Reverse Proxy (TLS)

You can put this server behind nginx or Caddy to handle TLS:

**Caddy example (`Caddyfile`):**

```
yourdomain.com {
    reverse_proxy /yourpath* localhost:3000
}
```

**nginx example:**

```nginx
location /yourpath {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
}
```

---

## Admin Dashboard

A live stats page is available at:

```
http://your-server:port/admin-stats
```

It shows active connections, stream counts, protocol breakdown (TCP/UDP/Mux), total traffic, and connection history. Auto-refreshes every 5 seconds.

> [!WARNING]
> **Do not expose this endpoint publicly in production. Protect it with your reverse proxy.**

---

## Project Structure

```
appws.js          # Single-file server implementation
README.md
```

---

## Credits

- Original implementation: [eooce/node-ws](https://github.com/eooce/node-ws) — licensed under [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
- xUDP and Mux.Cool implementations assisted by Kimi K2.6

---

## License

This project is licensed under the **GNU General Public License v3.0**, same with original project's license.

See [LICENSE](https://github.com/cocaococao/better-nodejs-vless-ws/blob/main/LICENSE) for details.
