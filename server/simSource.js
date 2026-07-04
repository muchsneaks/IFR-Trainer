'use strict';

/**
 * Live data source: connects to MSFS 2024 via SimConnect.
 *
 * Emits:
 *   'status'     { connected, mode: 'sim', detail }
 *   'state'      aircraft state (lat/lon/alt/heading/speeds)
 *   'facilities' { facilityType, items } — from the native MSFS facility DB
 *   'runways'    { icao, runways } — airport runway layout (facility data)
 */

const { EventEmitter } = require('events');

const RECONNECT_DELAY_MS = 5000;

// Data definition / request ids
const DEF_AIRCRAFT = 1;
const DEF_RUNWAYS = 2;
const REQ_AIRCRAFT = 1;
const REQ_FACILITY_BASE = 100; // + FacilityListType
const REQ_RUNWAY_BASE = 1000; // + incrementing counter

// Runway designator suffixes (SDK: PRIMARY/SECONDARY_DESIGNATOR values)
const RUNWAY_DESIGNATORS = ['', 'L', 'R', 'C', 'W', 'A', 'B'];

class SimSource extends EventEmitter {
  constructor() {
    super();
    this.handle = null;
    this.connected = false;
    this.stopped = false;
    this.lib = null; // lazily required so demo mode never needs the module
    this._runwayReqSeq = 0;
    this._runwayRequests = new Map(); // requestId -> { icao, runways }
    this._runwayCache = new Map(); // icao -> runways[]
  }

