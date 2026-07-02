/**
 * IFR enroute-chart symbology as Leaflet divIcons (inline SVG).
 * Styling follows common ICAO/Jeppesen conventions:
 *   VOR      — hexagon with center dot (in a square box when DME is present)
 *   NDB      — dotted disc with center dot
 *   Waypoint — hollow triangle (RNAV fix)
 *   Airport  — circle with runway tick
 */
/* global L */
(function () {
  'use strict';

  const STROKE = '#1a3d8f'; // chart blue
  const WPT_COLOR = '#6b2fa8'; // RNAV purple
  const APT_COLOR = '#1d6f42'; // airport green

  function labelHtml(f, showFreq) {
    const freq =
      showFreq && f.freq
        ? `<span class="freq">${f.type === 'NDB' ? f.freq.toFixed(1) : f.freq.toFixed(2)}</span>`
        : '';
    return `<span class="navaid-label">${f.ident}${freq}</span>`;
  }

  function vorSvg(hasDme) {
    // Hexagon, flat-top, centered in 26x26 viewBox
    const hex = '13,4 20.8,8.5 20.8,17.5 13,22 5.2,17.5 5.2,8.5';
    const dmeBox = hasDme
      ? `<rect x="4" y="5" width="18" height="16" fill="none" stroke="${STROKE}" stroke-width="1.4"/>`
      : '';
    return `<svg width="26" height="26" viewBox="0 0 26 26">
      ${dmeBox}
      <polygon points="${hex}" fill="none" stroke="${STROKE}" stroke-width="1.6"/>
      <circle cx="13" cy="13" r="1.8" fill="${STROKE}"/>
    </svg>`;
  }

  function ndbSvg() {
    // Center dot surrounded by dotted rings
    let dots = '';
    for (const [r, n] of [[6, 10], [9.5, 16]]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        dots += `<circle cx="${13 + r * Math.cos(a)}" cy="${13 + r * Math.sin(a)}" r="0.9" fill="${STROKE}"/>`;
      }
    }
    return `<svg width="26" height="26" viewBox="0 0 26 26">
      ${dots}
      <circle cx="13" cy="13" r="2" fill="none" stroke="${STROKE}" stroke-width="1.3"/>
      <circle cx="13" cy="13" r="0.9" fill="${STROKE}"/>
    </svg>`;
  }

  function wptSvg() {
    return `<svg width="18" height="18" viewBox="0 0 18 18">
      <polygon points="9,2.5 15.5,14.5 2.5,14.5" fill="none" stroke="${WPT_COLOR}" stroke-width="1.6"/>
    </svg>`;
  }

  function aptSvg() {
    return `<svg width="20" height="20" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="${APT_COLOR}" stroke-width="1.6"/>
      <line x1="10" y1="5" x2="10" y2="15" stroke="${APT_COLOR}" stroke-width="1.6"/>
    </svg>`;
  }

  function facilityIcon(f, showLabels) {
    let svg;
    let size;
    let cls = '';
    switch (f.type) {
      case 'VOR':
        svg = vorSvg(!!f.hasDme);
        size = 26;
        break;
      case 'NDB':
        svg = ndbSvg();
        size = 26;
        break;
      case 'WAYPOINT':
        svg = wptSvg();
        size = 18;
        cls = 'wpt';
        break;
      default:
        svg = aptSvg();
        size = 20;
        cls = 'apt';
    }
    const label = showLabels ? labelHtml(f, f.type === 'VOR' || f.type === 'NDB') : '';
    return L.divIcon({
      className: `navaid-icon ${cls}`,
      html: `<div style="position:relative">${svg}${label}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function aircraftIcon(headingDeg) {
    return L.divIcon({
      className: 'aircraft-icon',
      html: `<svg width="34" height="34" viewBox="0 0 34 34" style="transform:rotate(${headingDeg.toFixed(1)}deg)">
        <polygon points="17,2 19,9 19,13 30,18 30,21 19,19 19,26 23,29.5 23,31.5 17,29.8 11,31.5 11,29.5 15,26 15,19 4,21 4,18 15,13 15,9"
                 fill="#0e1420" stroke="#38bdf8" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  window.IfrSymbols = { facilityIcon, aircraftIcon };
})();
