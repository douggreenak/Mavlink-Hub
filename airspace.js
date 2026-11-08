'use strict';
// Airspace service for the hub. Fetches FAA airspace data for the area the dashboard is looking
// at, caches it on disk so it keeps working offline, and merges in any GeoJSON files the user
// drops in DATA_DIR/airspace/. The browser only ever talks to the hub.
//
// Sources (all public FAA data; see the README for terms and caveats):
//   controlled  Class B/C/D and surface-area Class E   (FAA Class_Airspace)
//   special     Prohibited / restricted / warning / alert / MOA, national-defense and
//               national-security UAS restrictions      (FAA Special_Use_Airspace and friends)
//   tfr         Current temporary flight restrictions   (FAA TFR GeoServer)
//   uasfm       FAA drone ceiling grid (LAANC)          (FAA UAS Facility Map)
//   sites       FAA-recognised recreational flying sites
// ADVISORY ONLY: data can be out of date or incomplete. It is not a substitute for official sources.
const fs = require('fs'), path = require('path');

const DAY = 864e5;
const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const TFR_WFS = 'https://tfr.faa.gov/geoserver/TFR/ows';

// ---- small helpers (exported for tests) ----
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; };
// FAA altitude fields: a value plus a unit ("FT" or "FL"); -9998 and friends mean "not a number".
function feet(val, uom) { const n = num(val); if (n == null || n <= -9990) return null; return /^FL/i.test(uom || '') ? n * 100 : n; }
function altTxt(ft) { if (ft == null) return null; if (ft === 0) return 'SFC'; if (ft >= 18000) return 'FL' + Math.round(ft / 100); return Math.round(ft).toLocaleString('en-US') + ' ft'; }
const KEEP_UPPER = new Set(['AFB', 'AAF', 'NAS', 'MOA', 'MCAS', 'AAS', 'ANGB', 'JRB', 'ARB', 'AFRC', 'USA', 'US', 'TFR', 'UAS', 'DC', 'AK', 'II', 'III', 'IV', 'ICAO', 'FAA', 'NOTAM', 'MCALF', 'NOLF', 'RAF', 'SFC']);
function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map((w) => {
    if (KEEP_UPPER.has(w) || /^[A-Z]{1,2}-?\d+[A-Z]?$/.test(w) || /^\d/.test(w)) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}
function geomBBox(g) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; } else for (const x of c) walk(x); };
  if (g && g.coordinates) walk(g.coordinates);
  return [w, s, e, n];
}
const sane = (bb) => bb[0] >= -180 && bb[2] <= 180 && bb[1] >= -90 && bb[3] <= 90 && bb[0] <= bb[2] && bb[1] <= bb[3];
const overlaps = (a, box) => a[0] <= box.e && a[2] >= box.w && a[1] <= box.n && a[3] >= box.s;
const clip = (s, n = 220) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---- normalisation: one FAA feature -> the shape the dashboard draws ----
// Returns null for anything that should not be shown (Class A, mode-C veil, floors above maxFloorFt...).
function normalizeFeature(source, f, opts = {}) {
  const maxFloorFt = opts.maxFloorFt ?? 400, p = f.properties || {}, g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return null;
  const out = { kind: null, name: '', floorFt: null, ceilFt: null, note: '' };
  switch (source) {
    case 'class': {
      const cls = String(p.CLASS || '').toUpperCase();
      if (!'BCDE'.includes(cls) || !cls) return null;
      out.kind = 'class-' + cls.toLowerCase(); out.name = titleCase(p.NAME);
      out.floorFt = feet(p.LOWER_VAL, p.LOWER_UOM); out.ceilFt = feet(p.UPPER_VAL, p.UPPER_UOM);
      out.note = clip([p.ICAO_ID && 'Airport ' + p.ICAO_ID, p.LOCAL_TYPE && p.LOCAL_TYPE.replace('_', ' ')].filter(Boolean).join(' · '));
      break;
    }
    case 'sua': {
      const t = String(p.TYPE_CODE || '').toUpperCase();
      out.kind = { P: 'prohibited', R: 'restricted', W: 'warning', A: 'alert', D: 'danger', MOA: 'moa' }[t] || 'special';
      out.name = titleCase(p.NAME); out.floorFt = feet(p.LOWER_VAL, p.LOWER_UOM); out.ceilFt = feet(p.UPPER_VAL, p.UPPER_UOM);
      out.note = clip([p.TIMESOFUSE && 'Times of use: ' + p.TIMESOFUSE, p.REMARKS].filter(Boolean).join(' · '));
      break;
    }
    case 'nda': out.kind = 'nda'; out.name = titleCase(p.NAME || 'National defense airspace'); out.floorFt = 0; out.note = 'National defense airspace TFR area. Check the NOTAM for details.'; break;
    case 'nsuas': {
      out.kind = 'nsuas'; out.name = titleCase([p.Facility, p.Base].filter(Boolean)[0] || 'National security UAS restriction');
      out.floorFt = feet(p.Floor, 'FT'); out.ceilFt = feet(p.Ceiling, 'FT');
      out.note = clip(['Part-time national security UAS flight restriction', p.Reason, p.Airspace].filter(Boolean).join(' · '));
      break;
    }
    case 'tfr': {
      out.kind = 'tfr'; out.name = clip(p.TITLE || 'Temporary flight restriction', 120); out.floorFt = 0;
      out.note = `${p.LEGAL ? titleCase(p.LEGAL) + ' TFR. ' : ''}NOTAM ${String(p.NOTAM_KEY || '').split('-')[0]}. Altitudes and times are in the NOTAM: check tfr.faa.gov before flying.`;
      break;
    }
    case 'uasfm': {
      const c = num(p.CEILING); if (c == null) return null;
      out.kind = 'uasfm'; out.name = titleCase(p.APT1_NAME || 'Airport area'); out.floorFt = 0; out.ceilFt = c; out.ceilingFt = c;
      out.note = 'FAA UAS Facility Map: highest altitude (AGL) that can be authorised in this grid cell. 0 means no flight without special authorisation.';
      break;
    }
    case 'sites': {
      out.kind = 'site'; out.name = clip(p.SITE_NAME || 'Recreational flying site', 80); out.floorFt = 0;
      out.ceilFt = num(p.CEILING); out.note = clip(['FAA-recognised recreational flying site', p.CEILING != null && `ceiling ${p.CEILING} ${p.UNIT || 'ft'}`, p.POC && 'contact ' + p.POC].filter(Boolean).join(' · '));
      break;
    }
    default: return null;
  }
  if (out.floorFt != null && out.floorFt > maxFloorFt && out.kind !== 'tfr') return null;   // not relevant to low flying
  const bb = geomBBox(g); if (!sane(bb)) return null;
  const cx = Math.round((bb[0] + bb[2]) * 5e3), cy = Math.round((bb[1] + bb[3]) * 5e3);
  const key = [out.kind, out.name, out.floorFt, out.ceilFt, cx, cy].join('|');
  return { type: 'Feature', geometry: g, properties: { key, kind: out.kind, name: out.name, floorFt: out.floorFt, ceilFt: out.ceilFt, floorTxt: altTxt(out.floorFt), ceilTxt: altTxt(out.ceilFt), ...(out.ceilingFt != null ? { ceilingFt: out.ceilingFt } : {}), note: out.note, bb } };
}

