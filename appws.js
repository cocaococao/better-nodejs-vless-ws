'use strict';

const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const crypto = require('crypto');

// ==========================================
// Environment & Configuration
// ==========================================
const UUID = process.env.UUID || '7bd180e8-1142-4387-93f5-03e8d750a896';
const TARGET_UUID_BYTES = Buffer.from(UUID.replace(/-/g, ''), 'hex');

const WSPATH = process.env.WSPATH || UUID.slice(0, 8);
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10);
const HOST = const HOST = process.env.SERVER_HOST || process.env.HOST || '0.0.0.0';

const DNS_TTL = 300;
const DNS_SWEEP = 60;

const BLOCKED_DOMAINS = [
  'speedtest.net', 'fast.com', 'speedtest.cn', 'speed.cloudflare.com', 'speedof.me',
  'testmy.net', 'bandwidth.place', 'speed.io', 'librespeed.org', 'speedcheck.org'
];

// ==========================================
// GLOBAL STATISTICS (Lockless via single thread)
// ==========================================
const globalStats = {
  startTime: Date.now(),
  totalConnections: 0,
  activeConnections: 0,
  totalStreams: 0,
  activeStreams: 0,
  totalBytesTx: 0,
  totalBytesRx: 0,
  tcpStreams: 0,
  udpStreams: 0,
  muxSessions: 0,
  connections: new Map(),
  connectionHistory: []
};

// ==========================================
// DATA BUFFER (Chunked Buffer Queue)
// Eliminates repeated Buffer.concat on hot path
// ==========================================
function newDataBuffer() {
  return { parts: [], size: 0 };
}

function dbAppend(db, buf) {
  if (!buf || buf.length === 0) return;
  db.parts.push(buf);
  db.size += buf.length;
}

function dbToBuffer(db) {
  if (db.size === 0) return Buffer.alloc(0);
  if (db.parts.length === 1) return db.parts[0];
  const out = Buffer.allocUnsafe(db.size);
  let off = 0;
  for (let i = 0; i < db.parts.length; i++) {
    const p = db.parts[i];
    p.copy(out, off);
    off += p.length;
  }
  db.parts = [out];
  return out;
}

function dbConsume(db, n) {
  if (n <= 0) return;
  if (n >= db.size) {
    db.parts = [];
    db.size = 0;
    return;
  }
  // Fast path: skip entire parts
  let skip = n;
  while (db.parts.length > 0 && skip >= db.parts[0].length) {
    skip -= db.parts[0].length;
    db.parts.shift();
  }
  if (skip > 0 && db.parts.length > 0) {
    db.parts[0] = db.parts[0].subarray(skip);
    skip = 0;
  }
  db.size = db.size - n;
  if (db.size < 0) db.size = 0;
}

function dbClear(db) {
  db.parts = [];
  db.size = 0;
}

