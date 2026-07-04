'use strict';

/**
 * Navigraph integration (charts + enroute tiles) for the IFR Trainer.
 *
 * Implements the OAuth2 Device Authorization flow with PKCE against the
 * Navigraph Identity service, persists tokens on disk so the login survives
 * restarts, and proxies the Charts API and enroute tile server so the browser
 * (and the in-sim MSFS panel) never needs Navigraph credentials of its own.
 *
 * Endpoints and flow follow Navigraph's official developer documentation and
 * their MIT-licensed JS SDK (https://github.com/Navigraph/navigraph-js-sdk).
 * The enroute tile CDN is authorized via signed cookies that the identity
 * server attaches to token responses; we capture and replay them here.
 *
 * Requirements:
 *  - The app operator needs (free) Navigraph developer credentials
 *    (client id/secret with scopes "charts tiles offline_access") from
 *    https://developers.navigraph.com
 *  - End users need a Navigraph subscription (Ultimate for charts).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IDENTITY = 'https://identity.api.navigraph.com';
const CHARTS_API = 'https://api.navigraph.com/v2/charts';
const AIRPORT_API = 'https://api.navigraph.com/v2/airport';
const TILE_HOST = 'https://enroute-bitmap.charts.api-v2.navigraph.com';
const SCOPES = 'openid charts tiles offline_access';

const TILE_SOURCES = new Set(['ifr.hi', 'ifr.lo', 'vfr', 'world']);
const TILE_THEMES = new Set(['day', 'night']);

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'navigraph.json');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

class NavigraphClient {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(m));
    this.config = this._loadConfig();
    // Signed CDN cookies captured from token responses (for the tile server).
    this.cookies = new Map();
    this.loginState = { active: false, userCode: null, verificationUri: null, error: null };
    this._refreshTimer = null;
    this._chartsCache = new Map(); // icao -> {t, data}
    this._tileCache = new Map(); // url -> {t, buf, type}

    if (this.config.refreshToken) {
      // Re-establish the session (and tile cookies) on startup.
      this._refresh().catch((err) => this.log(`[navigraph] startup refresh failed: ${err.message}`));
    }
  }

  // --- config / persistence ------------------------------------------------

  _loadConfig() {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return cfg && typeof cfg === 'object' ? cfg : {};
    } catch (_) {
      return {};
    }
  }

  _saveConfig() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
  }

  get clientId() {
    return process.env.NAVIGRAPH_CLIENT_ID || this.config.clientId || null;
  }

  get clientSecret() {
    return process.env.NAVIGRAPH_CLIENT_SECRET || this.config.clientSecret || null;
  }

  setCredentials(clientId, clientSecret) {
    this.config.clientId = String(clientId || '').trim();
    this.config.clientSecret = String(clientSecret || '').trim();
    this._saveConfig();
  }

  get configured() {
    return !!(this.clientId && this.clientSecret);
  }

  get loggedIn() {
    return !!this.config.accessToken;
  }

  status() {
    const payload = this.config.accessToken ? decodeJwtPayload(this.config.accessToken) : null;
    return {
      configured: this.configured,
      loggedIn: this.loggedIn,
      login: this.loginState.active
        ? {
            userCode: this.loginState.userCode,
            verificationUri: this.loginState.verificationUri,
          }
        : null,
      loginError: this.loginState.error,
      user: payload
        ? {
            name: payload.preferred_username || payload.name || payload.sub || 'Navigraph user',
            subscriptions: payload.subscriptions || payload.subscription || null,
          }
        : null,
    };
  }

  // --- token handling -------------------------------------------------------

  _captureCookies(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    for (const line of setCookies) {
      const pair = line.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async _tokenRequest(params) {
    const res = await fetch(`${IDENTITY}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        ...params,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) {
      this._captureCookies(res);
      this.config.accessToken = data.access_token;
      if (data.refresh_token) this.config.refreshToken = data.refresh_token;
      this._saveConfig();
      this._scheduleRefresh(data.expires_in);
    }
    return { ok: res.ok, status: res.status, data };
  }

  _scheduleRefresh(expiresInSec) {
    clearTimeout(this._refreshTimer);
    const delay = Math.max(60, (Number(expiresInSec) || 3600) - 120) * 1000;
    this._refreshTimer = setTimeout(() => {
      this._refresh().catch((err) => this.log(`[navigraph] token refresh failed: ${err.message}`));
    }, delay);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  async _refresh() {
    if (!this.configured || !this.config.refreshToken) throw new Error('not logged in');
    const { ok, data } = await this._tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
    });
    if (!ok) {
      // Refresh token invalid/revoked — drop the session.
      if (data.error === 'invalid_grant') this._clearSession();
      throw new Error(data.error || 'refresh rejected');
    }
    this.log('[navigraph] session refreshed');
  }

  _clearSession() {
    delete this.config.accessToken;
    delete this.config.refreshToken;
    this._saveConfig();
    this.cookies.clear();
    clearTimeout(this._refreshTimer);
  }

  // --- device flow login ----------------------------------------------------

  async startLogin() {
    if (!this.configured) throw new Error('Navigraph client credentials are not configured');
    if (this.loginState.active) return this.status().login;

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    const res = await fetch(`${IDENTITY}/connect/deviceauthorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.device_code) {
      throw new Error(data.error_description || data.error || `device authorization failed (${res.status})`);
    }

    this.loginState = {
      active: true,
      error: null,
      userCode: data.user_code,
      verificationUri: data.verification_uri_complete || data.verification_uri,
    };
    this._pollLogin(data.device_code, verifier, (data.interval || 5) * 1000, Date.now() + (data.expires_in || 300) * 1000);
    return this.status().login;
  }

  _pollLogin(deviceCode, verifier, intervalMs, deadline) {
    const poll = async () => {
      if (!this.loginState.active) return;
      if (Date.now() > deadline) {
        this.loginState = { active: false, userCode: null, verificationUri: null, error: 'Login expired — please try again.' };
        return;
      }
      try {
        const { ok, data } = await this._tokenRequest({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          code_verifier: verifier,
        });
        if (ok) {
          this.loginState = { active: false, userCode: null, verificationUri: null, error: null };
          this.log('[navigraph] signed in');
          return;
        }
        if (data.error === 'slow_down') intervalMs += 5000;
        if (data.error && data.error !== 'authorization_pending' && data.error !== 'slow_down') {
          this.loginState = { active: false, userCode: null, verificationUri: null, error: data.error_description || data.error };
          return;
        }
      } catch (err) {
        this.log(`[navigraph] login poll error: ${err.message}`);
      }
      setTimeout(poll, intervalMs).unref?.();
    };
    setTimeout(poll, intervalMs).unref?.();
  }

  cancelLogin() {
    this.loginState = { active: false, userCode: null, verificationUri: null, error: null };
  }

  async logout() {
    if (this.config.refreshToken) {
      await fetch(`${IDENTITY}/connect/revocation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          token: this.config.refreshToken,
          token_type_hint: 'refresh_token',
        }),
      }).catch(() => {});
    }
    this._clearSession();
  }

  // --- authenticated fetch helpers -------------------------------------------

  async _authedFetch(url, opts = {}, retried = false) {
    if (!this.config.accessToken) {
      const err = new Error('not logged in');
      err.statusCode = 401;
      throw err;
    }
    const res = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Authorization: `Bearer ${this.config.accessToken}`,
        Cookie: this._cookieHeader(),
      },
    });
    if ((res.status === 401 || res.status === 403) && !retried && this.config.refreshToken) {
      await this._refresh();
      return this._authedFetch(url, opts, true);
    }
    return res;
  }

  /** Chart index for an airport, grouped raw from the API. Cached 10 min. */
  async chartsIndex(icao) {
    const key = icao.toUpperCase();
    const hit = this._chartsCache.get(key);
    if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.data;
    const res = await this._authedFetch(`${CHARTS_API}/${encodeURIComponent(key)}?version=STD&rules=IFR`);
    if (!res.ok) {
      const err = new Error(`charts index failed (${res.status})`);
      err.statusCode = res.status;
      throw err;
    }
    const data = await res.json();
    this._chartsCache.set(key, { t: Date.now(), data });
    return data;
  }

  async airportInfo(icao) {
    const res = await this._authedFetch(`${AIRPORT_API}/${encodeURIComponent(icao.toUpperCase())}`);
    if (!res.ok) {
      const err = new Error(`airport info failed (${res.status})`);
      err.statusCode = res.status;
      throw err;
    }
    return res.json();
  }

  /** Proxy a chart image. Only *.navigraph.com URLs are allowed. */
  async chartImage(imageUrl) {
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch (_) {
      const err = new Error('invalid url');
      err.statusCode = 400;
      throw err;
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.navigraph.com')) {
      const err = new Error('url not allowed');
      err.statusCode = 400;
      throw err;
    }
    const res = await this._authedFetch(parsed.href);
    if (!res.ok) {
      const err = new Error(`chart image failed (${res.status})`);
      err.statusCode = res.status;
      throw err;
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'image/png',
    };
  }

  /** Proxy an enroute tile. Cached in memory (LRU-ish, 30 min). */
  async tile(source, theme, z, x, y, retina) {
    if (!TILE_SOURCES.has(source) || !TILE_THEMES.has(theme)) {
      const err = new Error('unknown tile source/theme');
      err.statusCode = 400;
      throw err;
    }
    const suffix = retina ? '@2x.png' : '.png';
    const url = `${TILE_HOST}/styles/${source}.${theme}/${z}/${x}/${y}${suffix}`;
    const hit = this._tileCache.get(url);
    if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit;

    const res = await this._authedFetch(url);
    if (!res.ok) {
      const err = new Error(`tile failed (${res.status})`);
      err.statusCode = res.status;
      throw err;
    }
    const entry = {
      t: Date.now(),
      buf: Buffer.from(await res.arrayBuffer()),
      type: res.headers.get('content-type') || 'image/png',
    };
    this._tileCache.set(url, entry);
    if (this._tileCache.size > 600) {
      // drop the oldest third
      const keys = [...this._tileCache.keys()].slice(0, 200);
      for (const k of keys) this._tileCache.delete(k);
    }
    return entry;
  }
}

module.exports = { NavigraphClient };