  start() {
    try {
      // eslint-disable-next-line global-require
      this.lib = require('node-simconnect');
    } catch (err) {
      this.emit('status', {
        connected: false,
        mode: 'sim',
        detail: `node-simconnect not installed (${err.message}). Run "npm install".`,
      });
      return;
    }
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.handle) {
      try {
        this.handle.close();
      } catch (_) {
        /* already closed */
      }
      this.handle = null;
    }
  }

  _connect() {
    if (this.stopped) return;
    const { open, Protocol } = this.lib;
    this.emit('status', {
      connected: false,
      mode: 'sim',
      detail: 'Connecting to MSFS via SimConnect…',
    });

    open('IFR Trainer', Protocol.KittyHawk)
      .then(({ recvOpen, handle }) => {
        this.handle = handle;
        this.connected = true;
        this.emit('status', {
          connected: true,
          mode: 'sim',
          detail: `Connected to ${recvOpen.applicationName}`,
        });
        this._setup(handle);
      })
      .catch((err) => {
        this.emit('status', {
          connected: false,
          mode: 'sim',
          detail: `SimConnect connection failed (${err.message}). Is MSFS running? Retrying…`,
        });
        this._scheduleReconnect();
      });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
  }

  _onDisconnect(reason) {
    if (!this.connected && !this.handle) return;
    this.connected = false;
    this.handle = null;
    this.emit('status', {
      connected: false,
      mode: 'sim',
      detail: `Lost connection to MSFS (${reason}). Retrying…`,
    });
    this._scheduleReconnect();
  }

  _setup(handle) {
    const {
      SimConnectDataType,
      SimConnectPeriod,
      SimConnectConstants,
      FacilityListType,
    } = this.lib;

    handle.on('close', () => this._onDisconnect('closed'));
    handle.on('error', (err) => this._onDisconnect(err && err.message));
    handle.on('quit', () => this._onDisconnect('simulator quit'));
    handle.on('exception', (ex) => {
      // Non-fatal; log so problems with a request are visible.
      console.warn('[simconnect] exception:', ex);
    });

    // --- Aircraft state -------------------------------------------------
    const vars = [
      ['PLANE LATITUDE', 'degrees'],
      ['PLANE LONGITUDE', 'degrees'],
      ['PLANE ALTITUDE', 'feet'],
      ['PLANE ALT ABOVE GROUND', 'feet'],
      ['PLANE HEADING DEGREES TRUE', 'degrees'],
      ['PLANE HEADING DEGREES MAGNETIC', 'degrees'],
      ['GPS GROUND TRUE TRACK', 'degrees'],
      ['GROUND VELOCITY', 'knots'],
      ['AIRSPEED INDICATED', 'knots'],
      ['VERTICAL SPEED', 'feet per minute'],
      ['MAGVAR', 'degrees'],
      ['SIM ON GROUND', 'bool'],
    ];
    for (const [name, unit] of vars) {
      handle.addToDataDefinition(
        DEF_AIRCRAFT,
        name,
        unit,
        SimConnectDataType.FLOAT64
      );
    }

    // ~4 updates/sec: every 15 visual frames at 60 fps.
    handle.requestDataOnSimObject(
      REQ_AIRCRAFT,
      DEF_AIRCRAFT,
      SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.VISUAL_FRAME,
      0,
      0,
      15,
      0
    );

    handle.on('simObjectData', (recv) => {
      if (recv.requestID !== REQ_AIRCRAFT) return;
      const d = recv.data;
      try {
        const state = {
          lat: d.readFloat64(),
          lon: d.readFloat64(),
          altMsl: d.readFloat64(),
          altAgl: d.readFloat64(),
          hdgTrue: d.readFloat64(),
          hdgMag: d.readFloat64(),
          trackTrue: d.readFloat64(),
          gs: d.readFloat64(),
          ias: d.readFloat64(),
          vs: d.readFloat64(),
          magVar: d.readFloat64(),
          onGround: d.readFloat64() > 0.5,
          t: Date.now(),
        };
        if (Number.isFinite(state.lat) && Number.isFinite(state.lon)) {
          this.emit('state', state);
        }
      } catch (err) {
        console.warn('[simconnect] failed to parse aircraft state:', err.message);
      }
    });

    // --- Facilities from the native MSFS database -----------------------
    // subscribeToFacilities keeps sending the list of facilities cached
    // around the aircraft (the "reality bubble") as it moves.
    const subscriptions = [
      [FacilityListType.VOR, 'vorList', 'vors', 'VOR'],
      [FacilityListType.NDB, 'ndbList', 'ndbs', 'NDB'],
      [FacilityListType.WAYPOINT, 'waypointList', 'waypoints', 'WAYPOINT'],
      [FacilityListType.AIRPORT, 'airportList', 'airports', 'AIRPORT'],
    ];

    // Facility list replies arrive chunked (entryNumber / outOf); collect
    // per request and emit once complete.
    const pending = new Map(); // facilityType -> items[]

    for (const [listType, eventName, itemsKey, typeName] of subscriptions) {
      try {
        handle.subscribeToFacilities(listType, REQ_FACILITY_BASE + listType);
      } catch (err) {
        console.warn(`[simconnect] facility subscription ${typeName} failed:`, err.message);
        continue;
      }

      handle.on(eventName, (recv) => {
        const raw = recv[itemsKey] || recv.facilities || [];
        const items = raw.map((f) => this._normalizeFacility(f, typeName));
        const chunkKey = `${typeName}:${recv.requestID}`;
        const acc = pending.get(chunkKey) || [];
        acc.push(...items);
        if (recv.entryNumber >= recv.outOf - 1 || recv.outOf <= 1) {
          pending.delete(chunkKey);
          this.emit('facilities', { facilityType: typeName, items: acc });
        } else {
          pending.set(chunkKey, acc);
        }
      });
    }

    // --- Airport runway layouts (facility data API) ----------------------
    // One shared definition; per-airport requests are made on demand from
    // the map (when zoomed in on an airport).
    try {
      const defFields = [
        'OPEN AIRPORT',
        'LATITUDE',
        'LONGITUDE',
        'OPEN RUNWAY',
        'LATITUDE',
        'LONGITUDE',
        'ALTITUDE',
        'HEADING',
        'LENGTH',
        'WIDTH',
        'PRIMARY_NUMBER',
        'PRIMARY_DESIGNATOR',
        'SECONDARY_NUMBER',
        'SECONDARY_DESIGNATOR',
        'CLOSE RUNWAY',
        'CLOSE AIRPORT',
      ];
      for (const field of defFields) handle.addToFacilityDefinition(DEF_RUNWAYS, field);

      handle.on('facilityData', (recv) => {
        const req = this._runwayRequests.get(recv.userRequestId);
        if (!req) return;
        try {
          if (recv.type === this.lib.FacilityDataType.RUNWAY) {
            const d = recv.data;
            const rwy = {
              lat: d.readFloat64(),
              lon: d.readFloat64(),
              alt: d.readFloat64(),
              heading: d.readFloat32(),
              length: d.readFloat32(), // meters
              width: d.readFloat32(), // meters
            };
            const primNum = d.readInt32();
            const primDes = d.readInt32();
            const secNum = d.readInt32();
            const secDes = d.readInt32();
            rwy.name = `${formatRunwayEnd(primNum, primDes)}/${formatRunwayEnd(secNum, secDes)}`;
            if (Number.isFinite(rwy.lat) && Number.isFinite(rwy.lon) && rwy.length > 0) {
              req.runways.push(rwy);
            }
          }
        } catch (err) {
          console.warn('[simconnect] runway parse error:', err.message);
        }
      });

      handle.on('facilityDataEnd', (recv) => {
        const req = this._runwayRequests.get(recv.userRequestId);
        if (!req) return;
        this._runwayRequests.delete(recv.userRequestId);
        this._runwayCache.set(req.icao, req.runways);
        this.emit('runways', { icao: req.icao, runways: req.runways });
      });
    } catch (err) {
      console.warn('[simconnect] runway facility definition failed:', err.message);
    }
  }

  /** Request the runway layout for an airport (cached). */
  requestRunways(icao) {
    icao = String(icao || '').trim().toUpperCase();
    if (!icao) return;
    if (this._runwayCache.has(icao)) {
      this.emit('runways', { icao, runways: this._runwayCache.get(icao) });
      return;
    }
    if (!this.connected || !this.handle) return;
    // Already in flight?
    for (const req of this._runwayRequests.values()) {
      if (req.icao === icao) return;
    }
    const reqId = REQ_RUNWAY_BASE + (this._runwayReqSeq = (this._runwayReqSeq + 1) % 5000);
    this._runwayRequests.set(reqId, { icao, runways: [] });
    try {
      this.handle.requestFacilityData(DEF_RUNWAYS, reqId, icao);
    } catch (err) {
      this._runwayRequests.delete(reqId);
      console.warn(`[simconnect] runway request ${icao} failed:`, err.message);
    }
  }

  _normalizeFacility(f, typeName) {
    const item = {
      ident: (f.icao || f.ident || '').trim(),
      region: (f.region || f.regionCode || '').trim(),
      lat: f.latitude,
      lon: f.longitude,
      alt: typeof f.altitude === 'number' ? Math.round(f.altitude * 3.28084) : null,
      type: typeName,
    };
    if (typeName === 'VOR' || typeName === 'NDB') {
      item.freq = normalizeFrequency(f.frequency, typeName);
    }
    if (typeName === 'VOR' && typeof f.flags === 'number') {
      // SIMCONNECT_RECV_VOR_LIST flags
      item.hasDme = (f.flags & 0x8) !== 0; // HAS_DME
      item.hasNav = (f.flags & 0x1) !== 0; // HAS_NAV_SIGNAL
      item.isLoc = (f.flags & 0x2) !== 0; // HAS_LOCALIZER
      // Localizer front course (drawn as an ILS feather on the map).
      if (item.isLoc && typeof f.localizer === 'number' && Number.isFinite(f.localizer)) {
        item.locCourse = Math.round(f.localizer * 10) / 10;
      }
    }
    if (typeof f.magVar === 'number') item.magVar = f.magVar;
    return item;
  }
}

function formatRunwayEnd(number, designator) {
  if (!Number.isFinite(number) || number < 1 || number > 36) return '?';
  return String(number).padStart(2, '0') + (RUNWAY_DESIGNATORS[designator] || '');
}

/**
 * SimConnect reports frequencies in Hz. Return a display-friendly value:
 * VOR in MHz (e.g. 114.20), NDB in kHz (e.g. 375.0).
 */
function normalizeFrequency(freq, typeName) {
  if (typeof freq !== 'number' || freq <= 0) return null;
  let hz = freq;
  // Be forgiving if a library version already scaled the value.
  if (typeName === 'VOR') {
    if (hz > 1e6) hz /= 1e6; // Hz -> MHz
    else if (hz > 1000) hz /= 1000; // kHz -> MHz
    return Math.round(hz * 100) / 100;
  }
  if (hz > 1e6) hz /= 1000; // Hz -> kHz
  return Math.round(hz * 10) / 10;
}

module.exports = { SimSource };