// ==========================================
// FAKE INDEX HTML
// ==========================================
const FAKE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f7fa;
            color: #2c3e50;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        header {
            text-align: center;
            padding: 60px 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            margin-bottom: 40px;
            border-radius: 12px;
        }
        header h1 { font-size: 2.5em; margin-bottom: 10px; }
        header p { font-size: 1.2em; opacity: 0.9; }
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            margin-bottom: 40px;
        }
        .feature-card {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            transition: transform 0.2s;
        }
        .feature-card:hover { transform: translateY(-5px); }
        .feature-card h3 { color: #667eea; margin-bottom: 10px; }
        .cta {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
        }
        .btn {
            display: inline-block;
            padding: 12px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            margin: 10px;
            transition: background 0.2s;
        }
        .btn:hover { background: #5a67d8; }
        footer { text-align: center; padding: 40px 0; color: #7f8c8d; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Welcome to Our Service</h1>
            <p>Reliable, fast, and secure solutions for your needs</p>
        </header>
        <div class="features">
            <div class="feature-card">
                <h3>High Performance</h3>
                <p>Built with cutting-edge technology to ensure the best experience with minimal latency and maximum throughput.</p>
            </div>
            <div class="feature-card">
                <h3>Secure & Private</h3>
                <p>Your data security is our top priority. We use industry-standard encryption to protect all communications.</p>
            </div>
            <div class="feature-card">
                <h3>Global Network</h3>
                <p>Access our services from anywhere in the world with our distributed network infrastructure.</p>
            </div>
        </div>
        <div class="cta">
            <h2>Get Started Today</h2>
            <p>Join thousands of satisfied users who trust our platform.</p>
            <a href="#" class="btn">Learn More</a>
            <a href="#" class="btn">Contact Us</a>
        </div>
        <footer>
            <p> Contact 2026 Our Service. All rights reserved.</p>
        </footer>
    </div>
</body>
</html>`;

// ==========================================
// ADMIN STATS HTML
// ==========================================
function generateStatsHtml() {
  const uptime = Math.floor((Date.now() - globalStats.startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  const uptimeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Server Statistics</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #0f0f23;
            color: #e0e0e0;
            min-height: 100vh;
        }
        .header {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            padding: 30px;
            text-align: center;
            border-bottom: 2px solid #0f3460;
        }
        .header h1 {
            font-size: 2.2em;
            background: linear-gradient(90deg, #e94560, #0f3460);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }
        .header p { color: #8892b0; font-size: 0.95em; }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }
        .stat-card {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #0f3460;
            text-align: center;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .stat-card:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(233, 69, 96, 0.15);
        }
        .stat-card .icon {
            font-size: 2em;
            margin-bottom: 10px;
        }
        .stat-card .value {
            font-size: 2em;
            font-weight: 700;
            color: #e94560;
            margin: 5px 0;
        }
        .stat-card .label {
            color: #8892b0;
            font-size: 0.85em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .section {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border-radius: 12px;
            border: 1px solid #0f3460;
            margin-bottom: 20px;
            overflow: hidden;
        }
        .section-header {
            padding: 15px 20px;
            background: rgba(15, 52, 96, 0.5);
            border-bottom: 1px solid #0f3460;
            font-size: 1.1em;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .section-body { padding: 0; }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #0f3460;
        }
        th {
            background: rgba(15, 52, 96, 0.3);
            color: #e94560;
            font-weight: 600;
            text-transform: uppercase;
            font-size: 0.8em;
            letter-spacing: 1px;
        }
        td { color: #ccd6f6; font-size: 0.9em; }
        tr:hover td { background: rgba(233, 69, 96, 0.05); }
        .badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 20px;
            font-size: 0.75em;
            font-weight: 600;
            text-transform: uppercase;
        }
        .badge-tcp { background: rgba(46, 213, 115, 0.2); color: #2ed573; }
        .badge-udp { background: rgba(30, 144, 255, 0.2); color: #1e90ff; }
        .badge-mux { background: rgba(255, 165, 2, 0.2); color: #ffa502; }
        .badge-active { background: rgba(46, 213, 115, 0.2); color: #2ed573; }
        .badge-inactive { background: rgba(255, 71, 87, 0.2); color: #ff4757; }
        .status-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 6px;
            animation: pulse 2s infinite;
        }
        .status-online { background: #2ed573; }
        .status-offline { background: #ff4757; }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .refresh-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: #1a1a2e;
            border-top: 1px solid #0f3460;
            padding: 10px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.85em;
        }
        .refresh-btn {
            background: #e94560;
            color: white;
            border: none;
            padding: 8px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background 0.2s;
        }
        .refresh-btn:hover { background: #c73651; }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: #8892b0;
        }
        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .header h1 { font-size: 1.5em; }
        }
    </style>
    <script>
        setInterval(function() { location.reload(); }, 5000);
    </script>
</head>
<body>
    <div class="header">
        <h1>Server Statistics Dashboard</h1>
        <p>Real-time monitoring of all connections and traffic</p>
    </div>
    <div class="container">
        <div class="stats-grid">
            <div class="stat-card">
                <div class="icon">&#128202;</div>
                <div class="value">${globalStats.totalConnections}</div>
                <div class="label">Total Connections</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128308;</div>
                <div class="value">${globalStats.activeConnections}</div>
                <div class="label">Active Connections</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128256;</div>
                <div class="value">${globalStats.totalStreams}</div>
                <div class="label">Total Streams</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#9889;</div>
                <div class="value">${globalStats.activeStreams}</div>
                <div class="label">Active Streams</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128228;</div>
                <div class="value">${(globalStats.totalBytesTx / 1024 / 1024).toFixed(2)} MB</div>
                <div class="label">Total Sent</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128229;</div>
                <div class="value">${(globalStats.totalBytesRx / 1024 / 1024).toFixed(2)} MB</div>
                <div class="label">Total Received</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128336;</div>
                <div class="value">${uptimeStr}</div>
                <div class="label">Uptime</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128274;</div>
                <div class="value">${WSPATH}</div>
                <div class="label">WS Path</div>
            </div>
        </div>
        <div class="section">
            <div class="section-header">
                <span>&#127760;</span>
                <span>Active Connections</span>
            </div>
            <div class="section-body">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th>Streams</th>
                            <th>Target</th>
                            <th>Protocol</th>
                        </tr>
                    </thead>
                    <tbody>
`;

  let hasActive = false;
  const now = Date.now();
  for (const conn of globalStats.connections.values()) {
    if (!conn.active) continue;
    hasActive = true;
    const duration = Math.floor((now - conn.startTime) / 1000);
    const dH = Math.floor(duration / 3600);
    const dM = Math.floor((duration % 3600) / 60);
    const dS = duration % 60;
    const durStr = `${String(dH).padStart(2, '0')}:${String(dM).padStart(2, '0')}:${String(dS).padStart(2, '0')}`;

    html += `
                        <tr>
                            <td>#${conn.id}</td>
                            <td><span class="status-dot status-online"></span>Active</td>
                            <td>${durStr}</td>
                            <td>${conn.streams || 0}</td>
                            <td>${conn.lastHost || '-'}</td>
                            <td><span class="badge badge-${(conn.lastProto || 'tcp').toLowerCase()}">${conn.lastProto || '-'}</span></td>
                        </tr>
`;
  }

  if (!hasActive) {
    html += `
                        <tr>
                            <td colspan="6" class="empty-state">No active connections</td>
                        </tr>
`;
  }

  html += `
                    </tbody>
                </table>
            </div>
        </div>
        <div class="section">
            <div class="section-header">
                <span>&#128220;</span>
                <span>Recent Connection History</span>
            </div>
            <div class="section-body">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th>Streams</th>
                            <th>Target</th>
                            <th>Protocol</th>
                        </tr>
                    </thead>
                    <tbody>
`;

  let historyCount = 0;
  for (let i = globalStats.connectionHistory.length - 1; i >= 0; i--) {
    if (historyCount >= 20) break;
    const conn = globalStats.connectionHistory[i];
    if (!conn) continue;
    historyCount++;
    const duration = Math.floor(((conn.endTime || now) - conn.startTime) / 1000);
    const dH = Math.floor(duration / 3600);
    const dM = Math.floor((duration % 3600) / 60);
    const dS = duration % 60;
    const durStr = `${String(dH).padStart(2, '0')}:${String(dM).padStart(2, '0')}:${String(dS).padStart(2, '0')}`;

    html += `
                        <tr>
                            <td>#${conn.id || i}</td>
                            <td><span class="status-dot status-offline"></span>Closed</td>
                            <td>${durStr}</td>
                            <td>${conn.streams || 0}</td>
                            <td>${conn.lastHost || '-'}</td>
                            <td><span class="badge badge-${(conn.lastProto || 'tcp').toLowerCase()}">${conn.lastProto || '-'}</span></td>
                        </tr>
`;
  }

  if (historyCount === 0) {
    html += `
                        <tr>
                            <td colspan="6" class="empty-state">No connection history</td>
                        </tr>
`;
  }

  html += `
                    </tbody>
                </table>
            </div>
        </div>
    </div>
    <div class="refresh-bar">
        <span>Auto-refresh every 5 seconds</span>
        <button class="refresh-btn" onclick="location.reload()">Refresh Now</button>
    </div>
</body>
</html>`;
  return html;
}

function log(level, msg) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  console.log(`[${timeStr}][${level}] ${msg}`);
}

function isBlockedDomain(host) {
  if (!host) return false;
  const hl = host.toLowerCase();
  for (const blocked of BLOCKED_DOMAINS) {
    if (hl === blocked || hl.endsWith('.' + blocked)) return true;
  }
  return false;
}

// ==========================================
// DNS CACHE & QUEUE LOGIC
// ==========================================
const dnsCache = new Map();
const dnsPending = new Map();

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [host, entry] of dnsCache) {
    if (now >= entry.expires) dnsCache.delete(host);
  }
}, DNS_SWEEP * 1000);

