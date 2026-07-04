'use strict';

/**
 * Demo data source: simulates an IFR flight around Frankfurt so the app can
 * be tried without MSFS running. Same event interface as SimSource.
 */

const { EventEmitter } = require('events');
const { distanceNm, bearingDeg, destination } = require('./geo');
const navdata = require('./demoNavdata');

const TICK_MS = 250;
const TURN_RATE_DEG_S = 3; // standard rate turn
const MAGVAR = 3.0; // approximate local magnetic variation (deg E)

// A small IFR round-robin: EDDF -> TAU -> BADLI -> GED -> MARUN -> RID -> EDDF
const ROUTE = [
  { lat: 50.2261, lon: 8.0644, alt: 5000 }, // TAU
  { lat: 50.3169, lon: 8.5642, alt: 8000 }, // BADLI
  { lat: 50.4497, lon: 9.2606, alt: 8000 }, // GED
  { lat: 50.0692, lon: 8.9739, alt: 6000 }, // MARUN
  { lat: 49.7817, lon: 8.5253, alt: 4000 }, // RID
  { lat: 50.0333, lon: 8.5706, alt: 3000 }, // EDDF overhead
];

class DemoSource extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.pos = { lat: 50.0333, lon: 8.5706 }; // start overhead EDDF
    this.alt = 3000;
    this.hdg = 300;
    this.gs = 150;
    this.legIndex = 0;
  }

  start() {
    this.emit('status', {
      connected: true,
      mode: 'demo',
      detail: 'Demo flight (no simulator connection)',
    });
    // Demo facilities come from the built-in sample set.
    setImmediate(() => this._emitFacilities());
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _emitFacilities() {
    const map = (items, type, extra = {}) =>
      items.map((f) => ({
        ident: f.ident,
        region: 'ED',
        lat: f.lat,
        lon: f.lon,
        alt: f.alt || null,
        type,
        name: f.name,
        freq: f.freq,
        hasDme: f.hasDme,
        ...extra,
      }));
    // ILS localizers arrive in the VOR list in the real sim (HAS_LOCALIZER flag).
    const ils = navdata.ILS.map((f) => ({
      ident: f.ident,
      region: 'ED',
      lat: f.lat,
      lon: f.lon,
      alt: null,
      type: 'VOR',
      name: f.name,
      freq: f.freq,
      isLoc: true,
      locCourse: f.course,
      magVar: 3.0,
    }));
    this.emit('facilities', { facilityType: 'VOR', items: map(navdata.VORS, 'VOR').concat(ils) });
    this.emit('facilities', { facilityType: 'NDB', items: map(navdata.NDBS, 'NDB') });
    this.emit('facilities', { facilityType: 'WAYPOINT', items: map(navdata.WAYPOINTS, 'WAYPOINT') });
    this.emit('facilities', { facilityType: 'AIRPORT', items: map(navdata.AIRPORTS, 'AIRPORT') });
  }

  /** Demo runway layouts (approximate EDDF geometry). */
  requestRunways(icao) {
    const runways = navdata.RUNWAYS[String(icao || '').trim().toUpperCase()];
    this.emit('runways', { icao: String(icao).trim().toUpperCase(), runways: runways || [] });
  }

  _tick() {
    const dt = TICK_MS / 1000;
    const target = ROUTE[this.legIndex];

    // Turn towards the current fix at standard rate.
    const desired = bearingDeg(this.pos.lat, this.pos.lon, target.lat, target.lon);
    let diff = ((desired - this.hdg + 540) % 360) - 180;
    const maxTurn = TURN_RATE_DEG_S * dt;
    this.hdg = (this.hdg + Math.max(-maxTurn, Math.min(maxTurn, diff)) + 360) % 360;

    // Speed and altitude towards leg targets.
    const targetGs = 175;
    this.gs += Math.max(-2 * dt, Math.min(2 * dt, targetGs - this.gs));
    const altDiff = target.alt - this.alt;
    const vs = Math.max(-1200, Math.min(1500, altDiff * 2));
    this.alt += (vs / 60) * dt;

    // Move.
    this.pos = destination(this.pos.lat, this.pos.lon, this.hdg, (this.gs / 3600) * dt);

    // Sequence to the next fix within 1.5 NM.
    if (distanceNm(this.pos.lat, this.pos.lon, target.lat, target.lon) < 1.5) {
      this.legIndex = (this.legIndex + 1) % ROUTE.length;
    }

    this.emit('state', {
      lat: this.pos.lat,
      lon: this.pos.lon,
      altMsl: this.alt,
      altAgl: this.alt - 400,
      hdgTrue: this.hdg,
      hdgMag: (this.hdg - MAGVAR + 360) % 360,
      trackTrue: this.hdg,
      gs: this.gs,
      ias: Math.max(0, this.gs - 15),
      vs,
      magVar: MAGVAR,
      onGround: false,
      t: Date.now(),
    });
  }
}

module.exports = { DemoSource };
