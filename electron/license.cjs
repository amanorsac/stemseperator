/**
 * Licensing, as the studio's License Integration Standard (v1.1) lays it out,
 * plus the free trial in front of it.
 *
 * The customer types a key once. The app sends the key and its own random
 * device id to the studio's server and gets back a proof: a JSON body and an
 * ECDSA signature over it. The proof is trusted only after that signature
 * verifies against the studio's public key compiled in below (R2, R3), and
 * only if it names this device and this key (R5). A verified proof is stored
 * encrypted with the operating system's key store (R7) and refreshed about
 * hourly (R9). With no internet, it keeps the app licensed until its grace
 * date, thirty days from when it was issued (R8).
 *
 * Before any of that, the app is free for a handful of songs. The trial
 * counts songs separated on this machine, by their audio fingerprint, so
 * reopening one from the library is never charged twice. When the count is
 * used up, separating needs a key; everything already separated stays
 * playable and exportable.
 */

const { app, safeStorage } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/** R1: the shipped build talks to the studio. The override is for development only. */
const DEFAULT_SERVER = 'https://amanorsac.studio';
const SERVER = (process.env.EASY_STEMS_LICENSE_SERVER || DEFAULT_SERVER).replace(/\/+$/, '');

/** R2: the studio's signing key, raw SEC1 uncompressed point, byte for byte from §5. */
const STUDIO_SIGNING_KEY = Buffer.from([
  0x04, 0xcd, 0xa5, 0x7d, 0x1c, 0xc8, 0xa6, 0xe2, 0x71, 0xd5, 0x48, 0x49,
  0xce, 0x55, 0xd5, 0x03, 0x77, 0x56, 0x66, 0x90, 0xfd, 0xb6, 0x95, 0x45,
  0xa4, 0x1a, 0x92, 0xc4, 0x77, 0xda, 0xcb, 0x00, 0x0d, 0x2c, 0x06, 0x0b,
  0xa8, 0x3f, 0xbd, 0x9b, 0x70, 0x85, 0xaf, 0xff, 0xc0, 0x42, 0xd4, 0x00,
  0x7e, 0x5b, 0x96, 0xfe, 0x68, 0xff, 0xec, 0x91, 0x11, 0xf6, 0x21, 0x00,
  0x79, 0xfc, 0x43, 0x59, 0x52,
]);

/**
 * A different key is accepted only for a development server named on the
 * command line of a test run; the shipped binary carries the studio key and
 * nothing else.
 */
function signingKey() {
  const dev = process.env.EASY_STEMS_LICENSE_DEV_PUBKEY;
  if (dev && SERVER !== DEFAULT_SERVER) return Buffer.from(dev, 'hex');
  return STUDIO_SIGNING_KEY;
}

/** How many songs may be separated before a key is needed. */
const TRIAL_SONGS = 5;

const HOUR = 60 * 60 * 1000;
const KEY_SHAPE = /^[A-Z0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;

const base64url = {
  decode(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
    return Buffer.from(padded, 'base64');
  },
};

/**
 * §5, exactly: split, decode, a 64-byte raw signature, ECDSA P-256 over
 * SHA-256 of the body bytes as received, and only then parse the JSON.
 */
function verifyProof(proof, deviceKey, licenseKey) {
  if (typeof proof !== 'string' || !proof.includes('.')) throw new Error('bad_proof');
  const dot = proof.indexOf('.');
  const body = base64url.decode(proof.slice(0, dot));
  const signature = base64url.decode(proof.slice(dot + 1));
  if (signature.length !== 64) throw new Error('bad_proof');
  const pub = signingKey();
  const key = crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') },
  });
  if (!crypto.verify('sha256', body, { key, dsaEncoding: 'ieee-p1363' }, signature)) throw new Error('bad_signature');
  const claims = JSON.parse(body.toString('utf8'));
  if (claims.deviceKey !== deviceKey || claims.licenseKey !== licenseKey) throw new Error('proof_mismatch');
  for (const field of ['issuedAt', 'expiresAt', 'graceUntil']) {
    if (!Number.isFinite(claims[field])) throw new Error('bad_proof');
  }
  return claims;
}