function resolveAndSend(sock, payload, port, host, callback) {
  if (!host || host === '') return callback && callback('Empty Host');

  function safeSend(h) {
    if (!sock) return;
    sock.send(payload, port, h, callback);
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return safeSend(host);
  }

  const now = Math.floor(Date.now() / 1000);
  const entry = dnsCache.get(host);
  if (entry && now < entry.expires) {
    return safeSend(entry.address);
  }

  if (dnsPending.has(host)) {
    dnsPending.get(host).push({ payload, port, callback });
    return;
  }

  dnsPending.set(host, [{ payload, port, callback }]);

  dns.resolve4(host, (err, addresses) => {
    const queue = dnsPending.get(host);
    dnsPending.delete(host);

    if (!err && addresses && addresses[0]) {
      const addr = addresses[0];
      dnsCache.set(host, { address: addr, expires: now + DNS_TTL });
      if (queue) {
        for (const item of queue) {
          try {
            sock.send(item.payload, item.port, addr, item.callback);
          } catch (e) { /* ignore */ }
        }
      }
    } else {
      log('WARN', 'DNS Resolution Failed: ' + host);
      if (queue) {
        for (const item of queue) {
          if (item.callback) item.callback(err || 'Resolution Failed');
        }
      }
    }
  });
}

// ==========================================
// WEBSOCKET CODEC (Manual, Zero-Allocation Hot Path)
// ==========================================
function createWsCodec() {
  const DEC_BUF_SIZE = 65536;
  const decBuf = Buffer.allocUnsafe(DEC_BUF_SIZE);
  const decMask = Buffer.allocUnsafe(4);
  const outBuf = Buffer.allocUnsafe(65546);
  const muxBuf = Buffer.allocUnsafe(66000);

  function decodeWsFrame(buffer) {
    const blen = buffer.length;
    if (blen < 2) return null;

    const b1 = buffer[0];
    const b2 = buffer[1];
    const fin = (b1 >>> 7) === 1;
    const opcode = b1 & 0x0f;
    const masked = (b2 >>> 7) === 1;
    let payloadLen = b2 & 0x7f;

    let headerLen = 2;
    if (payloadLen === 126) {
      if (blen < 4) return null;
      payloadLen = (buffer[2] << 8) | buffer[3];
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (blen < 10) return null;
      // skip first 4 bytes of 64-bit length, use last 4
      payloadLen = (buffer[6] << 24) | (buffer[7] << 16) | (buffer[8] << 8) | buffer[9];
      headerLen = 10;
    }

    if (masked) {
      if (blen < headerLen + 4) return null;
      buffer.copy(decMask, 0, headerLen, headerLen + 4);
      headerLen += 4;
    }

    if (blen < headerLen + payloadLen) return null;

    let payload;
    if (masked && payloadLen > 0) {
      if (payloadLen <= DEC_BUF_SIZE) {
        buffer.copy(decBuf, 0, headerLen, headerLen + payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          decBuf[i] = decBuf[i] ^ decMask[i & 3];
        }
        payload = decBuf.subarray(0, payloadLen);
      } else {
        const tmp = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          tmp[i] = buffer[headerLen + i] ^ decMask[i & 3];
        }
        payload = tmp;
      }
    } else {
      payload = buffer.subarray(headerLen, headerLen + payloadLen);
    }

    return { fin, opcode, payload, consumed: headerLen + payloadLen };
  }

  function encodeWsFrame(opcode, payload) {
    const plen = payload.length;
    let total = 0;

    if (plen <= 125) {
      total = 2 + plen;
      outBuf[0] = 0x80 | (opcode & 0x0f);
      outBuf[1] = plen;
    } else if (plen <= 65535) {
      total = 4 + plen;
      outBuf[0] = 0x80 | (opcode & 0x0f);
      outBuf[1] = 126;
      outBuf[2] = plen >>> 8;
      outBuf[3] = plen & 0xff;
    } else {
      total = 10 + plen;
      outBuf[0] = 0x80 | (opcode & 0x0f);
      outBuf[1] = 127;
      outBuf[2] = 0; outBuf[3] = 0; outBuf[4] = 0; outBuf[5] = 0;
      outBuf[6] = (plen >>> 24) & 0xff;
      outBuf[7] = (plen >>> 16) & 0xff;
      outBuf[8] = (plen >>> 8) & 0xff;
      outBuf[9] = plen & 0xff;
    }

    if (plen > 0) {
      payload.copy(outBuf, total - plen);
    }

    return outBuf.subarray(0, total);
  }

  // Combined Mux + WS frame encoder: single Buffer allocation
  function sendMuxFrame(opcode, meta, hasData, payload) {
    const metaLen = meta.length;
    const dataLen = hasData ? payload.length : 0;
    const muxTotal = 2 + metaLen + (hasData ? (2 + dataLen) : 0);

    // Write Mux body into muxBuf
    muxBuf[0] = (metaLen >>> 8) & 0xff;
    muxBuf[1] = metaLen & 0xff;
    if (metaLen > 0) meta.copy(muxBuf, 2);

    if (hasData) {
      muxBuf[2 + metaLen] = (dataLen >>> 8) & 0xff;
      muxBuf[3 + metaLen] = dataLen & 0xff;
      if (dataLen > 0) {
        payload.copy(muxBuf, 4 + metaLen);
      }
    }

    const payloadLen = muxTotal;
    let wsHeaderLen = 0;

    if (payloadLen <= 125) {
      wsHeaderLen = 2;
      outBuf[0] = 0x80 | (opcode & 0x0f);
      outBuf[1] = payloadLen;
    } else if (payloadLen <= 65535) {
      wsHeaderLen = 4;
      outBuf[0] = 0x80 | (opcode & 0x0f);
      outBuf[1] = 126;
      outBuf[2] = payloadLen >>> 8;
      outBuf[3] = payloadLen & 0xff;
    } else {
      wsHeaderLen = 10;
      outBuf[0] = 0x80 | (opcode & 0x0f);
      outBuf[1] = 127;
      outBuf[2] = 0; outBuf[3] = 0; outBuf[4] = 0; outBuf[5] = 0;
      outBuf[6] = (payloadLen >>> 24) & 0xff;
      outBuf[7] = (payloadLen >>> 16) & 0xff;
      outBuf[8] = (payloadLen >>> 8) & 0xff;
      outBuf[9] = payloadLen & 0xff;
    }

    muxBuf.copy(outBuf, wsHeaderLen, 0, payloadLen);
    const total = wsHeaderLen + payloadLen;

    return outBuf.subarray(0, total);
  }

  return {
    decode: decodeWsFrame,
    encode: encodeWsFrame,
    sendMux: sendMuxFrame
  };
}