// ---- layer definitions ----
const arc = (service, source, fields, extra = {}) => ({ type: 'arcgis', service, source, fields, ...extra });
const LAYERS = {
  controlled: { cell: 1, ttl: 14 * DAY, maxSpan: 4, sources: [arc('Class_Airspace', 'class', 'NAME,CLASS,LOCAL_TYPE,ICAO_ID,UPPER_VAL,UPPER_UOM,LOWER_VAL,LOWER_UOM', { where: "CLASS <> 'A'" })] },
  special: {
    cell: 1, ttl: 14 * DAY, maxSpan: 4, sources: [
      arc('Special_Use_Airspace', 'sua', 'NAME,TYPE_CODE,UPPER_VAL,UPPER_UOM,LOWER_VAL,LOWER_UOM,TIMESOFUSE,REMARKS'),
      arc('National_Defense_Airspace_TFR_Areas', 'nda', 'NAME,TYPE_CODE'),
      arc('Part_Time_National_Security_UAS_Flight_Restrictions', 'nsuas', 'Facility,Base,Reason,Airspace,Floor,Ceiling')]
  },
  tfr: { cell: 2, ttl: 10 * 60e3, maxSpan: 6, sources: [{ type: 'wfs', source: 'tfr' }] },
  uasfm: { cell: 0.1, ttl: 14 * DAY, maxSpan: 0.7, sources: [arc('FAA_UAS_FacilityMap_Data', 'uasfm', 'CEILING,APT1_NAME', { offset: 0.00015 })] },
  sites: { cell: 2, ttl: 30 * DAY, maxSpan: 6, sources: [arc('Recreational_Flyer_Fixed_Sites', 'sites', 'SITE_NAME,CEILING,UNIT,POC')] },
};
const LAYER_IDS = [...Object.keys(LAYERS), 'local'];
const MAX_CELLS = 48, PAGE = 2000, MAX_PAGES = 5;

