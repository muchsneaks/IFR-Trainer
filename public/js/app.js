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
    if (window.NgIntegration) window.NgIntegration.onBaseChanged(name);
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
      // Pure ILS/LOC entries are drawn as feathers, not as VOR symbols.
      if (type === 'VOR' && f.isLoc) continue;
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
    renderIls();
    renderRunways();
    maybeRequestRunways();
  }
  map.on('moveend zoomend', renderAllFacilities);

  // ------------------------------------------------------------------
  // ILS feathers (from VOR-list entries flagged HAS_LOCALIZER)
  // ------------------------------------------------------------------

  const ilsGroup = L.layerGroup().addTo(map);
  const ILS_MIN_ZOOM = 9;
  const FEATHER_LEN_NM = 6;
  const FEATHER_WIDTH_NM = 0.9;

  function renderIls() {
    ilsGroup.clearLayers();
    if (!document.getElementById('lyr-ils').checked) return;
    if (map.getZoom() < ILS_MIN_ZOOM) return;
    const bounds = map.getBounds().pad(0.5);
    const showLabels = document.getElementById('lyr-labels').checked;

    for (const f of facilityStore.VOR) {
      if (!f.isLoc || !Number.isFinite(f.locCourse)) continue;
      if (!bounds.contains([f.lat, f.lon])) continue;
      // Localizer course is magnetic; MSFS magVar is positive east
      // (true = magnetic + var). Fall back to aircraft magvar.
      const magVar = Number.isFinite(f.magVar)
        ? f.magVar
        : lastState && Number.isFinite(lastState.magVar)
          ? lastState.magVar
          : 0;
      const courseTrue = (f.locCourse + magVar + 360) % 360;
      const back = (courseTrue + 180) % 360;
      // Feather: apex at the antenna, opening along the final approach track.
      const tip = { lat: f.lat, lon: f.lon };
      const endC = destination(f.lat, f.lon, back, FEATHER_LEN_NM);
      const endL = destination(endC.lat, endC.lon, (back + 90) % 360, FEATHER_WIDTH_NM / 2);
      const endR = destination(endC.lat, endC.lon, (back + 270) % 360, FEATHER_WIDTH_NM / 2);
      const poly = L.polygon(
        [
          [tip.lat, tip.lon],
          [endL.lat, endL.lon],
          [endR.lat, endR.lon],
        ],
        {
          color: '#1a3d8f',
          weight: 1.2,
          fillColor: '#1a3d8f',
          fillOpacity: 0.12,
          interactive: true,
        }
      );
      poly.on('click', () => selectFix(f));
      ilsGroup.addLayer(poly);
      // Center line of the feather
      ilsGroup.addLayer(
        L.polyline(
          [
            [tip.lat, tip.lon],
            [endC.lat, endC.lon],
          ],
          { color: '#1a3d8f', weight: 1, dashArray: '5 5', interactive: false }
        )
      );
      if (showLabels) {
        const labelPos = destination(f.lat, f.lon, back, FEATHER_LEN_NM * 0.75);
        ilsGroup.addLayer(
          L.marker([labelPos.lat, labelPos.lon], {
            icon: L.divIcon({
              className: 'navaid-icon',
              html: `<span class="navaid-label ils-label">${f.ident} ${f.freq ? f.freq.toFixed(2) : ''}<span class="freq">${fmt3(f.locCourse)}°</span></span>`,
              iconSize: [0, 0],
            }),
            keyboard: false,
            interactive: false,
          })
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Airport runway layouts (fetched on demand via SimConnect)
  // ------------------------------------------------------------------

  const runwayStore = new Map(); // icao -> runways[]
  const requestedRunways = new Set();
  const runwayGroup = L.layerGroup().addTo(map);
  const RUNWAY_MIN_ZOOM = 10;

  function maybeRequestRunways() {
    if (map.getZoom() < RUNWAY_MIN_ZOOM) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const bounds = map.getBounds().pad(0.4);
    for (const apt of facilityStore.AIRPORT) {
      if (!bounds.contains([apt.lat, apt.lon])) continue;
      if (requestedRunways.has(apt.ident)) continue;
      requestedRunways.add(apt.ident);
      ws.send(JSON.stringify({ type: 'getRunways', icao: apt.ident }));
    }
  }

  function renderRunways() {
    runwayGroup.clearLayers();
    if (!document.getElementById('lyr-apt').checked) return;
    const zoom = map.getZoom();
    if (zoom < RUNWAY_MIN_ZOOM) return;
    const bounds = map.getBounds().pad(0.3);

    for (const [, runways] of runwayStore) {
      for (const r of runways) {
        if (!bounds.contains([r.lat, r.lon])) continue;
        const halfLenNm = r.length / 1852 / 2;
        const halfWidNm = Math.max(r.width, 30) / 1852 / 2; // keep visible
        const e1 = destination(r.lat, r.lon, r.heading, halfLenNm);
        const e2 = destination(r.lat, r.lon, (r.heading + 180) % 360, halfLenNm);
        const perp = (r.heading + 90) % 360;
        const corners = [
          destination(e1.lat, e1.lon, perp, halfWidNm),
          destination(e1.lat, e1.lon, (perp + 180) % 360, halfWidNm),
          destination(e2.lat, e2.lon, (perp + 180) % 360, halfWidNm),
          destination(e2.lat, e2.lon, perp, halfWidNm),
        ].map((c) => [c.lat, c.lon]);
        runwayGroup.addLayer(
          L.polygon(corners, {
            color: '#39404d',
            weight: 1,
            fillColor: '#39404d',
            fillOpacity: 0.85,
            interactive: false,
          })
        );
        runwayGroup.addLayer(
          L.polyline(
            [
              [e1.lat, e1.lon],
              [e2.lat, e2.lon],
            ],
            { color: '#f5f5f5', weight: 1, dashArray: '6 6', interactive: false }
          )
        );
        if (zoom >= 12 && r.name) {
          runwayGroup.addLayer(
            L.marker([e2.lat, e2.lon], {
              icon: L.divIcon({
                className: 'navaid-icon',
                html: `<span class="navaid-label rwy-label">${r.name}</span>`,
                iconSize: [0, 0],
              }),
              keyboard: false,
              interactive: false,
            })
          );
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Selected fix (live bearing / radial / distance readout)
  // ------------------------------------------------------------------

  function selectFix(f) {
    selectedFix = f;
    if (window.NgIntegration) window.NgIntegration.onFixSelected(f);
    document.getElementById('fixinfo').classList.remove('hidden');
    document.getElementById('panel').classList.remove('hidden');
    const freq = f.freq
      ? f.type === 'NDB'
        ? `${f.freq.toFixed(1)} kHz`
        : `${f.freq.toFixed(2)} MHz`
      : '—';
    let typeLabel = f.type;
    if (f.type === 'VOR') {
      typeLabel = f.isLoc
        ? `ILS/LOC ${Number.isFinite(f.locCourse) ? fmt3(f.locCourse) + '°' : ''}`
        : `VOR${f.hasDme ? '/DME' : ''}`;
    }
    document.getElementById('fix-name').textContent = `${f.ident} (${typeLabel})`;
    document.getElementById('fix-freq').textContent = freq;

    // OBS / compass rose only makes sense for a real VOR.
    const isVor = f.type === 'VOR' && !f.isLoc;
    document.getElementById('fix-obs-row').classList.toggle('hidden', !isVor);
    drawRose();
    updateFixInfo(lastState);
    updateCdi();

    // Suggest the current inbound course for a hold at this fix.
    const holdCrs = document.getElementById('hold-crs');
    if (!hold && lastState) {
      const brgTrue = bearing(lastState.lat, lastState.lon, f.lat, f.lon);
      const magVar = Number.isFinite(lastState.magVar) ? lastState.magVar : 0;
      holdCrs.value = ((Math.round(brgTrue - magVar) + 359) % 360) + 1;
    }
    updateHoldUi();
  }

  function clearFix() {
    selectedFix = null;
    document.getElementById('fixinfo').classList.add('hidden');
    fixLine.setLatLngs([]);
    roseGroup.clearLayers();
    updateCdi();
    updateHoldUi();
  }
  document.getElementById('btn-fix-clear').addEventListener('click', clearFix);

  // ------------------------------------------------------------------
  // VOR compass rose + OBS radial (raw-data training aid)
  // ------------------------------------------------------------------

  const roseGroup = L.layerGroup().addTo(map);
  const ROSE_RADIUS_NM = 5;

  function stationMagVar(f) {
    if (Number.isFinite(f.magVar)) return f.magVar;
    if (lastState && Number.isFinite(lastState.magVar)) return lastState.magVar;
    return 0;
  }

  function drawRose() {
    roseGroup.clearLayers();
    const f = selectedFix;
    if (!f || f.type !== 'VOR' || f.isLoc) return;

    const magVar = stationMagVar(f);
    const style = { color: '#5a6c8f', weight: 1, interactive: false };

    // Rose ring
    roseGroup.addLayer(
      L.circle([f.lat, f.lon], {
        radius: ROSE_RADIUS_NM * 1852,
        fill: false,
        ...style,
      })
    );
    // Tick marks every 10° (magnetic), longer + labelled every 30°
    for (let magDeg = 0; magDeg < 360; magDeg += 10) {
      const trueDeg = (magDeg + magVar + 360) % 360;
      const major = magDeg % 30 === 0;
      const inner = destination(f.lat, f.lon, trueDeg, ROSE_RADIUS_NM * (major ? 0.86 : 0.93));
      const outer = destination(f.lat, f.lon, trueDeg, ROSE_RADIUS_NM);
      roseGroup.addLayer(
        L.polyline(
          [
            [inner.lat, inner.lon],
            [outer.lat, outer.lon],
          ],
          { ...style, weight: major ? 1.6 : 1 }
        )
      );
      if (major) {
        const lp = destination(f.lat, f.lon, trueDeg, ROSE_RADIUS_NM * 1.12);
        roseGroup.addLayer(
          L.marker([lp.lat, lp.lon], {
            icon: L.divIcon({
              className: 'navaid-icon',
              html: `<span class="rose-label">${String(magDeg / 10).padStart(2, '0')}</span>`,
              iconSize: [0, 0],
            }),
            keyboard: false,
            interactive: false,
          })
        );
      }
    }

    // OBS radial
    const obs = Number(document.getElementById('fix-obs').value);
    if (Number.isFinite(obs) && obs >= 1 && obs <= 360) {
      const trueCourse = (obs + magVar + 360) % 360;
      const out = destination(f.lat, f.lon, trueCourse, 40);
      const recip = destination(f.lat, f.lon, (trueCourse + 180) % 360, 40);
      // Solid on the FROM side (the radial itself), dashed on the reciprocal.
      roseGroup.addLayer(
        L.polyline(
          [
            [f.lat, f.lon],
            [out.lat, out.lon],
          ],
          { color: '#0d8f4f', weight: 2, interactive: false }
        )
      );
      roseGroup.addLayer(
        L.polyline(
          [
            [f.lat, f.lon],
            [recip.lat, recip.lon],
          ],
          { color: '#0d8f4f', weight: 1.4, dashArray: '7 7', interactive: false }
        )
      );
      const lp = destination(f.lat, f.lon, trueCourse, 11);
      roseGroup.addLayer(
        L.marker([lp.lat, lp.lon], {
          icon: L.divIcon({
            className: 'navaid-icon',
            html: `<span class="rose-label obs-label">R-${fmt3(obs)}</span>`,
            iconSize: [0, 0],
          }),
          keyboard: false,
          interactive: false,
        })
      );
    }
  }
  document.getElementById('fix-obs').addEventListener('input', () => {
    drawRose();
    updateCdi();
  });

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
    updateCdi();
  }

  // ------------------------------------------------------------------
  // CDI — course deviation indicator for the selected VOR + OBS course.
  // Standard VOR sensitivity: 2° per dot, 10° full scale.
  // ------------------------------------------------------------------

  const cdiEl = document.getElementById('cdi');

  /** Signed angular difference a − b, wrapped to [−180, 180). */
  function angleDiff(a, b) {
    return ((a - b + 540) % 360) - 180;
  }

  function updateCdi() {
    const f = selectedFix;
    const obs = Number(document.getElementById('fix-obs').value);
    const usable =
      f && f.type === 'VOR' && !f.isLoc && lastState &&
      Number.isFinite(obs) && obs >= 1 && obs <= 360;
    cdiEl.classList.toggle('hidden', !usable);
    if (!usable) return;

    const magVar = Number.isFinite(lastState.magVar) ? lastState.magVar : 0;
    const radialTrue = bearing(f.lat, f.lon, lastState.lat, lastState.lon);
    const radialMag = (radialTrue - magVar + 360) % 360;
    const dev = angleDiff(radialMag, obs);
    const isFrom = Math.abs(dev) <= 90;
    // Needle deflection in degrees, positive = course line right of aircraft.
    const needle = isFrom ? -dev : angleDiff(dev, 180);
    const clamped = Math.max(-10, Math.min(10, needle));

    const cx = 110;
    const cy = 26;
    const full = 90; // px at 10° deflection
    let dots = '';
    for (let k = 1; k <= 5; k++) {
      for (const s of [-1, 1]) {
        dots += `<circle cx="${cx + (s * k * full) / 5}" cy="${cy}" r="2.6" fill="none" stroke="#5b6b85" stroke-width="1.2"/>`;
      }
    }
    const nx = cx + (clamped / 10) * full;
    const flag = isFrom
      ? `<polygon points="${cx + 23},${cy + 8} ${cx + 31},${cy + 8} ${cx + 27},${cy + 16}" fill="#e2eaf4"/>`
      : `<polygon points="${cx + 23},${cy - 8} ${cx + 31},${cy - 8} ${cx + 27},${cy - 16}" fill="#e2eaf4"/>`;
    cdiEl.innerHTML = `
      <svg viewBox="0 0 220 52" role="img" aria-label="Course deviation indicator">
        ${dots}
        <circle cx="${cx}" cy="${cy}" r="4.5" fill="none" stroke="#5b6b85" stroke-width="1.2"/>
        ${flag}
        <line x1="${nx}" y1="6" x2="${nx}" y2="46" stroke="#45c6ff" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <div class="cdi-readout">
        <span>CRS <b>${fmt3(obs)}°</b></span>
        <span><b>${Math.abs(needle) > 10 ? '>10' : Math.abs(needle).toFixed(1)}°</b> ${needle >= 0 ? 'R' : 'L'}</span>
        <span><b>${isFrom ? 'FROM ▽' : 'TO △'}</b></span>
      </div>`;
  }

  // ------------------------------------------------------------------
  // Holding-pattern overlay — racetrack template at the selected fix.
  // Leg length and turn radius are computed from the ground speed when
  // the hold is drawn (standard-rate turns, 360° in 2 minutes).
  // ------------------------------------------------------------------

  const holdGroup = L.layerGroup().addTo(map);
  let hold = null; // { fix, crs, turn, legMin, gs }

  function updateHoldUi() {
    const form = document.getElementById('hold-form');
    const hint = document.getElementById('hold-hint');
    const btn = document.getElementById('btn-hold-toggle');
    const show = !!selectedFix || !!hold;
    form.classList.toggle('hidden', !show);
    hint.classList.toggle('hidden', show);
    if (!show) return;
    if (hold) {
      btn.textContent = `Remove hold at ${hold.fix.ident}`;
      btn.classList.remove('primary');
      btn.classList.add('danger');
    } else {
      btn.textContent = selectedFix ? `Draw hold at ${selectedFix.ident}` : 'Draw hold';
      btn.classList.add('primary');
      btn.classList.remove('danger');
    }
  }

  function drawHold() {
    holdGroup.clearLayers();
    const info = document.getElementById('hold-info');
    if (!hold) {
      info.textContent = '';
      return;
    }
    const f = hold.fix;
    const magVar = stationMagVar(f);
    const c = ((hold.crs + magVar) % 360 + 360) % 360; // true inbound course
    const legNm = (hold.legMin * hold.gs) / 60;
    const r = hold.gs / 188.5; // std-rate turn radius (NM)
    const dir = hold.turn === 'L' ? -1 : 1;

    const pts = [];
    const entry = destination(f.lat, f.lon, (c + 180) % 360, legNm);
    pts.push([entry.lat, entry.lon], [f.lat, f.lon]);
    // 180° turn past the fix
    const c1 = destination(f.lat, f.lon, (c + 90 * dir + 360) % 360, r);
    for (let t = 10; t <= 180; t += 10) {
      const p = destination(c1.lat, c1.lon, (c - 90 * dir + dir * t + 720) % 360, r);
      pts.push([p.lat, p.lon]);
    }
    // outbound leg
    const o1 = pts[pts.length - 1];
    const o2 = destination(o1[0], o1[1], (c + 180) % 360, legNm);
    pts.push([o2.lat, o2.lon]);
    // 180° turn back onto the inbound leg
    const c2 = destination(entry.lat, entry.lon, (c + 90 * dir + 360) % 360, r);
    for (let t = 10; t <= 180; t += 10) {
      const p = destination(c2.lat, c2.lon, (c + 90 * dir + dir * t + 720) % 360, r);
      pts.push([p.lat, p.lon]);
    }

    holdGroup.addLayer(
      L.polyline(pts, { color: '#e8730c', weight: 2.5, opacity: 0.9, interactive: false })
    );
    // Direction arrow on the inbound leg
    const mid = destination(f.lat, f.lon, (c + 180) % 360, legNm / 2);
    const arrowLen = Math.min(0.4, legNm * 0.12);
    const tip = destination(mid.lat, mid.lon, c, arrowLen / 2);
    const wingL = destination(tip.lat, tip.lon, (c + 150) % 360, arrowLen);
    const wingR = destination(tip.lat, tip.lon, (c + 210) % 360, arrowLen);
    holdGroup.addLayer(
      L.polyline(
        [
          [wingL.lat, wingL.lon],
          [tip.lat, tip.lon],
          [wingR.lat, wingR.lon],
        ],
        { color: '#e8730c', weight: 2.5, opacity: 0.9, interactive: false }
      )
    );
    // Label on the outbound side
    const midOut = destination(o1[0], o1[1], (c + 180) % 360, legNm / 2);
    const labelPos = destination(midOut.lat, midOut.lon, (c + 90 * dir + 360) % 360, r * 0.9);
    holdGroup.addLayer(
      L.marker([labelPos.lat, labelPos.lon], {
        icon: L.divIcon({
          className: 'navaid-icon',
          html: `<span class="hold-label">HOLD ${hold.fix.ident} · INBD ${fmt3(hold.crs)}° · ${hold.turn} TURNS</span>`,
          iconSize: [0, 0],
        }),
        keyboard: false,
        interactive: false,
      })
    );

    info.innerHTML =
      `<b>${hold.legMin} min</b> legs ≈ ${legNm.toFixed(1)} NM at ${Math.round(hold.gs)} kt GS, ` +
      `std-rate turns. Fly it, then compare your track.`;
  }

  function readHoldInputs(fix) {
    const crs = Number(document.getElementById('hold-crs').value);
    if (!Number.isFinite(crs) || crs < 1 || crs > 360) return null;
    return {
      fix,
      crs: Math.round(crs),
      turn: document.getElementById('hold-turn').value === 'L' ? 'L' : 'R',
      legMin: Number(document.getElementById('hold-leg').value) || 1,
      gs: lastState && lastState.gs > 40 ? lastState.gs : 100,
    };
  }

  document.getElementById('btn-hold-toggle').addEventListener('click', () => {
    if (hold) {
      hold = null;
    } else if (selectedFix) {
      hold = readHoldInputs(selectedFix);
      if (!hold) {
        document.getElementById('hold-crs').focus();
        return;
      }
    }
    drawHold();
    updateHoldUi();
  });
  for (const id of ['hold-crs', 'hold-turn', 'hold-leg']) {
    document.getElementById(id).addEventListener('change', () => {
      if (!hold) return;
      const next = readHoldInputs(hold.fix);
      if (next) {
        hold = next;
        drawHold();
      }
    });
  }

  // ------------------------------------------------------------------
  // Leg timer (holds, procedure turns, timed approaches)
  // Click or press T to start/stop, ⟲ or R to reset.
  // ------------------------------------------------------------------

  const timerEl = document.getElementById('timer');
  const timerValueEl = document.getElementById('d-timer');
  let timerStartedAt = null;
  let timerAccum = 0; // seconds

  function timerSeconds() {
    return timerAccum + (timerStartedAt ? (Date.now() - timerStartedAt) / 1000 : 0);
  }

  function renderTimer() {
    const s = Math.floor(timerSeconds());
    timerValueEl.textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function timerToggle() {
    if (timerStartedAt) {
      timerAccum = timerSeconds();
      timerStartedAt = null;
      timerEl.classList.remove('running');
    } else {
      timerStartedAt = Date.now();
      timerEl.classList.add('running');
    }
    renderTimer();
  }

  function timerReset() {
    timerAccum = 0;
    if (timerStartedAt) timerStartedAt = Date.now();
    renderTimer();
  }

  setInterval(() => {
    if (timerStartedAt) renderTimer();
  }, 250);
  timerEl.addEventListener('click', timerToggle);
  document.getElementById('btn-timer-reset').addEventListener('click', (e) => {
    e.stopPropagation();
    timerReset();
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const onboard = document.getElementById('onboard');
    if (onboard && !onboard.classList.contains('hidden')) return;
    if (e.key === 't' || e.key === 'T') timerToggle();
    if (e.key === 'r' || e.key === 'R') timerReset();
  });

  // ------------------------------------------------------------------
  // Data bar
  // ------------------------------------------------------------------

  function fmt3(v) {
    return String(Math.round(v) % 360).padStart(3, '0');
  }

  function updateDataBar(state) {
    document.getElementById('d-gs').textContent = Math.round(state.gs);
    document.getElementById('d-ias').textContent = Math.round(state.ias);
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

  /** Destination point given start, true bearing (deg) and distance (NM). */
  function destination(lat, lon, brgDeg, distNmVal) {
    const R = 3440.065;
    const delta = distNmVal / R;
    const theta = (brgDeg * Math.PI) / 180;
    const p1 = (lat * Math.PI) / 180;
    const l1 = (lon * Math.PI) / 180;
    const p2 = Math.asin(
      Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(theta)
    );
    const l2 =
      l1 +
      Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(p1),
        Math.cos(delta) - Math.sin(p1) * Math.sin(p2)
      );
    return {
      lat: (p2 * 180) / Math.PI,
      lon: ((((l2 * 180) / Math.PI + 540) % 360) - 180),
    };
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
          if (msg.facilityType === 'VOR') renderIls();
          if (msg.facilityType === 'AIRPORT') maybeRequestRunways();
          break;
        case 'runways':
          runwayStore.set(msg.icao, msg.runways || []);
          renderRunways();
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
  for (const id of Object.values(layerToggle).concat(['lyr-labels', 'lyr-ils'])) {
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

  // Minimal public surface for optional integrations (Navigraph module).
  window.IfrApp = {
    map,
    baseLayers,
    setBase,
    getState: () => lastState,
    getSelectedFix: () => selectedFix,
  };

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