/** Licensed means: verified, ours, within grace, and the clock not wound back past it (§5). */
function proofIsLive(claims, now = Date.now()) {
  return now <= claims.graceUntil && now >= claims.issuedAt - 48 * HOUR;
}

class LicenseClient {
  constructor(folder) {
    this.folder = folder;
    this.files = {
      device: path.join(folder, 'device.id'),
      key: path.join(folder, 'license-key.dat'),
      proof: path.join(folder, 'license-proof.dat'),
      trial: path.join(folder, 'trial.dat'),
    };
    this.key = '';
    this.claims = null;
    this.trial = { songs: [] };
    this.timer = null;
    this.lastError = '';
  }

  /* ------------------------------------------------------------ storage */

  /** R7: encrypted with DPAPI / Keychain through Electron's safeStorage. */
  seal(text) {
    if (safeStorage.isEncryptionAvailable()) return Buffer.concat([Buffer.from('v1:'), safeStorage.encryptString(text)]);
    // No key store on this machine (a bare Linux test box): stored as is,
    // marked so it is never mistaken for an encrypted blob.
    return Buffer.concat([Buffer.from('p1:'), Buffer.from(text, 'utf8')]);
  }

  unseal(blob) {
    const tag = blob.subarray(0, 3).toString();
    const body = blob.subarray(3);
    if (tag === 'v1:') return safeStorage.decryptString(body);
    if (tag === 'p1:') return body.toString('utf8');
    throw new Error('unreadable');
  }

  readSealed(file) {
    try { return this.unseal(fs.readFileSync(file)); } catch { return null; }
  }

  writeSealed(file, text) {
    fs.mkdirSync(this.folder, { recursive: true });
    fs.writeFileSync(file, this.seal(text));
  }

  /** R6: a random id made once, never anything about the hardware or the person. */
  deviceId() {
    try {
      const id = fs.readFileSync(this.files.device, 'utf8').trim();
      if (id.length >= 16 && id.length <= 128) return id;
    } catch { /* first run */ }
    const id = crypto.randomUUID();
    fs.mkdirSync(this.folder, { recursive: true });
    fs.writeFileSync(this.files.device, id);
    return id;
  }

  load() {
    this.key = (this.readSealed(this.files.key) || '').trim();
    this.claims = null;
    const proof = this.readSealed(this.files.proof);
    if (proof && this.key) {
      try {
        const claims = verifyProof(proof, this.deviceId(), this.key);
        if (proofIsLive(claims)) this.claims = claims;
        else fs.rmSync(this.files.proof, { force: true }); // stale: behave as "key but no proof"
      } catch {
        fs.rmSync(this.files.proof, { force: true });
      }
    }
    try {
      const trial = JSON.parse(this.readSealed(this.files.trial) || '{}');
      this.trial = { songs: Array.isArray(trial.songs) ? trial.songs.filter(s => typeof s === 'string') : [] };
    } catch { this.trial = { songs: [] }; }
  }

  saveTrial() {
    this.writeSealed(this.files.trial, JSON.stringify(this.trial));
  }

  /* ------------------------------------------------------------- state */

  get licensed() {
    return Boolean(this.claims) && proofIsLive(this.claims);
  }

  status() {
    const used = this.trial.songs.length;
    return {
      licensed: this.licensed,
      hasKey: Boolean(this.key),
      keyTail: this.key ? this.key.slice(-4) : '',
      expiresAt: this.claims?.expiresAt || 0,
      graceUntil: this.claims?.graceUntil || 0,
      // Past expiresAt but inside grace: still licensed, a quiet nudge is due.
      needsConnection: Boolean(this.claims) && Date.now() > this.claims.expiresAt,
      trial: { limit: TRIAL_SONGS, used, remaining: Math.max(0, TRIAL_SONGS - used) },
      lastError: this.lastError,
      server: SERVER,
    };
  }

  /** May this song be separated: licensed, or already one of the trial's, or room left. */
  canSeparate(songId) {
    if (this.licensed) return true;
    if (this.trial.songs.includes(songId)) return true;
    return this.trial.songs.length < TRIAL_SONGS;
  }

