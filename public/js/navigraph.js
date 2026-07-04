/**
 * Navigraph integration — frontend.
 *
 * Adds to the IFR Trainer map:
 *  - Account connection via the Navigraph device flow (settings section)
 *  - Navigraph enroute IFR tiles as additional base maps (proxied locally)
 *  - An airport charts drawer (Approach / STAR / SID / Airport / Reference)
 *  - Georeferenced chart overlays rendered *underneath* the flight track and
 *    navaids (dedicated map pane), with opacity/fit/visibility controls
 *  - A simple viewer for non-georeferenced charts
 *
 * All Navigraph traffic goes through the local server (/api/navigraph/...),
 * so this also works inside the MSFS toolbar panel.
 */
/* global L */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const map = window.IfrApp && window.IfrApp.map;
  if (!map) return;

  // Chart overlays live between the base tiles (z=200) and vector overlays
  // (z=400): the flight track and navaids always stay visible on top.
  map.createPane('ngchart');
  map.getPane('ngchart').style.zIndex = 250;

  const state = {
    status: { configured: false, loggedIn: false },
    theme: localStorage.getItem('ng-theme') || 'day',
    activeChart: null, // { chart, overlay, objectUrl, visible }
    charts: [], // current drawer index
    icao: '',
    category: 'APP',
    pollTimer: null,
  };

  // ------------------------------------------------------------------
  // Base layers (enroute tiles through the local proxy)
  // ------------------------------------------------------------------

  function tileLayer(source) {
    return L.tileLayer(
      `/api/navigraph/tiles/${source}/{theme}/{z}/{x}/{y}.png`,
      {
        attribution: '&copy; Navigraph — for simulation use only',
        maxZoom: 14,
        theme: state.theme,
      }
    );
  }

  const ngLayers = {
    'ng-ifr-hi': { label: 'Navigraph IFR High', layer: tileLayer('ifr.hi') },
    'ng-ifr-lo': { label: 'Navigraph IFR Low', layer: tileLayer('ifr.lo') },
  };

  function registerBaseLayers() {
    const select = $('opt-base');
    if (!select || select.querySelector('option[value="ng-ifr-hi"]')) return;
    for (const [value, { label, layer }] of Object.entries(ngLayers)) {
      window.IfrApp.baseLayers[value] = layer;
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
  }

  function refreshTileTheme() {
    for (const { layer } of Object.values(ngLayers)) {
      layer.options.theme = state.theme;
      if (map.hasLayer(layer)) layer.redraw();
    }
  }

  // Called by app.js after every base map change.
  function onBaseChanged(name) {
    const isNg = name.startsWith('ng-');
    if (isNg) {
      const dark = state.theme === 'night';
      document.body.classList.toggle('dark-base', dark);
      $('map').style.background = dark ? '#10141a' : '#dfe3ea';
      if (!state.status.loggedIn) {
        setDrawerMsg('Sign in to Navigraph to load the enroute map.');
      }
    }
  }

  // ------------------------------------------------------------------
  // Status / login
  // ------------------------------------------------------------------

  async function api(pathname, opts) {
    const res = await fetch(pathname, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  }

  async function refreshStatus() {
    try {
      state.status = await api('/api/navigraph/status');
    } catch (_) {
      state.status = { configured: false, loggedIn: false };
    }
    renderAuth();
  }

  function renderAuth() {
    const s = state.status;
    $('ng-setup').classList.toggle('hidden', s.configured);
    $('ng-loggedout').classList.toggle('hidden', !s.configured || s.loggedIn);
    $('ng-loggedin').classList.toggle('hidden', !s.loggedIn);

    if (s.loggedIn && s.user) {
      $('ng-user').textContent = `✓ ${s.user.name}`;
    }
    const err = $('ng-login-error');
    if (s.loginError) {
      err.textContent = s.loginError;
      err.classList.remove('hidden');
    } else {
      err.classList.add('hidden');
    }

    if (s.login) {
      $('ng-logincode').classList.remove('hidden');
      $('ng-login').classList.add('hidden');
      $('ng-code').textContent = s.login.userCode || '····';
      $('ng-verify-link').href = s.login.verificationUri || '#';
    } else {
      $('ng-logincode').classList.add('hidden');
      $('ng-login').classList.remove('hidden');
    }
  }

  function pollWhileLoggingIn() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      await refreshStatus();
      if (!state.status.login) {
        clearInterval(state.pollTimer);
        if (state.status.loggedIn) {
          // Fresh session: redraw tiles that may have 401'd before.
          refreshTileTheme();
        }
      }
    }, 3000);
  }

  async function startLogin() {
    try {
      const { login } = await api('/api/navigraph/login', { method: 'POST' });
      state.status.login = login;
      state.status.loginError = null;
      renderAuth();
      if (login && login.verificationUri) window.open(login.verificationUri, '_blank');
      pollWhileLoggingIn();
    } catch (err) {
      state.status.loginError = err.message;
      renderAuth();
    }
  }

  // ------------------------------------------------------------------
  // Charts drawer
  // ------------------------------------------------------------------

  const CATEGORIES = [
    ['APP', 'Approach'],
    ['ARR', 'STAR'],
    ['DEP', 'SID'],
    ['APT', 'Airport'],
    ['REF', 'Reference'],
  ];

  function openDrawer(icao) {
    $('ng-drawer').classList.remove('hidden');
    if (icao) {
      $('ng-icao').value = icao.toUpperCase();
      loadCharts(icao);
    }
  }

  function setDrawerMsg(msg) {
    $('ng-drawer-msg').textContent = msg || '';
  }

  async function loadCharts(icao) {
    icao = (icao || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) {
      setDrawerMsg('Enter a valid ICAO code (e.g. EDDF).');
      return;
    }
    if (!state.status.loggedIn) {
      setDrawerMsg('Sign in to Navigraph first (map panel → Navigraph).');
      return;
    }
    state.icao = icao;
    state.charts = [];
    renderChartList();
    setDrawerMsg('Loading…');
    try {
      const data = await api(`/api/navigraph/charts/${icao}`);
      state.charts = (data && data.charts) || [];
      setDrawerMsg(state.charts.length ? '' : `No charts found for ${icao}.`);
      // Jump to a tab that has charts.
      if (state.charts.length && !state.charts.some((c) => c.category === state.category)) {
        const first = CATEGORIES.find(([cat]) => state.charts.some((c) => c.category === cat));
        if (first) state.category = first[0];
      }
      renderTabs();
      renderChartList();
    } catch (err) {
      setDrawerMsg(
        /401|403/.test(err.message)
          ? 'Not allowed — a Navigraph Ultimate subscription is required for charts.'
          : `Failed to load charts: ${err.message}`
      );
    }
  }

  function renderTabs() {
    const nav = $('ng-tabs');
    nav.innerHTML = '';
    for (const [cat, label] of CATEGORIES) {
      const count = state.charts.filter((c) => c.category === cat).length;
      const btn = document.createElement('button');
      btn.textContent = count ? `${label} (${count})` : label;
      btn.disabled = !count;
      btn.className = cat === state.category ? 'active' : '';
      btn.addEventListener('click', () => {
        state.category = cat;
        renderTabs();
        renderChartList();
      });
      nav.appendChild(btn);
    }
  }

  function renderChartList() {
    const ul = $('ng-chart-list');
    ul.innerHTML = '';
    const items = state.charts.filter((c) => c.category === state.category);
    for (const chart of items) {
      const li = document.createElement('li');
      const active = state.activeChart && state.activeChart.chart.id === chart.id;
      li.className = active ? 'active' : '';
      const geoBadge = chart.is_georeferenced
        ? '<span class="ng-geo" title="Georeferenced — can be shown on the map">🗺</span>'
        : '<span class="ng-geo ng-geo-off" title="Not georeferenced — opens in the viewer">📄</span>';
      const rwy = chart.runways && chart.runways.length ? ` · RWY ${chart.runways.join(', ')}` : '';
      li.innerHTML = `
        <div class="ng-chart-name">${chart.name || chart.index_number}</div>
        <div class="ng-chart-sub">${chart.index_number}${rwy} ${geoBadge}</div>`;
      li.addEventListener('click', () => selectChart(chart));
      ul.appendChild(li);
    }
  }

  // ------------------------------------------------------------------
  // Chart overlay / viewer
  // ------------------------------------------------------------------

  /**
   * Extrapolates the georeferenced planview box to the full image corners
   * (port of calculateChartBounds from Navigraph's MIT-licensed JS SDK).
   */
  function chartBounds(chart) {
    const pv = chart.bounding_boxes.planview;
    const lngPerPx = Math.abs(pv.latlng.lng2 - pv.latlng.lng1) / (pv.pixels.x2 - pv.pixels.x1);
    const latPerPx = Math.abs(pv.latlng.lat2 - pv.latlng.lat1) / (pv.pixels.y1 - pv.pixels.y2);
    const sw = {
      lng: pv.latlng.lng1 - pv.pixels.x1 * lngPerPx,
      lat: pv.latlng.lat1 - (chart.height - pv.pixels.y1) * latPerPx,
    };
    const ne = {
      lng: pv.latlng.lng2 + Math.abs(chart.width - pv.pixels.x2) * lngPerPx,
      lat: pv.latlng.lat2 + pv.pixels.y2 * latPerPx,
    };
    return L.latLngBounds([sw.lat, sw.lng], [ne.lat, ne.lng]);
  }

  function chartImageUrl(chart) {
    const src = state.theme === 'night' ? chart.image_night_url : chart.image_day_url;
    return `/api/navigraph/chart-image?url=${encodeURIComponent(src)}`;
  }

  async function selectChart(chart) {
    removeChart();
    if (chart.is_georeferenced) {
      const bounds = chartBounds(chart);
      const overlay = L.imageOverlay(chartImageUrl(chart), bounds, {
        pane: 'ngchart',
        opacity: Number($('ng-opacity').value) / 100,
        interactive: false,
      }).addTo(map);
      state.activeChart = { chart, overlay, visible: true };
      $('ng-chartbar').classList.remove('hidden');
      $('ng-chart-title').textContent = `${state.icao} ${chart.index_number}`;
      $('ng-chart-title').title = chart.name || '';
      $('ng-eye').classList.remove('off');
      map.fitBounds(bounds, { padding: [30, 30] });
      // Manually panning to a chart usually means "stop following".
      const follow = $('opt-follow');
      if (follow) follow.checked = false;
    } else {
      $('ng-viewer-title').textContent = `${state.icao} — ${chart.name || chart.index_number}`;
      $('ng-viewer-img').src = chartImageUrl(chart);
      $('ng-viewer').classList.remove('hidden');
      state.activeChart = { chart, overlay: null, visible: true };
    }
    renderChartList();
  }

  function removeChart() {
    if (state.activeChart && state.activeChart.overlay) {
      map.removeLayer(state.activeChart.overlay);
    }
    state.activeChart = null;
    $('ng-chartbar').classList.add('hidden');
    $('ng-viewer').classList.add('hidden');
    renderChartList();
  }

  function reloadChartTheme() {
    const active = state.activeChart;
    if (!active) return;
    if (active.overlay) {
      active.overlay.setUrl(chartImageUrl(active.chart));
    } else {
      $('ng-viewer-img').src = chartImageUrl(active.chart);
    }
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  $('ng-save-creds').addEventListener('click', async () => {
    try {
      await api('/api/navigraph/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: $('ng-client-id').value,
          clientSecret: $('ng-client-secret').value,
        }),
      });
      await refreshStatus();
    } catch (err) {
      alert(`Could not save credentials: ${err.message}`);
    }
  });

  $('ng-login').addEventListener('click', startLogin);
  $('ng-cancel-login').addEventListener('click', async () => {
    await api('/api/navigraph/login/cancel', { method: 'POST' }).catch(() => {});
    clearInterval(state.pollTimer);
    refreshStatus();
  });
  $('ng-logout').addEventListener('click', async () => {
    await api('/api/navigraph/logout', { method: 'POST' }).catch(() => {});
    removeChart();
    refreshStatus();
  });

  $('ng-theme').value = state.theme;
  $('ng-theme').addEventListener('change', (e) => {
    state.theme = e.target.value;
    localStorage.setItem('ng-theme', state.theme);
    refreshTileTheme();
    reloadChartTheme();
    onBaseChanged($('opt-base').value);
  });

  $('ng-open-charts').addEventListener('click', () => {
    const fix = window.IfrApp.getSelectedFix && window.IfrApp.getSelectedFix();
    const st = window.IfrApp.getState && window.IfrApp.getState();
    openDrawer((fix && fix.type === 'AIRPORT' && fix.ident) || state.icao || (st ? '' : ''));
    $('ng-icao').focus();
  });
  $('btn-fix-charts').addEventListener('click', () => {
    const fix = window.IfrApp.getSelectedFix();
    if (fix) openDrawer(fix.ident);
  });
  $('ng-drawer-close').addEventListener('click', () => $('ng-drawer').classList.add('hidden'));
  $('ng-icao-load').addEventListener('click', () => loadCharts($('ng-icao').value));
  $('ng-icao').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadCharts($('ng-icao').value);
  });

  $('ng-opacity').addEventListener('input', (e) => {
    if (state.activeChart && state.activeChart.overlay) {
      state.activeChart.overlay.setOpacity(Number(e.target.value) / 100);
    }
  });
  $('ng-fit').addEventListener('click', () => {
    if (state.activeChart && state.activeChart.overlay) {
      map.fitBounds(state.activeChart.overlay.getBounds(), { padding: [30, 30] });
    }
  });
  $('ng-eye').addEventListener('click', () => {
    const a = state.activeChart;
    if (!a || !a.overlay) return;
    a.visible = !a.visible;
    a.overlay.setOpacity(a.visible ? Number($('ng-opacity').value) / 100 : 0);
    $('ng-eye').classList.toggle('off', !a.visible);
  });
  $('ng-chart-remove').addEventListener('click', removeChart);
  $('ng-viewer-close').addEventListener('click', removeChart);

  // Show the "Charts" button on airport fixes.
  function onFixSelected(f) {
    $('btn-fix-charts').classList.toggle(
      'hidden',
      !(f && f.type === 'AIRPORT' && state.status.loggedIn)
    );
  }

  window.NgIntegration = { onBaseChanged, onFixSelected };

  registerBaseLayers();
  refreshStatus().then(() => {
    // If a login was already in progress on the server, resume polling.
    if (state.status.login) pollWhileLoggingIn();
  });
})();
