'use strict';

/**
 * Small built-in navdata set around Frankfurt (EDDF) used by demo mode only.
 * When connected to MSFS, all facilities come from the sim's native database
 * instead. Positions/frequencies are approximate — training demo only.
 */

const VORS = [
  { ident: 'FFM', name: 'Frankfurt', lat: 50.0553, lon: 8.6339, freq: 114.2, hasDme: true },
  { ident: 'TAU', name: 'Taunus', lat: 50.2261, lon: 8.0644, freq: 110.6, hasDme: true },
  { ident: 'RID', name: 'Ried', lat: 49.7817, lon: 8.5253, freq: 112.2, hasDme: true },
  { ident: 'MTR', name: 'Metro', lat: 49.7169, lon: 8.8047, freq: 110.0, hasDme: false },
  { ident: 'GED', name: 'Gedern', lat: 50.4497, lon: 9.2606, freq: 116.45, hasDme: true },
  { ident: 'CHA', name: 'Charlie', lat: 49.9214, lon: 9.0392, freq: 114.45, hasDme: true },
];

const NDBS = [
  { ident: 'FW', name: 'Frankfurt West', lat: 50.0392, lon: 8.3247, freq: 388.0 },
  { ident: 'FFE', name: 'Egelsbach', lat: 49.9603, lon: 8.6431, freq: 356.0 },
];

const WAYPOINTS = [
  { ident: 'MARUN', lat: 50.0692, lon: 8.9739 },
  { ident: 'SPESA', lat: 50.0189, lon: 9.3311 },
  { ident: 'CINDY', lat: 49.9095, lon: 8.1128 },
  { ident: 'BADLI', lat: 50.3169, lon: 8.5642 },
  { ident: 'TOBAK', lat: 50.1806, lon: 8.2861 },
  { ident: 'ANEKI', lat: 49.7392, lon: 8.2683 },
  { ident: 'OBOKA', lat: 50.3608, lon: 8.8961 },
  { ident: 'KERAX', lat: 49.6864, lon: 8.9819 },
];

const AIRPORTS = [
  { ident: 'EDDF', name: 'Frankfurt Main', lat: 50.0333, lon: 8.5706, alt: 364 },
  { ident: 'EDFE', name: 'Egelsbach', lat: 49.9597, lon: 8.6458, alt: 384 },
  { ident: 'EDFZ', name: 'Mainz-Finthen', lat: 49.9672, lon: 8.1472, alt: 525 },
  { ident: 'EDFM', name: 'Mannheim', lat: 49.4731, lon: 8.5142, alt: 308 },
  { ident: 'ETOU', name: 'Wiesbaden AAF', lat: 50.0498, lon: 8.3254, alt: 461 },
];

module.exports = { VORS, NDBS, WAYPOINTS, AIRPORTS };