  /** A trial song separated: counted once, by fingerprint. */
  recordSong(songId) {
    if (this.licensed || this.trial.songs.includes(songId)) return;
    this.trial.songs.push(songId);
    this.saveTrial();
  }

  /* ------------------------------------------------------------ network */

  async post(route, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`${SERVER}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let data = {};
      try { data = await response.json(); } catch { /* no body */ }
      return { status: response.status, data };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Activate (or, for a device that already holds a seat, refresh). Resolves
   * with the status; rejects with an Error whose `code` is one of §4's, or
   * `offline`, `bad_signature`, `proof_mismatch`.
   */
  async activate(rawKey, { quiet = false } = {}) {
    const key = String(rawKey || this.key).trim().toUpperCase();
    if (!KEY_SHAPE.test(key)) throw Object.assign(new Error('That is not the shape of a licence key.'), { code: 'invalid_key' });
    const deviceKey = this.deviceId();
    let reply;
    try {
      reply = await this.post('/licenses/activate', { licenseKey: key, deviceKey, deviceLabel: os.hostname().slice(0, 120) });
    } catch (error) {
      throw Object.assign(new Error('The licence server could not be reached.'), { code: 'offline', cause: error });
    }
    if (reply.status < 200 || reply.status >= 300) {
      const code = reply.data?.error || `http_${reply.status}`;
      const messages = {
        no_such_license: 'That key is not one of ours. Check it under My Apps on amanorsac.studio.',
        device_limit_reached: 'Every seat on this key is in use. Remove a device under My Apps, or deactivate it on the other machine.',
        invalid_request: 'The activation request was not accepted.',
        upstream_error: reply.data?.message || 'The licence server could not reach its database. Try again later.',
        licensing_unavailable: reply.data?.message || 'Licensing is not available right now. Try again later.',
      };
      throw Object.assign(new Error(messages[code] || 'Activation failed.'), { code, devices: reply.data?.devices, maxDevices: reply.data?.max_devices });
    }
    let claims;
    try {
      claims = verifyProof(reply.data?.proof, deviceKey, key);
    } catch (error) {
      // R4: the server said yes, but the proof is not the studio's. Not activated.
      throw Object.assign(new Error('The licence could not be verified. Nothing was activated.'), { code: error.message === 'proof_mismatch' ? 'proof_mismatch' : 'bad_signature' });
    }
    this.key = key;
    this.claims = claims;
    this.writeSealed(this.files.key, key);
    this.writeSealed(this.files.proof, reply.data.proof); // only after it verified (R3)
    this.lastError = '';
    if (!quiet) this.startHeartbeat();
    return this.status();
  }

  /** R10: free the seat, forget the key and the proof. */
  async deactivate() {
    if (!this.key) return this.status();
    let reply;
    try {
      reply = await this.post('/licenses/deactivate', { licenseKey: this.key, deviceKey: this.deviceId() });
    } catch (error) {
      throw Object.assign(new Error('The licence server could not be reached. Try again when you are online.'), { code: 'offline', cause: error });
    }
    if (!((reply.status >= 200 && reply.status < 300) || reply.status === 404)) {
      throw Object.assign(new Error(reply.data?.message || 'Deactivation did not go through. Try again later.'), { code: reply.data?.error || `http_${reply.status}` });
    }
    this.key = '';
    this.claims = null;
    fs.rmSync(this.files.key, { force: true });
    fs.rmSync(this.files.proof, { force: true });
    this.stopHeartbeat();
    return this.status();
  }

  /** R9: hourly while open; a failure keeps the proof it has. */
  async heartbeat() {
    if (!this.key) return;
    try {
      await this.activate(this.key, { quiet: true });
    } catch (error) {
      this.lastError = error.code || 'offline';
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.timer = setInterval(() => void this.heartbeat(), HOUR);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** §7 startup: a live proof unlocks at once; a key with no proof activates now. */
  async start() {
    this.load();
    if (this.key) {
      if (!this.claims) await this.heartbeat();
      else void this.heartbeat();
      this.startHeartbeat();
    }
    return this.status();
  }
}

module.exports = { LicenseClient, verifyProof, proofIsLive, TRIAL_SONGS, DEFAULT_SERVER, STUDIO_SIGNING_KEY };