// Grid cells (of `size` degrees) covering a bounding box, as {ix, iy, w, s, e, n}.
function cellsFor(box, size) {
  const out = [], x0 = Math.floor((box.w + 180) / size), x1 = Math.floor((box.e + 180) / size), y0 = Math.floor((box.s + 90) / size), y1 = Math.floor((box.n + 90) / size);
  for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
    out.push({ ix, iy, w: +(ix * size - 180).toFixed(6), s: +(iy * size - 90).toFixed(6), e: +((ix + 1) * size - 180).toFixed(6), n: +((iy + 1) * size - 90).toFixed(6) });
  }
  return out;
}

function createAirspace({ dir, fetchJSON, now = Date.now, faaBase = FAA, tfrBase = TFR_WFS, maxFloorFt = 400, remote = true, concurrency = 4, failBackoffMs = 60e3 }) {
  const inflight = new Map(), failed = new Map();
  // One file per layer, cell and source: a layer built from several FAA services keeps what did arrive when one fails.
  const cacheFile = (layer, c, i = 0) => path.join(dir, 'cache', layer, `${c.ix}_${c.iy}${LAYERS[layer].sources.length > 1 ? '_' + i : ''}.json`);
  const readCache = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  function writeCache(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); }

  function url(src, c) {
    if (src.type === 'wfs') return `${tfrBase}?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&outputFormat=application/json&bbox=${c.w},${c.s},${c.e},${c.n},EPSG:4326`;
    const q = new URLSearchParams({ where: src.where || '1=1', geometry: `${c.w},${c.s},${c.e},${c.n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: src.fields, outSR: '4326', maxAllowableOffset: String(src.offset ?? 0.0004), geometryPrecision: '5', resultRecordCount: String(PAGE), f: 'geojson' });
    return { base: `${faaBase}/${src.service}/FeatureServer/0/query?`, q };
  }
  async function fetchSource(src, c) {
    const feats = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const u = url(src, c), full = typeof u === 'string' ? u : u.base + u.q.toString() + (page ? `&resultOffset=${page * PAGE}` : '');
      const body = await fetchJSON(full);
      if (body && body.error) throw new Error(`${src.service || 'TFR service'}: ${body.error.message || body.error.code || 'error'}`);
      if (!body || !Array.isArray(body.features)) throw new Error(`${src.service || 'TFR service'}: unexpected reply`);
      feats.push(...body.features);
      if (src.type === 'wfs' || !(body.properties && body.properties.exceededTransferLimit)) break;
    }
    return feats.map((f) => normalizeFeature(src.source, f, { maxFloorFt })).filter(Boolean);
  }
  // One grid cell of one layer: every source separately, then merged. The oldest data sets the reported age.
  async function getCell(layer, c) {
    const res = await Promise.all(LAYERS[layer].sources.map((_, i) => getSourceCell(layer, i, c)));
    const ages = res.map((r) => r.fetched).filter((x) => x != null), err = res.map((r) => r.error).find(Boolean);
    const out = { features: res.flatMap((r) => r.features), fetched: ages.length ? Math.min(...ages) : null };
    if (res.some((r) => r.stale)) out.stale = true;
    if (err) out.error = err;
    return out;
  }
  // One source in one cell: fresh cache, else fetch (and save), else stale cache, else an error.
  async function getSourceCell(layer, i, c) {
    const def = LAYERS[layer], f = cacheFile(layer, c, i), cached = readCache(f), t = now();
    if (cached && t - cached.fetched < def.ttl) return { features: cached.features, fetched: cached.fetched };
    const k = f; if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      const lastFail = failed.get(k);
      if (!remote) return cached ? { features: cached.features, fetched: cached.fetched, stale: true } : { features: [], fetched: null, error: 'Airspace download is switched off (AIRSPACE=off) and nothing is saved for this area.' };
      if (lastFail && t - lastFail.at < failBackoffMs) return cached ? { features: cached.features, fetched: cached.fetched, stale: true, error: lastFail.msg } : { features: [], fetched: null, error: lastFail.msg };
      try {
        const feats = await fetchSource(def.sources[i], c);
        const o = { fetched: t, features: feats }; try { writeCache(f, o); } catch (e) { /* a read-only disk should not break the map */ }
        failed.delete(k); return { features: feats, fetched: t };
      } catch (e) {
        const msg = `Could not reach the FAA (${e.message})`; failed.set(k, { at: t, msg });
        return cached ? { features: cached.features, fetched: cached.fetched, stale: true, error: msg } : { features: [], fetched: null, error: msg };
      }
    })();
    inflight.set(k, p); p.finally(() => inflight.delete(k));   // cleared on every path, including the early returns
    return p;
  }
  async function mapLimit(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } })); return out; }

  async function layer(id, box) {
    const def = LAYERS[id], span = Math.max(box.e - box.w, box.n - box.s);
    if (span > def.maxSpan) return { features: [], fetched: null, stale: false, errors: [], skipped: 'zoom in to see this layer' };
    const cells = cellsFor(box, def.cell);
    if (cells.length > MAX_CELLS) return { features: [], fetched: null, stale: false, errors: [], skipped: 'zoom in to see this layer' };
    const res = await mapLimit(cells, concurrency, (c) => getCell(id, c));
    const seen = new Set(), features = [], errors = new Set(); let fetched = null, stale = false;
    for (const r of res) {
      if (r.error) errors.add(r.error);
      if (r.stale) stale = true;
      if (r.fetched != null) fetched = fetched == null ? r.fetched : Math.min(fetched, r.fetched);
      for (const f of r.features) if (!seen.has(f.properties.key) && overlaps(f.properties.bb, box)) { seen.add(f.properties.key); features.push(f); }
    }
    return { features, fetched, stale, errors: [...errors], skipped: null };
  }

  // ---- the user's own GeoJSON files: DATA_DIR/airspace/*.geojson ----
  const localCache = new Map();
  function circle(lon, lat, r) { const pts = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * 2 * Math.PI; pts.push([+(lon + (r * Math.sin(a)) / (111320 * Math.cos(lat * Math.PI / 180))).toFixed(6), +(lat + (r * Math.cos(a)) / 111320).toFixed(6)]); } return { type: 'Polygon', coordinates: [pts] }; }
  function loadLocal() {
    const feats = [], errors = [];
    let files = []; try { files = fs.readdirSync(dir).filter((n) => /\.(geo)?json$/i.test(n)); } catch (e) { return { feats, errors }; }
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file), c = localCache.get(file);
        let parsed = c && c.mtime === st.mtimeMs ? c.feats : null;
        if (!parsed) {
          const j = JSON.parse(fs.readFileSync(file, 'utf8')); parsed = [];
          const list = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [];
          list.forEach((f, i) => {
            const p = f.properties || {}; let g = f.geometry;
            if (g && g.type === 'Point' && num(p.radius_m ?? p.radius) > 0) g = circle(g.coordinates[0], g.coordinates[1], num(p.radius_m ?? p.radius));
            if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
            const bb = geomBBox(g); if (!sane(bb)) return;
            const floorFt = num(p.floorFt ?? p.floor), ceilFt = num(p.ceilFt ?? p.ceiling ?? p.ceil);
            const kind = ['prohibited', 'restricted', 'warning', 'alert', 'danger', 'tfr', 'class-b', 'class-c', 'class-d', 'class-e', 'moa', 'site'].includes(p.kind) ? p.kind : 'custom';
            parsed.push({ type: 'Feature', geometry: g, properties: { key: `local|${name}|${i}`, kind, name: clip(p.name || p.NAME || p.title || name, 120), floorFt, ceilFt, floorTxt: altTxt(floorFt), ceilTxt: altTxt(ceilFt), note: clip(p.note || p.description || 'From ' + name), bb } });
          });
          localCache.set(file, { mtime: st.mtimeMs, feats: parsed });
        }
        feats.push(...parsed);
      } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    return { feats, errors };
  }
  function local(box) {
    const { feats, errors } = loadLocal();
    return { features: feats.filter((f) => overlaps(f.properties.bb, box)), fetched: null, stale: false, errors, skipped: null, local: true };
  }

  // Everything for a request. `layers` is a list of ids from LAYER_IDS.
  async function query(layers, box) {
    const out = {};
    await Promise.all(layers.map(async (id) => { out[id] = id === 'local' ? local(box) : await layer(id, box); }));
    return { layers: out, advisory: 'Advisory only. Data may be out of date or incomplete; check official sources (FAA B4UFLY, NOTAMs) before flying.' };
  }
  return { query, cellsFor, local };
}

module.exports = { createAirspace, normalizeFeature, cellsFor, feet, altTxt, titleCase, geomBBox, LAYERS, LAYER_IDS, FAA, TFR_WFS };
