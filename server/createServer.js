'use strict';

/**
 * IFR Trainer core server.
 *
 * Serves the moving-map UI, bridges SimConnect (or demo) data to the browser
 * over WebSocket, records the flight track and offers GeoJSON/KML export.
 *
 * Used by both the CLI (server/index.js) and the Electron desktop app
 * (electron/main.js).
 *
 *   const { createIfrServer } = require('./createServer');
 *   const app = createIfrServer({ port: 8642, demo: false });
 *   app.listen();
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { distanceNm } = require('./geo');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LEAFLET_DIR = path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist');

const MAX_TRACK_POINTS = 100000;
const MIN_TRACK_SPACING_NM = 0.008; // ~15 m — skip points while parked
const FACILITY_PRUNE_NM = 300; // drop facilities far behind the aircraft

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/**
 * @param {object} [opts]
 * @param {number} [opts.port=8642]
 * @param {boolean} [opts.demo=false]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ server: http.Server, listen: () => Promise<number>, close: () => Promise<void>, getStatus: () => object, port: number }}
 */
function createIfrServer(opts = {}) {
  const port = Number(opts.port) || Number(process.env.PORT) || 8642;
  const demo = !!opts.demo;
  const log = opts.log || ((m) => console.log(m));

  // --- State --------------------------------------------------------------
  let lastState = null;
  let lastStatus = { connected: false, mode: demo ? 'demo' : 'sim', detail: 'Starting…' };
  const track = []; // [{t, lat, lon, alt, gs}]
  const facilities = {
    VOR: new Map(),
    NDB: new Map(),
    WAYPOINT: new Map(),
    AIRPORT: new Map(),
  };

  function facilityKey(f) {
    return `${f.ident}|${f.region}|${f.lat.toFixed(3)}|${f.lon.toFixed(3)}`;
  }

  function recordTrackPoint(state) {
    const point = {
      t: state.t,
      lat: state.lat,
      lon: state.lon,
      alt: Math.round(state.altMsl),
      gs: Math.round(state.gs),
    };
    const prev = track[track.length - 1];
    if (prev && distanceNm(prev.lat, prev.lon, point.lat, point.lon) < MIN_TRACK_SPACING_NM) {
      return null;
    }
    track.push(point);
    if (track.length > MAX_TRACK_POINTS) track.splice(0, track.length - MAX_TRACK_POINTS);
    return point;
  }

  function mergeFacilities(facilityType, items) {
    const store = facilities[facilityType];
    if (!store) return;
    for (const f of items) {
      if (!f.ident || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      store.set(facilityKey(f), f);
    }
    if (lastState && store.size > 500) {
      for (const [key, f] of store) {
        if (distanceNm(lastState.lat, lastState.lon, f.lat, f.lon) > FACILITY_PRUNE_NM) {
          store.delete(key);
        }
      }
    }
  }

  // --- Data source (SimConnect or demo) -----------------------------------
  let source;
  if (demo) {
    const { DemoSource } = require('./demoSource');
    source = new DemoSource();
  } else {
    const { SimSource } = require('./simSource');
    source = new SimSource();
  }

  source.on('status', (status) => {
    lastStatus = status;
    log(`[status] ${status.connected ? 'connected' : 'disconnected'} — ${status.detail}`);
    broadcast({ type: 'status', ...status });
  });

  source.on('state', (state) => {
    lastState = state;
    const point = recordTrackPoint(state);
    broadcast({ type: 'state', state, trackPoint: point });
  });

  source.on('facilities', ({ facilityType, items }) => {
    mergeFacilities(facilityType, items);
    broadcast({
      type: 'facilities',
      facilityType,
      items: [...facilities[facilityType].values()],
    });
  });

  // --- HTTP ---------------------------------------------------------------
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/track.geojson') {
      res.writeHead(200, {
        'Content-Type': 'application/geo+json',
        'Content-Disposition': 'attachment; filename="ifr-trainer-track.geojson"',
      });
      res.end(JSON.stringify(trackToGeoJson(), null, 1));
      return;
    }
    if (url.pathname === '/track.kml') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.google-earth.kml+xml',
        'Content-Disposition': 'attachment; filename="ifr-trainer-track.kml"',
      });
      res.end(trackToKml());
      return;
    }

    // Static files (vendor/leaflet is served straight from node_modules)
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    let rootDir = PUBLIC_DIR;
    if (filePath.startsWith('/vendor/leaflet/') || filePath.startsWith('\\vendor\\leaflet\\')) {
      rootDir = LEAFLET_DIR;
      filePath = filePath.replace(/^[/\\]vendor[/\\]leaflet/, '');
    }
    const absolute = path.join(rootDir, filePath);
    if (!absolute.startsWith(rootDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(absolute, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(absolute)] || 'application/octet-stream',
      });
      res.end(data);
    });
  });

  function trackToGeoJson() {
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            name: 'IFR Trainer flight track',
            exported: new Date().toISOString(),
            points: track.length,
          },
          geometry: {
            type: 'LineString',
            coordinates: track.map((p) => [
              Number(p.lon.toFixed(6)),
              Number(p.lat.toFixed(6)),
              Math.round(p.alt * 0.3048),
            ]),
          },
        },
      ],
    };
  }

  function trackToKml() {
    const coords = track
      .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},${Math.round(p.alt * 0.3048)}`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>IFR Trainer flight track</name>
    <Placemark>
      <name>Flight track</name>
      <Style><LineStyle><color>ffdc00c8</color><width>3</width></LineStyle></Style>
      <LineString>
        <extrude>0</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
${coords}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`;
  }

  // --- WebSocket ----------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', ...lastStatus }));
    ws.send(JSON.stringify({ type: 'track', points: track }));
    for (const [facilityType, store] of Object.entries(facilities)) {
      if (store.size > 0) {
        ws.send(JSON.stringify({ type: 'facilities', facilityType, items: [...store.values()] }));
      }
    }
    if (lastState) ws.send(JSON.stringify({ type: 'state', state: lastState, trackPoint: null }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      if (msg.type === 'clearTrack') {
        track.length = 0;
        broadcast({ type: 'track', points: [] });
      }
    });
  });

  // --- Lifecycle ----------------------------------------------------------
  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        source.start();
        resolve(port);
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      try {
        source.stop();
      } catch (_) {
        /* ignore */
      }
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (_) {
          /* ignore */
        }
      }
      server.close(() => resolve());
    });
  }

  return {
    server,
    port,
    demo,
    listen,
    close,
    getStatus: () => lastStatus,
    getState: () => lastState,
  };
}

module.exports = { createIfrServer };