// ==========================================
// SHA1 + BASE64 (Handshake only, use Node crypto)
// ==========================================
function getAcceptKey(key) {
  const combined = key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  return crypto.createHash('sha1').update(combined).digest('base64');
}

// ==========================================
// HTTP RESPONSE HELPERS
// ==========================================
function sendHttpResponse(client, status, contentType, body) {
  const statusTextMap = {
    200: 'OK',
    404: 'Not Found',
    301: 'Moved Permanently',
    302: 'Found',
    400: 'Bad Request'
  };
  const statusText = statusTextMap[status] || 'OK';

  const headers = `HTTP/1.1 ${status} ${statusText}\r\n` +
                  `Content-Type: ${contentType}\r\n` +
                  `Content-Length: ${body.length}\r\n` +
                  `Connection: close\r\n` +
                  `Cache-Control: no-cache, no-store, must-revalidate\r\n` +
                  `\r\n`;

  try {
    client.write(headers + body);
  } catch (e) { /* ignore */ }
}

function sendRedirect(client, location) {
  const body = '<html><body>Redirecting...</body></html>';
  const headers = `HTTP/1.1 302 Found\r\n` +
                  `Location: ${location}\r\n` +
                  `Content-Type: text/html\r\n` +
                  `Content-Length: ${body.length}\r\n` +
                  `Connection: close\r\n` +
                  `\r\n`;
  try {
    client.write(headers + body);
  } catch (e) { /* ignore */ }
}

// ==========================================
// SERVER HANDLER
// ==========================================
let connectionCounter = 0;

