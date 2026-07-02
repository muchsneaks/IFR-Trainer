/**
 * IFR Trainer — moving map frontend.
 * Talks to the local server over WebSocket; renders aircraft, flight track
 * and the facility database (VOR/NDB/waypoints/airports) on a Leaflet map.
 */
/* global L, IfrSymbols */
(function () {
  'use strict';

  const NM_TO_M = 1852;

  // ------------------------------------------------------------------
  // Map + base layers
  // ------------------------------------------------------------------

  const map = L.map('map', {
    center: [50.03, 8.57],
    zoom: 9,
    zoomControl: true,
    worldCopyJump: true,
  });
  map.zoomControl.setPosition('bottomleft');

  const baseLayers = {
    chart: null, // plain paper background + graticule, no tiles
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }),
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }),
  };
  let activeBase = null;

  function setBase(name) {
    if (activeBase) {
      map.removeLayer(activeBase);
      activeBase = null;
    }
    document.body.classList.toggle('dark-base', name === 'dark');
    document.getElementById('map').style.background = name === 'chart' ? '#f4f1e8' : '#10141a';
    if (baseLayers[name]) {
      activeBase = baseLayers[name];
      activeBase.addTo(map);
    }
    graticule.redraw();
  }

  // Simple lat/lon graticule for the plain-chart background.
  const graticule = {
    group: L.layerGroup().addTo(map),
    redraw() {
      this.group.clearLayers();
      const baseName = document.getElementById('opt-base').value;
      if (baseName !== 'chart') return;
      const zoom = map.getZoom();
      const step = zoom >= 10 ? 0.25 : zoom >= 8 ? 0.5 : zoom >= 6 ? 1 : 5;
      const b = map.getBounds().pad(0.2);
      const style = { color: '#c9c2ae', weight: 1, interactive: false };
      for (let lat = Math.floor(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
        L.polyline([[lat, b.getWest()], [lat, b.getEast()]], style).addTo(this.group);
      }
      for (let lon = Math.floor(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
        L.polyline([[b.getSouth(), lon], [b.getNorth(), lon]], style).addTo(this.group);
      }
    },
  };
  map.on('moveend zoomend', () => graticule.redraw());

  // ------------------------------------------------------------------
  // Flight track
  // ------------------------------------------------------------------

  const trackLine = L.polyline([], {
    color: '#c800dc',
    weight: 3,
    opacity: 0.9,
    interactive: false,
  }).addTo(map);
  let trackDistanceNm = 0;

  function setTrack(points) {
    trackLine.setLatLngs(points.map((p) => [p.lat, p.lon]));
    trackDistanceNm = 0;
    for (let i = 1; i < points.length; i++) {
      trackDistanceNm += distNm(points[i - 1], points[i]);
    }
    updateTrackStats();
  }

  function appendTrackPoint(p) {
    const latlngs = trackLine.getLatLngs();
    if (latlngs.length > 0) {
      const last = latlngs[latlngs.length - 1];
      trackDistanceNm += distNm({ lat: last.lat, lon: last.lng }, p);
    }
    trackLine.addLatLng([p.lat, p.lon]);
    updateTrackStats();
  }

  function updateTrackStats() {
    const n = trackLine.getLatLngs().length;
    document.getElementById('track-stats').textContent =
      `${n} points · ${trackDistanceNm.toFixed(1)} NM`;
  }

  // ------------------------------------------------------------------
  // Aircraft + range rings + selected-fix line
  // ------------------------------------------------------------------

  let aircraftMarker = null;
  let lastState = null;

  const ringGroup = L.layerGroup().addTo(map);
  const rings = [10, 25, 50].map((nm) =>
    L.circle([0, 0], {
      radius: nm * NM_TO_M,
      color: '#8894a8',
      weight: 1,
      dashArray: '4 6',
      fill: false,
      interactive: false,
    })
  );

  const fixLine = L.polyline([], {
    color: '#38bdf8',
    weight: 1.5,
    dashArray: '6 6',
    interactive: false,
  }).addTo(map);

  function updateAircraft(state) {
    const pos = [state.lat, state.lon];
    const rotation = Number.isFinite(state.trackTrue) && state.gs > 3 ? state.trackTrue : state.hdgTrue;

    if (!aircraftMarker) {
      aircraftMarker = L.marker(pos, {
        icon: IfrSymbols.aircraftIcon(rotation),
        zIndexOffset: 1000,
        interactive: false,
      }).addTo(map);
      map.setView(pos, map.getZoom());
    } else {
      aircraftMarker.setLatLng(pos);
      aircraftMarker.setIcon(IfrSymbols.aircraftIcon(rotation));
    }

    if (document.getElementById('opt-rings').checked) {
      rings.forEach((r) => {
        r.setLatLng(pos);
        if (!ringGroup.hasLayer(r)) ringGroup.addLayer(r);
      });
    } else {
      ringGroup.clearLayers();
    }

    if (document.getElementById('opt-follow').checked) {
      map.panTo(pos, { animate: true, duration: 0.25 });
    }

    updateDataBar(state);
    updateFixInfo(state);
  }

  // Disable follow when the user drags the map away.
  map.on('dragstart', () => {
    document.getElementById('opt-follow').checked = false;
  });

  // ------------------------------------------------------------------
  // Facilities
  // ------------------------------------------------------------------

  const facilityStore = { VOR: [], NDB: [], WAYPOINT: [], AIRPORT: [] };
  const facilityGroups = {
    VOR: L.layerGroup().addTo(map),
    NDB: L.layerGroup().addTo(map),
    WAYPOINT: L.layerGroup().addTo(map),
    AIRPORT: L.layerGroup().addTo(map),
  };
  // Declutter: minimum zoom at which each facility type is drawn.
  const minZoom = { VOR: 6, NDB: 7, WAYPOINT: 8, AIRPORT: 8 };
  const layerToggle = {
    VOR: 'lyr-vor',
    NDB: 'lyr-ndb',
    WAYPOINT: 'lyr-wpt',
    AIRPORT: 'lyr-apt',
  };
  let selectedFix = null;

  function renderFacilities(type) {
    const group = facilityGroups[type];
    group.clearLayers();
    if (!document.getElementById(layerToggle[type]).checked) return;
    if (map.getZoom() < minZoom[type]) return;

    const showLabels = document.getElementById('lyr-labels').checked;
    const bounds = map.getBounds().pad(0.3);
    for (const f of facilityStore[type]) {
      if (!bounds.contains([f.lat, f.lon])) continue;
      const marker = L.marker([f.lat, f.lon], {
        icon: IfrSymbols.facilityIcon(f, showLabels),
        keyboard: false,
      });
      marker.on('click', () => selectFix(f));
      group.addLayer(marker);
    }
  }

  function renderAllFacilities() {
    Object.keys(facilityStore).forEach(renderFacilities);
  }
  map.on('moveend zoomend', renderAllFacilities);

  // ------------------------------------------------------------------
  // Selected fix (live bearing / radial / distance readout)
  // ------------------------------------------------------------------

  function selectFix(f) {
    selectedFix = f;
    document.getElementById('fixinfo').classList.remove('hidden');
    document.getElementById('panel').classList.remove('hidden');
    const freq = f.freq
      ? f.type === 'NDB'
        ? `${f.freq.toFixed(1)} kHz`
        : `${f.freq.toFixed(2)} MHz`
      : '—';
    document.getElementById('fix-name').textContent =
      `${f.ident} (${f.type}${f.type === 'VOR' && f.hasDme ? '/DME' : ''})`;
    document.getElementById('fix-freq').textContent = freq;
    updateFixInfo(lastState);
  }

  function clearFix() {
    selectedFix = null;
    document.getElementById('fixinfo').classList.add('hidden');
    fixLine.setLatLngs([]);
  }
  document.getElementById('btn-fix-clear').addEventListener('click', clearFix);

  function updateFixInfo(state) {
    if (!selectedFix || !state) return;
    const brgTrue = bearing(state.lat, state.lon, selectedFix.lat, selectedFix.lon);
    const radialTrue = bearing(selectedFix.lat, selectedFix.lon, state.lat, state.lon);
    const magVar = Number.isFinite(state.magVar) ? state.magVar : 0;
    const d = distNm({ lat: state.lat, lon: state.lon }, selectedFix);
    document.getElementById('fix-brg').textContent = `${fmt3((brgTrue - magVar + 360) % 360)}°M`;
    document.getElementById('fix-radial').textContent = `R-${fmt3((radialTrue - magVar + 360) % 360)}`;
    document.getElementById('fix-dist').textContent = `${d.toFixed(1)} NM`;
    fixLine.setLatLngs([
      [state.lat, state.lon],
      [selectedFix.lat, selectedFix.lon],
    ]);
  }

  // ------------------------------------------------------------------
  // Data bar
  // ------------------------------------------------------------------

  function fmt3(v) {
    return String(Math.round(v) % 360).padStart(3, '0');
  }

  function updateDataBar(state) {
    document.getElementById('d-gs').textContent = Math.round(state.gs);
    document.getElementById('d-alt').textContent = Math.round(state.altMsl).toLocaleString('en-US');
    document.getElementById('d-hdg').textContent = fmt3(state.hdgMag);
    document.getElementById('d-trk').textContent = fmt3(state.trackTrue);
    const vs = Math.round(state.vs / 10) * 10;
    document.getElementById('d-vs').textContent = (vs > 0 ? '+' : '') + vs;
  }

  function setStatus(status) {
    const el = document.getElementById('conn');
    el.title = status.detail || '';
    if (!status.connected) {
      el.className = 'conn disconnected';
      el.textContent = 'OFFLINE';
    } else if (status.mode === 'demo') {
      el.className = 'conn demo';
      el.textContent = 'DEMO';
    } else {
      el.className = 'conn connected';
      el.textContent = 'MSFS';
    }
  }

  // ------------------------------------------------------------------
  // Geo helpers
  // ------------------------------------------------------------------

  function distNm(a, b) {
    const R = 3440.065;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dL = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dL) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dL);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  // ------------------------------------------------------------------
  // WebSocket client
  // ------------------------------------------------------------------

  let ws = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'state':
          lastState = msg.state;
          updateAircraft(msg.state);
          if (msg.trackPoint) appendTrackPoint(msg.trackPoint);
          break;
        case 'track':
          setTrack(msg.points);
          break;
        case 'facilities':
          facilityStore[msg.facilityType] = msg.items;
          renderFacilities(msg.facilityType);
          break;
        case 'status':
          setStatus(msg);
          break;
      }
    };

    ws.onclose = () => {
      setStatus({ connected: false, detail: 'Server connection lost — reconnecting…' });
      setTimeout(connect, 2000);
    };
  }
  connect();

  // ------------------------------------------------------------------
  // UI wiring
  // ------------------------------------------------------------------

  document.getElementById('opt-base').addEventListener('change', (e) => setBase(e.target.value));
  document.getElementById('opt-rings').addEventListener('change', () => {
    if (lastState) updateAircraft(lastState);
    else ringGroup.clearLayers();
  });
  for (const id of Object.values(layerToggle).concat(['lyr-labels'])) {
    document.getElementById(id).addEventListener('change', renderAllFacilities);
  }
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'clearTrack' }));
    }
  });
  document.getElementById('panel-toggle').addEventListener('click', () => {
    document.getElementById('panel').classList.toggle('hidden');
  });

  setBase('chart');

  // Embedded (MSFS in-sim toolbar panel) mode: the panel is small, so start
  // with the side controls collapsed and the map maximised. The ☰ button
  // still opens the controls on demand. Enabled via ?embedded=1.
  if (new URLSearchParams(location.search).has('embedded')) {
    document.body.classList.add('embedded');
    document.getElementById('panel').classList.add('hidden');
    map.setZoom(Math.max(map.getZoom(), 9));
    // Leaflet needs a nudge once the iframe has settled to its real size.
    setTimeout(() => map.invalidateSize(), 300);
    window.addEventListener('resize', () => map.invalidateSize());
  }
})();
