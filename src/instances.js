/**
 * instances.js
 * Manages lists of Invidious and Piped public instances.
 * Tracks health/success stats and rotates through them intelligently.
 */

'use strict';

// ─── Static Invidious instances ───────────────────────────────────────────────
const INVIDIOUS_INSTANCES_STATIC = [
  'https://invidious.snopyta.org',
  'https://invidious.kavin.rocks',
  'https://invidious.nerdvpn.de',
  'https://inv.riverside.rocks',
  'https://invidious.slipfox.xyz',
  'https://invidious.privacydev.net',
  'https://vid.puffyan.us',
  'https://yt.artemislena.eu',
  'https://invidious.flokinet.to',
  'https://invidious.projectsegfau.lt',
  'https://invidious.sethforprivacy.com',
  'https://invidious.tiekoetter.com',
  'https://invidious.baczek.me',
  'https://inv.vern.cc',
  'https://invidious.lunar.icu',
  'https://iv.melmac.space',
  'https://invidious.darkness.services',
  'https://invidious.private.coffee',
  'https://invidious.drgns.space',
  'https://invidious.adminforge.de',
  'https://invidious.reallyaweso.me',
  'https://invidious.codespace.cz',
  'https://y.com.sb',
  'https://invidious.io',
];

// ─── Static Piped API instances ──────────────────────────────────────────────
const PIPED_API_INSTANCES_STATIC = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://pipedapi-libre.kavin.rocks',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.owo.si',
  'https://pipedapi.ducks.party',
  'https://piped-api.codespace.cz',
  'https://pipedapi.reallyaweso.me',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services',
  'https://pipedapi.orangenet.cc',
];

// ─── Instance health tracking ─────────────────────────────────────────────────
class InstanceManager {
  constructor() {
    this.invidiousInstances = INVIDIOUS_INSTANCES_STATIC.map((url) =>
      this._createEntry(url, 'invidious'),
    );
    this.pipedInstances = PIPED_API_INSTANCES_STATIC.map((url) =>
      this._createEntry(url, 'piped'),
    );

    // Refresh dynamic instance lists every 30 minutes
    this._refreshDynamic();
    setInterval(() => this._refreshDynamic(), 30 * 60 * 1000);
  }

  _createEntry(url, type) {
    return {
      url,
      type,
      successCount: 0,
      failureCount: 0,
      lastUsed: 0,
      lastSuccess: 0,
      avgLatencyMs: 999999,
      disabled: false,
    };
  }

  /** Score = success rate weighted by recency, penalised for failures */
  _score(entry) {
    if (entry.disabled) return -Infinity;
    const total = entry.successCount + entry.failureCount;
    if (total === 0) return 0.5; // Unknown → neutral
    const rate = entry.successCount / total;
    const latencyPenalty = Math.min(entry.avgLatencyMs / 10000, 1);
    return rate - latencyPenalty * 0.3;
  }

  /** Return instances sorted best-first */
  _sorted(list) {
    return [...list]
      .filter((e) => !e.disabled)
      .sort((a, b) => this._score(b) - this._score(a));
  }

  getInvidiousInstances() {
    return this._sorted(this.invidiousInstances);
  }

  getPipedInstances() {
    return this._sorted(this.pipedInstances);
  }

  /** Get all instances combined (Piped first as they tend to be more reliable) */
  getAllInstances() {
    return [
      ...this._sorted(this.pipedInstances).map((e) => ({ ...e, apiType: 'piped' })),
      ...this._sorted(this.invidiousInstances).map((e) => ({ ...e, apiType: 'invidious' })),
    ];
  }

  recordSuccess(url, latencyMs) {
    const entry = this._findEntry(url);
    if (!entry) return;
    entry.successCount++;
    entry.lastSuccess = Date.now();
    entry.lastUsed = Date.now();
    // Exponential moving average
    entry.avgLatencyMs =
      entry.avgLatencyMs === 999999
        ? latencyMs
        : entry.avgLatencyMs * 0.7 + latencyMs * 0.3;
  }

  recordFailure(url) {
    const entry = this._findEntry(url);
    if (!entry) return;
    entry.failureCount++;
    entry.lastUsed = Date.now();

    // Temporarily disable if too many consecutive failures
    const total = entry.successCount + entry.failureCount;
    if (total >= 5 && entry.successCount / total < 0.1) {
      console.warn(`[InstanceManager] Disabling unreliable instance: ${url}`);
      entry.disabled = true;
      // Re-enable after 10 minutes
      setTimeout(() => {
        console.info(`[InstanceManager] Re-enabling instance: ${url}`);
        entry.disabled = false;
      }, 10 * 60 * 1000);
    }
  }

  _findEntry(url) {
    return (
      this.invidiousInstances.find((e) => e.url === url) ||
      this.pipedInstances.find((e) => e.url === url)
    );
  }

  /** Fetch dynamic Invidious instance list from official API */
  async _refreshDynamic() {
    try {
      const { default: axios } = await import('axios');
      const resp = await axios.get('https://api.invidious.io/instances.json', {
        timeout: 8000,
      });
      if (Array.isArray(resp.data)) {
        for (const [domain, info] of resp.data) {
          if (info?.type === 'https' && info?.api === true) {
            const url = `https://${domain}`;
            const exists = this.invidiousInstances.find((e) => e.url === url);
            if (!exists) {
              this.invidiousInstances.push(this._createEntry(url, 'invidious'));
              console.info(`[InstanceManager] Added new Invidious instance: ${url}`);
            }
          }
        }
      }
    } catch {
      // Silently ignore — we still have the static list
    }
  }

  stats() {
    const fmt = (list) =>
      list.map((e) => ({
        url: e.url,
        type: e.type,
        success: e.successCount,
        failure: e.failureCount,
        avgLatencyMs: Math.round(e.avgLatencyMs),
        disabled: e.disabled,
        score: +this._score(e).toFixed(3),
      }));
    return {
      invidious: fmt(this.invidiousInstances),
      piped: fmt(this.pipedInstances),
    };
  }
}

export const instanceManager = new InstanceManager();