const server = net.createServer((client) => {
  let state = 'HTTP';

  // Per-connection zero-allocation buffers
  const bufferDb = newDataBuffer();
  const wsStreamDb = newDataBuffer();
  const udpDb = newDataBuffer();
  const muxDb = newDataBuffer();
  const tcpDb = newDataBuffer();

  let target = null;
  let udpSocket = null;

  let targetHost = '';
  let targetPort = 0;
  let dead = false;
  let vlsStarted = false;
  let isMux = false;

  let tcpConnected = false;

  const muxTcpStreams = new Map();
  const muxUdpSockets = new Map();
  const muxUdpTargets = new Map();

  const muxStats = new Map();
  let udpTx = 0;
  let udpRx = 0;

  // Connection tracking (lockless)
  connectionCounter += 1;
  const myConnId = connectionCounter;
  const myConnInfo = {
    id: myConnId,
    active: true,
    startTime: Date.now(),
    streams: 0,
    lastHost: '',
    lastProto: 'TCP',
    bytesTx: 0,
    bytesRx: 0
  };
  globalStats.connections.set(myConnId, myConnInfo);
  globalStats.totalConnections += 1;
  globalStats.activeConnections += 1;

  // Per-connection codec with reusable buffers
  const wsCodec = createWsCodec();

  function initStats(id, proto, host, port) {
    muxStats.set(id, {
      proto, host, port,
      txPackets: 0, txBytes: 0,
      rxPackets: 0, rxBytes: 0,
      startTime: Date.now()
    });
    myConnInfo.streams += 1;
    myConnInfo.lastHost = `${host}:${port}`;
    myConnInfo.lastProto = proto;
    globalStats.totalStreams += 1;
    globalStats.activeStreams += 1;
    if (proto === 'TCP') globalStats.tcpStreams += 1;
    else if (proto === 'UDP') globalStats.udpStreams += 1;
  }

  function updateTx(id, bytes) {
    const s = muxStats.get(id);
    if (s) { s.txPackets += 1; s.txBytes += (bytes || 0); }
    myConnInfo.bytesTx += (bytes || 0);
    globalStats.totalBytesTx += (bytes || 0);
  }

  function updateRx(id, bytes) {
    const s = muxStats.get(id);
    if (s) { s.rxPackets += 1; s.rxBytes += (bytes || 0); }
    myConnInfo.bytesRx += (bytes || 0);
    globalStats.totalBytesRx += (bytes || 0);
  }

  function logStatsEnd(id) {
    const s = muxStats.get(id);
    if (!s) return;
    muxStats.delete(id);
    globalStats.activeStreams -= 1;
    if (s.proto === 'TCP') globalStats.tcpStreams -= 1;
    else if (s.proto === 'UDP') globalStats.udpStreams -= 1;
  }

  function destroyMuxId(id) {
    const st = muxTcpStreams.get(id);
    if (st) {
      if (st.handle) {
        st.handle.removeAllListeners('data');
        st.handle.removeAllListeners('drain');
        st.handle.removeAllListeners('error');
        st.handle.removeAllListeners('close');
      }
      if (st.buffer) dbClear(st.buffer);
      try { st.handle.destroy(); } catch (e) {}
      muxTcpStreams.delete(id);
    }
    const udp = muxUdpSockets.get(id);
    if (udp) {
      udp.removeAllListeners('message');
      udp.removeAllListeners('error');
      try { udp.close(); } catch (e) {}
      muxUdpSockets.delete(id);
    }
    muxUdpTargets.delete(id);
  }

  function destroy(reason) {
    if (dead) return;
    dead = true;

    // Remove all listeners on main sockets to break closure cycles
    if (client) {
      client.removeAllListeners('data');
      client.removeAllListeners('drain');
      client.removeAllListeners('error');
      client.removeAllListeners('close');
    }
    if (target) {
      target.removeAllListeners('data');
      target.removeAllListeners('drain');
      target.removeAllListeners('error');
      target.removeAllListeners('close');
    }
    if (udpSocket) {
      udpSocket.removeAllListeners('message');
      udpSocket.removeAllListeners('error');
    }

    try { client.destroy(); } catch (e) {}
    if (target) { try { target.destroy(); } catch (e) {} target = null; }
    if (udpSocket) { try { udpSocket.close(); } catch (e) {} udpSocket = null; }

    for (const [k] of muxTcpStreams) { logStatsEnd(k); destroyMuxId(k); }
    for (const [k] of muxUdpSockets) { logStatsEnd(k); destroyMuxId(k); }

    // Update global stats
    globalStats.activeConnections -= 1;
    const connInfo = globalStats.connections.get(myConnId);
    if (connInfo) {
      connInfo.active = false;
      connInfo.endTime = Date.now();
      globalStats.connectionHistory.push(connInfo);
      if (globalStats.connectionHistory.length > 100) {
        globalStats.connectionHistory.shift();
      }
      globalStats.connections.delete(myConnId);
    }

    // Aggressive cleanup
    // bufferDb, wsStreamDb, udpDb, muxDb, tcpDb will be GC'd when function exits
    // we null them to break potential references faster
  }

  client.on('error', (err) => destroy('Client Error: ' + err));
  client.on('close', () => destroy());
  client.on('drain', () => {
    if (dead) return;
    if (target) target.resume();
    for (const [, st] of muxTcpStreams) {
      if (st.handle) st.handle.resume();
    }
  });

  // Optimized send using codec encode, returns false on backpressure
  function sendWs(opcode, payload) {
    if (dead) return true;
    return client.write(wsCodec.encode(opcode, payload));
  }

  // Combined Mux + WS frame send for zero double-allocation
  function sendMuxMeta(meta, hasData, payload) {
    if (dead || client.destroyed) return true;
    return client.write(wsCodec.sendMux(2, meta, hasData, payload));
  }

  function tryParseVls(payload) {
    if (payload.length < 18) return null;
    if (payload[0] !== 0) return [false, 'Bad Version'];
    // compare 16 bytes UUID
    for (let i = 0; i < 16; i++) {
      if (payload[1 + i] !== TARGET_UUID_BYTES[i]) return [false, 'UUID Mismatch'];
    }

    const optLen = payload[17];
    let pos = 18 + optLen;
    if (payload.length < pos) return null;

    const cmd = payload[pos];
    pos += 1;

    if (cmd === 3) {
      return [true, cmd, '0.0.0.0', 0, pos];
    }

    if (payload.length < pos + 3) return null;
    const parsedPort = (payload[pos] << 8) | payload[pos + 1];
    pos += 2;

    const atyp = payload[pos];
    pos += 1;
    let parsedHost = '';

    if (atyp === 0x01) {
      if (payload.length < pos + 4) return null;
      parsedHost = `${payload[pos]}.${payload[pos+1]}.${payload[pos+2]}.${payload[pos+3]}`;
      pos += 4;
    } else if (atyp === 0x02) {
      if (payload.length < pos) return null;
      const hlen = payload[pos];
      pos += 1;
      if (payload.length < pos + hlen) return null;
      parsedHost = payload.toString('utf8', pos, pos + hlen);
      pos += hlen;
    } else if (atyp === 0x03) {
      if (payload.length < pos + 16) return null;
      const parts = [];
      for (let j = 0; j < 8; j++) {
        parts.push(((payload[pos + j*2] << 8) | payload[pos + j*2 + 1]).toString(16));
      }
      parsedHost = parts.join(':');
      pos += 16;
    } else if (atyp === 0x00) {
      parsedHost = '0.0.0.0';
    } else {
      return [false, `Unknown ATYP: ${atyp}`];
    }

    if (isBlockedDomain(parsedHost)) return [false, 'Blocked Domain: ' + parsedHost];
    if (cmd !== 1 && cmd !== 2) return [false, `Unknown Command: ${cmd}`];

    return [true, cmd, parsedHost, parsedPort, pos];
  }

  function processWsUdp(data) {
    if (data) dbAppend(udpDb, data);
    while (true) {
      const buf = dbToBuffer(udpDb);
      if (buf.length < 2) break;
      const len = (buf[0] << 8) | buf[1];
      if (buf.length >= 2 + len) {
        const packet = buf.subarray(2, 2 + len);
        dbConsume(udpDb, 2 + len);
        resolveAndSend(udpSocket, packet, targetPort, targetHost, (err) => {
          if (!err) udpTx += 1;
        });
      } else break;
    }
  }

  // Inline safe byte read helper
  function mbyte(meta, idx) {
    return (idx < meta.length) ? meta[idx] : 0;
  }

  // Optimized Mux frame response builder using combined wsCodec
  function processMuxBuffer() {
    while (true) {
      const buf = dbToBuffer(muxDb);
      if (buf.length < 4) break;

      const metaLen = (buf[0] << 8) | buf[1];

      if (metaLen < 4 || metaLen > 65535) {
        log('MUX-ERR', 'Invalid metaLen: ' + metaLen + ', dropping malformed frame');
        dbConsume(muxDb, 1);
        break;
      }

      if (buf.length < 2 + metaLen) break;

      const meta = buf.subarray(2, 2 + metaLen);

      if (meta.length < 4) {
        log('MUX-ERR', 'Meta too short: ' + meta.length + ' bytes');
        dbConsume(muxDb, 3);
        break;
      }

      const b1 = meta[0];
      const b2 = meta[1];
      const b3 = meta[2];
      const b4 = meta[3];
      const id = (b1 << 8) | b2;
      const mCmd = b3;
      const hasData = (b4 & 1) === 1;
      let dataLen = 0;

      if (hasData) {
        if (buf.length < 2 + metaLen + 2) break;
        dataLen = (buf[2 + metaLen] << 8) | buf[3 + metaLen];
        if (buf.length < 2 + metaLen + 2 + dataLen) break;
      }

      let data = Buffer.alloc(0);
      if (hasData) {
        data = buf.subarray(4 + metaLen, 4 + metaLen + dataLen);
      }

      // Consume the parsed frame
      const frameLen = 2 + metaLen + (hasData ? (2 + dataLen) : 0);
      dbConsume(muxDb, frameLen);

      if (mCmd === 1) { // New Sub-connection
        const network = mbyte(meta, 4);
        const port = (mbyte(meta, 5) << 8) | mbyte(meta, 6);
        const atyp = mbyte(meta, 7);
        let host = '';

        if (metaLen < 8) {
          log('MUX-ERR', `[${id}] Meta too short for address parsing: ${metaLen} bytes`);
          break;
        }

        if (atyp === 1) {
          if (metaLen < 12) {
            log('MUX-ERR', `[${id}] IPv4 address truncated in meta`);
            break;
          }
          host = `${mbyte(meta, 8)}.${mbyte(meta, 9)}.${mbyte(meta, 10)}.${mbyte(meta, 11)}`;
        } else if (atyp === 2) {
          const hlen = mbyte(meta, 8);
          if (hlen > 0 && metaLen >= 8 + 1 + hlen) {
            host = meta.toString('utf8', 9, 9 + hlen);
          } else {
            log('MUX-ERR', `[${id}] Domain length truncated: hlen=${hlen}, metaLen=${metaLen}`);
            break;
          }
        } else if (atyp === 3) {
          if (metaLen < 24) {
            log('MUX-ERR', `[${id}] IPv6 address truncated in meta`);
            break;
          }
          const p = [];
          for (let j = 0; j < 8; j++) {
            p.push(((mbyte(meta, 8 + j*2) << 8) | mbyte(meta, 9 + j*2)).toString(16));
          }
          host = p.join(':');
        } else {
          log('MUX-ERR', `[${id}] Unknown ATYP ${atyp} in New Sub-connection, rejecting`);
          break;
        }

        if (network === 1) { // TCP Mux
          initStats(id, 'TCP', host, port);
          log('MUX-TCP', `Multiplexed TCP connecting to ${host}:${port}`);
          const stream = { handle: null, connected: false, buffer: newDataBuffer() };
          muxTcpStreams.set(id, stream);

          stream.handle = net.createConnection({ host, port }, () => {
            stream.connected = true;
            const stbuf = dbToBuffer(stream.buffer);
            if (stbuf.length > 0) {
              updateTx(id, stbuf.length);
              try { stream.handle.write(stbuf); } catch (e) {}
              dbClear(stream.buffer);
            }
          });
          stream.handle.on('data', (reply) => {
            if (dead) return;
            updateRx(id, reply.length);
            const metaBuf = Buffer.from([
              (id >>> 8) & 0xff, id & 0xff,
              2, 1 // status keep, has data
            ]);
            if (!sendMuxMeta(metaBuf, true, reply)) {
              stream.handle.pause();
            }
          });
          stream.handle.on('close', () => {
            if (dead) return;
            const metaBuf = Buffer.from([
              (id >>> 8) & 0xff, id & 0xff,
              3, 0 // end, no data
            ]);
            sendMuxMeta(metaBuf, false, Buffer.alloc(0));
            logStatsEnd(id);
            destroyMuxId(id);
          });
          stream.handle.on('error', (e) => {
            log('MUX-ERR', `[${id}][TCP] Error: ${e}`);
            logStatsEnd(id);
            destroyMuxId(id);
          });

        } else if (network === 2) { // UDP Mux / XUDP Initialization
          initStats(id, 'UDP', host, port);
          log('MUX-UDP', `Multiplexed UDP initialized for target ${host}:${port}`);
          const u = dgram.createSocket('udp4');
          u.bind(0, '0.0.0.0');
          muxUdpSockets.set(id, u);
          muxUdpTargets.set(id, { host, port });

          u.on('message', (reply, rinfo) => {
            if (dead) return;
            udpRx += 1;
            updateRx(id, reply.length);
            const cleanIp = (rinfo.address || rinfo.ip || '0.0.0.0').replace(/^::ffff:/, '');
            const m = cleanIp.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
            let mMeta;
            if (m) {
              mMeta = Buffer.from([
                (id >>> 8) & 0xff, id & 0xff,
                2, 1, 2, // status keep, has data, UDP
                (rinfo.port >>> 8) & 0xff, rinfo.port & 0xff,
                1,
                parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)
              ]);
            } else {
              mMeta = Buffer.from([
                (id >>> 8) & 0xff, id & 0xff,
                2, 1 // status keep, has data
              ]);
            }
            sendMuxMeta(mMeta, true, reply);
          });
          u.on('error', (e) => {
            log('MUX-ERR', `[${id}][UDP] Socket Error: ${e}`);
            logStatsEnd(id);
            destroyMuxId(id);
          });

          if (hasData && data.length > 0) {
            updateTx(id, data.length);
            resolveAndSend(u, data, port, host, (err) => {
              if (!err) udpTx += 1;
            });
          }
        } else {
          log('MUX-ERR', `[${id}] Unknown network type: ${network}`);
        }

      } else if (mCmd === 2) { // Keep Sub-connection (Data Transfer)
        if (metaLen > 4) {
          const network = mbyte(meta, 4);

          if (network === 2) {
            if (metaLen < 8) {
              log('MUX-ERR', `[${id}] Keep meta too short for UDP address: ${metaLen} bytes`);
              break;
            }

            const port = (mbyte(meta, 5) << 8) | mbyte(meta, 6);
            const atyp = mbyte(meta, 7);
            let host = '';

            if (atyp === 1) {
              if (metaLen < 12) {
                log('MUX-ERR', `[${id}] Keep IPv4 address truncated`);
                break;
              }
              host = `${mbyte(meta, 8)}.${mbyte(meta, 9)}.${mbyte(meta, 10)}.${mbyte(meta, 11)}`;
            } else if (atyp === 2) {
              const hlen = mbyte(meta, 8);
              if (hlen > 0 && metaLen >= 8 + 1 + hlen) {
                host = meta.toString('utf8', 9, 9 + hlen);
              } else {
                log('MUX-ERR', `[${id}] Keep domain truncated: hlen=${hlen}, metaLen=${metaLen}`);
                break;
              }
            } else if (atyp === 3) {
              if (metaLen < 24) {
                log('MUX-ERR', `[${id}] Keep IPv6 address truncated`);
                break;
              }
              const p = [];
              for (let j = 0; j < 8; j++) {
                p.push(((mbyte(meta, 8 + j*2) << 8) | mbyte(meta, 9 + j*2)).toString(16));
              }
              host = p.join(':');
            } else {
              log('MUX-ERR', `[${id}] Unknown ATYP ${atyp} in Keep, rejecting`);
              break;
            }

            muxUdpTargets.set(id, { host, port });

            if (muxStats.has(id)) {
              const s = muxStats.get(id);
              s.host = host;
              s.port = port;
            } else {
              initStats(id, 'UDP', host, port);
            }

            if (!muxUdpSockets.has(id)) {
              const u = dgram.createSocket('udp4');
              u.bind(0, '0.0.0.0');
              muxUdpSockets.set(id, u);
              u.on('message', (reply, rinfo) => {
                if (dead) return;
                udpRx += 1;
                updateRx(id, reply.length);
                const cleanIp = (rinfo.address || rinfo.ip || '0.0.0.0').replace(/^::ffff:/, '');
                const m = cleanIp.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
                let mMeta;
                if (m) {
                  mMeta = Buffer.from([
                    (id >>> 8) & 0xff, id & 0xff,
                    2, 1, 2,
                    (rinfo.port >>> 8) & 0xff, rinfo.port & 0xff,
                    1,
                    parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)
                  ]);
                } else {
                  mMeta = Buffer.from([
                    (id >>> 8) & 0xff, id & 0xff,
                    2, 1
                  ]);
                }
                sendMuxMeta(mMeta, true, reply);
              });
              u.on('error', (e) => {
                log('MUX-ERR', `[${id}][UDP-Keep] Socket Error: ${e}`);
                logStatsEnd(id);
                destroyMuxId(id);
              });
            }
          }
        }

        if (muxTcpStreams.has(id) && hasData && data.length > 0) {
          const st = muxTcpStreams.get(id);
          updateTx(id, data.length);
          if (st.connected) {
            st.handle.write(data);
          } else {
            dbAppend(st.buffer, data);
          }
        } else if (muxUdpSockets.has(id) && muxUdpTargets.has(id) && hasData && data.length > 0) {
          const tgt = muxUdpTargets.get(id);
          updateTx(id, data.length);
          resolveAndSend(muxUdpSockets.get(id), data, tgt.port, tgt.host, (err) => {
            if (!err) udpTx += 1;
          });
        }

      } else if (mCmd === 3) { // End Sub-connection
        logStatsEnd(id);
        destroyMuxId(id);
      } else {
        log('MUX-ERR', `[${id}] Unknown Mux command: ${mCmd}`);
      }
    }
  }

  client.on('data', (chunk) => {
    dbAppend(bufferDb, chunk);

    if (state === 'HTTP') {
      const buf = dbToBuffer(bufferDb);
      const eoh = buf.indexOf(Buffer.from('\r\n\r\n'));
      if (eoh === -1) return;

      const headerStr = buf.subarray(0, eoh + 4).toString('utf8');
      dbConsume(bufferDb, eoh + 4);

      const lines = headerStr.split('\r\n');
      const reqLine = lines[0];
      if (!reqLine) return destroy('Invalid HTTP');

      const reqParts = reqLine.split(' ');
      const method = reqParts[0];
      const path = reqParts[1];

      const headers = {};
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          headers[key] = value;
        }
      }

      if (method === 'GET' && path === '/admin-stats') {
        const html = generateStatsHtml();
        sendHttpResponse(client, 200, 'text/html; charset=utf-8', html);
        return destroy('Admin stats served');
      }

      if (method === 'GET' && headers['upgrade'] && headers['upgrade'].toLowerCase() === 'websocket') {
        if (!path.includes('/' + WSPATH)) {
          sendHttpResponse(client, 200, 'text/html; charset=utf-8', FAKE_INDEX_HTML);
          return destroy('Bad WS Path - served fake page');
        }
        const key = headers['sec-websocket-key'];
        if (!key) {
          sendHttpResponse(client, 400, 'text/html; charset=utf-8', FAKE_INDEX_HTML);
          return destroy('No WS Key - served fake page');
        }

        const accept = getAcceptKey(key);
        const responseHeaders = `HTTP/1.1 101 Switching Protocols\r\n` +
                                `Upgrade: websocket\r\n` +
                                `Connection: Upgrade\r\n` +
                                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
        client.write(responseHeaders);
        state = 'WS';
      } else {
        sendHttpResponse(client, 200, 'text/html; charset=utf-8', FAKE_INDEX_HTML);
        return destroy('Not WS Request - served fake page');
      }
    }

    if (state === 'WS') {
      while (true) {
        const buf = dbToBuffer(bufferDb);
        if (buf.length === 0) break;
        const msg = wsCodec.decode(buf);
        if (!msg) break;
        dbConsume(bufferDb, msg.consumed);

        if (msg.opcode === 8) { // close
          return destroy('Client Triggered WS Close');
        } else if (msg.opcode === 9) { // ping
          sendWs(10, msg.payload);
        } else if (msg.opcode === 1 || msg.opcode === 2 || msg.opcode === 0) { // text, binary, continuation
          let finalPayload = null;
          if (msg.opcode !== 0) {
            if (msg.fin) {
              finalPayload = msg.payload;
            } else {
              dbAppend(wsStreamDb, msg.payload);
            }
          } else {
            dbAppend(wsStreamDb, msg.payload);
            if (msg.fin) {
              finalPayload = dbToBuffer(wsStreamDb);
              dbClear(wsStreamDb);
            }
          }

          if (finalPayload) {
            if (!vlsStarted) {
              dbAppend(wsStreamDb, finalPayload);
              const parseBuf = dbToBuffer(wsStreamDb);
              const result = tryParseVls(parseBuf);

              if (result === null) {
                finalPayload = null;
              } else if (result[0] === false) {
                dbClear(wsStreamDb);
                sendHttpResponse(client, 200, 'text/html; charset=utf-8', FAKE_INDEX_HTML);
                return destroy('vls Auth Failed -> ' + result[1]);
              } else {
                vlsStarted = true;
                globalStats.muxSessions += 1;
                targetHost = result[2];
                targetPort = result[3];
                const headerEnd = result[4];

                sendWs(2, Buffer.from([0x00, 0x00]));

                const initialData = parseBuf.subarray(headerEnd);
                dbClear(wsStreamDb);

                if (result[1] === 1) {
                  log('TCP', 'Tunnel connecting to ' + targetHost + ':' + targetPort);
                  if (initialData.length > 0) dbAppend(tcpDb, initialData);
                  target = net.createConnection({ host: targetHost, port: targetPort }, () => {
                    tcpConnected = true;
                    const tbuf = dbToBuffer(tcpDb);
                    if (tbuf.length > 0) {
                      if (!target.write(tbuf)) client.pause();
                      dbClear(tcpDb);
                    }
                  });
                  target.on('data', (d) => {
                    if (!sendWs(2, d)) target.pause();
                  });
                  target.on('drain', () => client.resume());
                  target.on('close', () => destroy('TCP Target Closed'));
                  target.on('error', (e) => destroy('TCP Target Error: ' + e));

                } else if (result[1] === 2) {
                  log('UDP', 'Legacy UDP Session Started: ' + targetHost + ':' + targetPort);
                  udpSocket = dgram.createSocket('udp4');
                  udpSocket.bind(0, '0.0.0.0');
                  udpSocket.on('message', (reply) => {
                    udpRx += 1;
                    const len = reply.length;
                    const prefix = Buffer.from([Math.floor(len / 256) % 256, len % 256]);
                    sendWs(2, Buffer.concat([prefix, reply]));
                  });
                  udpSocket.on('error', (e) => destroy('UDP Socket Error: ' + e));
                  if (initialData.length > 0) processWsUdp(initialData);

                } else if (result[1] === 3) {
                  isMux = true;
                  log('MUX', 'XUDP & Mux.Cool Session Started');
                  if (initialData.length > 0) {
                    dbAppend(muxDb, initialData);
                    processMuxBuffer();
                  }
                }
              }
            } else {
              if (isMux) {
                dbAppend(muxDb, finalPayload);
                processMuxBuffer();
              } else {
                if (target) {
                  if (tcpConnected) {
                    if (!target.write(finalPayload)) client.pause();
                  } else {
                    dbAppend(tcpDb, finalPayload);
                  }
                }
                if (udpSocket) processWsUdp(finalPayload);
              }
            }
          }
        }
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n Native vls-WS Server Active on ${HOST}:${PORT}\nPath: /${WSPATH}\nUUID: ${UUID}\n`);
  console.log(` Admin Stats: http://${HOST}:${PORT}/admin-stats\n`);
});
