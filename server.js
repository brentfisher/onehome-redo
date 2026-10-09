#!/usr/bin/env node
// Big-screen viewer for a OneHome saved search. No dependencies: `node server.js`.
// Read-only: it only ever asks OneHome for the search, its listings and their photos.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const PORT = Number(process.env.PORT) || 3210;
const API = 'https://services.onehome.com';
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const UPSTREAM_TIMEOUT_MS = 20000;
// Photo URLs are signed and stop working 30 minutes after they are issued.
const MEDIA_TTL_MS = 20 * 60 * 1000;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const LINK_CHECK_MS = 10 * 60 * 1000;
const GEOCODER = 'https://nominatim.openstreetmap.org/search';
const GEOCODER_UA = 'onehome-bigscreen/1.0 (+https://github.com/brentfisher/onehome-redo)';

let link = loadLink();
let session = null; // { sessionToken, groupID, savedSearchID }
// Whether OneHome accepted the link last time we asked: true, false, or null for "not known".
let linkCheck = { ok: null, at: 0, error: null };
let sessionPromise = null;
let searchCache = null; // { at, data }
let searchPromise = null;
const details = new Map(); // listingId -> { at, data } | { promise }

function loadLink() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (saved.token) {
      const savedAt = saved.savedAt || fs.statSync(CONFIG_FILE).mtime.toISOString();
      return { token: saved.token, searchId: saved.searchId || '', savedAt };
    }
  } catch {}
  return { token: '', searchId: '', savedAt: null };
}

function setLink(next) {
  link = { ...next, savedAt: new Date().toISOString() };
  linkCheck = { ok: null, at: 0, error: null };
  session = null;
  sessionPromise = null;
  searchCache = null;
  searchPromise = null;
  details.clear();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(link, null, 2) + '\n');
}

// Accepts a full OneHome URL, or a bare token.
function parseLink(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const token = url.searchParams.get('token');
    if (!token) return null;
    return { token, searchId: url.searchParams.get('searchId') || '' };
  } catch {
    return /^[A-Za-z0-9+/=_-]{20,}$/.test(text) ? { token: decodeURIComponent(text), searchId: '' } : null;
  }
}

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function upstreamHeaders(extra) {
  return {
    'content-type': 'application/json',
    'user-agent': UA,
    origin: 'https://portal.onehome.com',
    referer: 'https://portal.onehome.com/',
    ...extra,
  };
}

async function openSession() {
  if (!link.token) throw new UpstreamError('No OneHome link yet. Paste the link from your agent’s email.', 401);
  const res = await fetch(`${API}/api/authentication/checkToken`, {
    method: 'POST',
    headers: upstreamHeaders(),
    body: JSON.stringify({ emailToken: link.token }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch {}
  // A 5xx says nothing about the link itself, so only 4xx marks it as rejected.
  if (res.status >= 500) throw new UpstreamError(`OneHome returned HTTP ${res.status}`, 502);
  if (!res.ok || !data?.sessionToken || !data?.groupID) {
    const error = res.ok ? 'OneHome did not return a session for this link' : `OneHome rejected the link (HTTP ${res.status})`;
    linkCheck = { ok: false, at: Date.now(), error };
    throw new UpstreamError(error, 401);
  }
  linkCheck = { ok: true, at: Date.now(), error: null };
  return data;
}

// Finds an expiry time inside a link token, if it carries one. OneHome's emailed
// links are plain JSON without one, but a signed token would have "exp".
function linkExpiry(token) {
  const decode = (part) => {
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
  };
  const parts = String(token).split('.');
  const claims = decode(parts.length === 3 ? parts[1] : parts[0]);
  const exp = Number(claims?.exp ?? claims?.expires ?? claims?.expiry);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return new Date(exp < 1e12 ? exp * 1000 : exp).toISOString();
}

async function linkStatus() {
  if (!link.token) return { hasLink: false };
  if (Date.now() - linkCheck.at > LINK_CHECK_MS) {
    try {
      const fresh = await openSession();
      session = fresh;
    } catch {}
  }
  return {
    hasLink: true,
    ok: linkCheck.ok,
    error: linkCheck.error,
    savedAt: link.savedAt,
    checkedAt: linkCheck.at ? new Date(linkCheck.at).toISOString() : null,
    expiresAt: linkExpiry(link.token),
  };
}

function getSession() {
  if (session) return Promise.resolve(session);
  if (!sessionPromise) {
    const mine = openSession().then(
      (s) => {
        if (sessionPromise === mine) { session = s; sessionPromise = null; }
        return s;
      },
      (err) => {
        if (sessionPromise === mine) sessionPromise = null;
        throw err;
      },
    );
    sessionPromise = mine;
  }
  return sessionPromise;
}

async function gql(query, variables, retried = false) {
  const s = await getSession();
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: upstreamHeaders({ authorization: `Bearer ${s.sessionToken}` }),
    body: JSON.stringify({ query, variables: variables(s) }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  const authFailed = res.status === 401 || res.status === 403
    || (json?.errors || []).some((e) => /unauthor|forbidden|expired|token/i.test(`${e.message} ${e.extensions?.classification}`));
  if (authFailed && !retried) {
    if (session === s) session = null;
    return gql(query, variables, true);
  }
  if (!res.ok || !json) throw new UpstreamError(`OneHome returned HTTP ${res.status}`, 502);
  if (json.errors?.length && !json.data) throw new UpstreamError(json.errors[0].message, 502);
  return json.data;
}

const SAVED_SEARCH_QUERY = `query($searchId: String!) {
  savedSearch(id: $searchId) { id name listingIds }
}`;

const LISTINGS_QUERY = `query($groupId: String!, $listingIds: [String!]!, $pageInput: PageInput, $savedSearchId: String!) {
  listingsBySavedSearchId(groupId: $groupId, osks: $listingIds, pageInput: $pageInput, savedSearchId: $savedSearchId, includeDislikes: false, suppressEvent: true) {
    pageInfo { totalElements totalPages pageNumber pageSize }
    listings {
      id
      property {
        StreetNumber StreetDirPrefix StreetName StreetSuffix StreetDirSuffix UnitNumber
        City StateOrProvince PostalCode
        ListPrice PreviousListPrice StandardStatus
        BedroomsTotal BathroomsTotalInteger
        LivingArea LivingAreaTotal AboveGradeFinishedArea BuildingAreaTotal
        LotSizeArea LotSizeUnits MajorChangeType Latitude Longitude
      }
      customProperty { LivingAreaRange }
    }
  }
}`;

const IMAGE_FIELDS = 'Large { mediaUrl width height } Medium { mediaUrl width height }';
const DETAIL_QUERY = `query($listingId: String!, $groupId: String!) {
  listingDetail(listingId: $listingId, groupId: $groupId, suppressEvent: true) {
    id
    property {
      StreetNumber StreetDirPrefix StreetName StreetSuffix StreetDirSuffix UnitNumber
      City StateOrProvince PostalCode CountyOrParish SubdivisionName
      ListPrice PreviousListPrice OriginalListPrice StandardStatus DaysOnMarket ListingId
      BedroomsTotal BathroomsTotalInteger BathroomsFull BathroomsHalf
      LivingArea LivingAreaTotal AboveGradeFinishedArea BelowGradeFinishedArea BuildingAreaTotal
      LotSizeArea LotSizeUnits Latitude Longitude YearBuilt StoriesTotal Levels ArchitecturalStyle
      GarageSpaces ParkingTotal ParkingFeatures Basement
      Heating Cooling Flooring Appliances InteriorFeatures ExteriorFeatures
      FireplacesTotal PoolPrivateYN PoolFeatures PatioAndPorchFeatures LotFeatures
      AssociationFee AssociationFeeFrequency CommunityFeatures
      TaxAnnualAmount TaxYear
      ElementarySchool MiddleOrJuniorSchool HighSchool
      PublicRemarks ListOfficeName ListAgentFullName
    }
    customProperty { LivingAreaRange }
    media { ShortDescription LongDescription MediaType Order Image { ${IMAGE_FIELDS} } }
    floorPlans { ShortDescription LongDescription MediaType Order Image { ${IMAGE_FIELDS} } }
  }
}`;

function address(p) {
  const street = [p.StreetNumber, p.StreetDirPrefix, p.StreetName, p.StreetSuffix, p.StreetDirSuffix]
    .filter(Boolean).join(' ');
  return {
    street: p.UnitNumber ? `${street} #${p.UnitNumber}` : street,
    cityLine: [[p.City, p.StateOrProvince].filter(Boolean).join(', '), p.PostalCode].filter(Boolean).join(' '),
  };
}

function sqft(p, custom) {
  return p.LivingArea || p.LivingAreaTotal || p.AboveGradeFinishedArea || p.BuildingAreaTotal
    || custom?.LivingAreaRange || null;
}

function summarize(listing) {
  const p = listing.property || {};
  return {
    id: listing.id,
    ...address(p),
    price: p.ListPrice,
    previousPrice: p.PreviousListPrice,
    status: p.StandardStatus,
    change: p.MajorChangeType,
    beds: p.BedroomsTotal,
    baths: p.BathroomsTotalInteger,
    sqft: sqft(p, listing.customProperty),
    lot: p.LotSizeArea,
    lotUnits: p.LotSizeUnits,
    lat: p.Latitude ?? null,
    lng: p.Longitude ?? null,
  };
}

async function fetchSearch() {
  const searchId = link.searchId || (await getSession()).savedSearchID;
  if (!searchId) throw new UpstreamError('This link has no saved search (searchId) attached', 400);
  const { savedSearch } = await gql(SAVED_SEARCH_QUERY, () => ({ searchId }));
  if (!savedSearch) throw new UpstreamError('Saved search not found', 404);

  const listings = [];
  for (let pageNum = 0, totalPages = 1; pageNum < totalPages; pageNum++) {
    const data = await gql(LISTINGS_QUERY, (s) => ({
      groupId: s.groupID,
      listingIds: savedSearch.listingIds || [],
      pageInput: { pageNum, size: 48 },
      savedSearchId: searchId,
    }));
    const page = data.listingsBySavedSearchId;
    listings.push(...(page.listings || []));
    totalPages = Math.min(page.pageInfo?.totalPages || 1, 50);
  }
  return { name: savedSearch.name, homes: listings.map(summarize) };
}

async function getSearch() {
  if (searchCache && Date.now() - searchCache.at < SEARCH_TTL_MS) return searchCache.data;
  if (!searchPromise) {
    const mine = fetchSearch().then(
      (data) => {
        if (searchPromise === mine) { searchCache = { at: Date.now(), data }; searchPromise = null; }
        return data;
      },
      (err) => {
        if (searchPromise === mine) searchPromise = null;
        throw err;
      },
    );
    searchPromise = mine;
  }
  return searchPromise;
}

function photoList(items, kind) {
  return (items || [])
    .filter((m) => m.Image?.Large?.mediaUrl || m.Image?.Medium?.mediaUrl)
    .sort((a, b) => (parseInt(a.Order, 10) || 0) - (parseInt(b.Order, 10) || 0))
    .map((m) => {
      const image = m.Image.Large?.mediaUrl ? m.Image.Large : m.Image.Medium;
      return {
        url: image.mediaUrl,
        width: Number(image.width) || null,
        height: Number(image.height) || null,
        caption: m.ShortDescription || m.LongDescription || '',
        kind,
      };
    });
}

async function fetchDetail(id) {
  const { listingDetail } = await gql(DETAIL_QUERY, (s) => ({ listingId: id, groupId: s.groupID }));
  if (!listingDetail) throw new UpstreamError('Listing not found', 404);
  const p = listingDetail.property || {};
  return {
    ...summarize(listingDetail),
    property: p,
    photos: [...photoList(listingDetail.media, 'photo'), ...photoList(listingDetail.floorPlans, 'floorplan')],
  };
}

function getDetail(id) {
  const entry = details.get(id);
  if (entry?.data && Date.now() - entry.at < MEDIA_TTL_MS) return Promise.resolve(entry.data);
  if (entry?.promise) return entry.promise;
  const promise = fetchDetail(id).then(
    (data) => {
      if (details.get(id)?.promise === promise) details.set(id, { at: Date.now(), data });
      return data;
    },
    (err) => {
      if (details.get(id)?.promise === promise) details.delete(id);
      throw err;
    },
  );
  details.set(id, { promise });
  return promise;
}

const PINS_QUERY = `query($groupId: String!, $browseParameter: BrowseParameter, $zoom: Int!) {
  pins(groupId: $groupId, browseParameter: $browseParameter, includeDislikes: false, zoom: $zoom) {
    totalListingCount
    pins { type latitude longitude count ids listPrice standardStatus hideWhenUnauth }
  }
}`;

const SUGGEST_QUERY = `query($browseParameter: String!, $groupId: String) {
  listingSuggestionsSearch(browseParameter: $browseParameter, groupId: $groupId) {
    id streetNumber streetDirPrefix streetName streetSuffix streetDirSuffix unitNumber
    city stateOrProvince postalCode listPrice bedroomsTotal bathroomsTotalInteger
  }
}`;

// OneHome wants both ends of every range, so open ends get a value nothing reaches.
const PRICE_CEILING = 100000000;
const BEDS_CEILING = 99;

function mapFilters(params) {
  const whole = (name) => {
    const value = Number(params.get(name));
    return params.get(name) && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  };
  // Without a listing type OneHome returns nothing at all.
  const filters = [{ fieldName: '', type: 'LISTING_TYPE', values: ['FOR_SALE'] }];
  // Otherwise results include land and commercial property.
  filters.push(params.get('type') === 'all'
    ? { fieldName: 'property.PropertyType', type: 'TERMS', values: ['Residential'] }
    : { fieldName: '', type: 'PROPERTY_TYPE', values: ['House'] });
  const min = whole('min');
  const max = whole('max');
  if (min !== null || max !== null) {
    filters.push({ fieldName: 'property.ListPrice', type: 'RANGE', values: [String(min ?? 0), String(max ?? PRICE_CEILING)] });
  }
  const beds = whole('beds');
  if (beds) filters.push({ fieldName: 'property.BedroomsTotal', type: 'RANGE', values: [String(beds), String(BEDS_CEILING)] });
  return filters;
}

async function mapPins(params) {
  const [south, west, north, east] = ['s', 'w', 'n', 'e'].map((key) => Number(params.get(key)));
  const zoom = Math.round(Number(params.get('zoom')));
  const valid = [south, west, north, east, zoom].every(Number.isFinite)
    && south < north && west < east && Math.abs(south) <= 90 && Math.abs(north) <= 90;
  if (!valid) throw new UpstreamError('The map area is not valid', 400);
  const polygon = [
    { latitude: north, longitude: east },
    { latitude: south, longitude: east },
    { latitude: south, longitude: west },
    { latitude: north, longitude: west },
  ];
  const data = await gql(PINS_QUERY, (s) => ({
    groupId: s.groupID,
    browseParameter: { searchQuery: mapFilters(params), polygon, pageInput: { pageNum: 0, size: 300 } },
    zoom: Math.min(Math.max(zoom, 1), 20),
  }));
  const pins = (data.pins?.pins || [])
    .filter((pin) => !pin.hideWhenUnauth && Number.isFinite(pin.latitude) && Number.isFinite(pin.longitude))
    .map((pin) => ({
      cluster: pin.type === 'Cluster',
      lat: pin.latitude,
      lng: pin.longitude,
      count: pin.count || 1,
      ids: pin.ids || [],
      price: pin.listPrice,
      status: pin.standardStatus,
    }));
  return { total: data.pins?.totalListingCount ?? 0, pins };
}

const placeCache = new Map();
let geocoderFreeAt = 0;

// The geocoder asks for at most one request a second from each app.
async function findPlaces(query) {
  const key = query.toLowerCase();
  if (placeCache.has(key)) return placeCache.get(key);
  const wait = Math.max(0, geocoderFreeAt - Date.now());
  geocoderFreeAt = Date.now() + wait + 1100;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const url = `${GEOCODER}?${new URLSearchParams({ format: 'jsonv2', limit: '5', countrycodes: 'us,ca', q: query })}`;
  const res = await fetch(url, { headers: { 'user-agent': GEOCODER_UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) { await res.body?.cancel(); throw new UpstreamError(`Place search returned HTTP ${res.status}`, 502); }
  const places = (await res.json()).map((place) => {
    const [south, north, west, east] = (place.boundingbox || []).map(Number);
    return { name: place.display_name, lat: Number(place.lat), lng: Number(place.lon), bounds: { south, west, north, east } };
  }).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng));
  if (placeCache.size > 200) placeCache.clear();
  placeCache.set(key, places);
  return places;
}

async function findHomes(query) {
  const data = await gql(SUGGEST_QUERY, (s) => ({ browseParameter: query, groupId: s.groupID }));
  return (data.listingSuggestionsSearch || []).slice(0, 6).map((hit) => {
    const street = [hit.streetNumber, hit.streetDirPrefix, hit.streetName, hit.streetSuffix, hit.streetDirSuffix].filter(Boolean).join(' ');
    return {
      id: hit.id,
      street: hit.unitNumber ? `${street} #${hit.unitNumber}` : street,
      cityLine: [[hit.city, hit.stateOrProvince].filter(Boolean).join(', '), hit.postalCode].filter(Boolean).join(' '),
      price: hit.listPrice,
      beds: hit.bedroomsTotal,
      baths: hit.bathroomsTotalInteger,
    };
  });
}

// Searches homes by address and places by name; one failing does not sink the other.
async function lookup(query) {
  const [homes, places] = await Promise.allSettled([findHomes(query), findPlaces(query)]);
  if (homes.status === 'rejected' && places.status === 'rejected') throw places.reason;
  return {
    homes: homes.status === 'fulfilled' ? homes.value : [],
    places: places.status === 'fulfilled' ? places.value : [],
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new UpstreamError('Request too large', 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function sendImage(res, id, index) {
  let upstream;
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = await getDetail(id);
    const photo = detail.photos[index];
    if (!photo) throw new UpstreamError('No such photo', 404);
    upstream = await fetch(photo.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (upstream.ok) break;
    // Most likely the signed URL aged out; drop the listing and ask again.
    await upstream.body?.cancel();
    details.delete(id);
  }
  if (!upstream.ok) throw new UpstreamError(`Photo server returned HTTP ${upstream.status}`, 502);
  const headers = {
    'content-type': upstream.headers.get('content-type') || 'image/jpeg',
    'cache-control': 'private, max-age=3600',
  };
  const length = upstream.headers.get('content-length');
  if (length) headers['content-length'] = length;
  res.writeHead(200, headers);
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendStatic(res, name) {
  const file = path.join(PUBLIC_DIR, path.basename(name));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (req.method === 'POST' && url.pathname === '/api/link') {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch {}
    const next = parseLink(payload.url);
    if (!next) return sendJson(res, 400, { error: 'That does not look like a OneHome link. Paste the whole address, including ?token=…' });
    setLink(next);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

  // The original OneHome link works here too with the host swapped for this server.
  if (url.searchParams.has('token')) {
    const next = parseLink(url.href);
    if (next && (next.token !== link.token || next.searchId !== link.searchId)) setLink(next);
    res.writeHead(302, { location: '/' });
    return res.end();
  }

  if (url.pathname === '/api/search') return sendJson(res, 200, await getSearch());
  if (url.pathname === '/api/link/status') return sendJson(res, 200, await linkStatus());
  if (url.pathname === '/api/map') return sendJson(res, 200, await mapPins(url.searchParams));
  if (url.pathname === '/api/lookup') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
    if (query.length < 2) return sendJson(res, 400, { error: 'Type at least two characters' });
    return sendJson(res, 200, await lookup(query));
  }
  if (parts[0] === 'api' && parts[1] === 'listing' && parts[2]) {
    const detail = await getDetail(parts[2]);
    // Photo addresses stay on the server; the page asks for /img/<id>/<n>.
    return sendJson(res, 200, { ...detail, photos: detail.photos.map(({ url: _url, ...rest }) => rest) });
  }
  if (parts[0] === 'img' && parts[1] && /^\d+$/.test(parts[2] || '')) return sendImage(res, parts[1], Number(parts[2]));

  if (url.pathname === '/') return sendStatic(res, 'index.html');
  return sendStatic(res, url.pathname);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err instanceof UpstreamError ? err.status
      : err?.name === 'TimeoutError' ? 504 : 500;
    const message = err?.name === 'TimeoutError' ? 'OneHome took too long to answer' : err.message || 'Something went wrong';
    if (status >= 500) console.error(`${req.method} ${req.url} -> ${message}`);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: message });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log('OneHome big-screen viewer is running.\n');
  console.log(`  On this Mac:    http://localhost:${PORT}`);
  for (const address of lan) console.log(`  On your phone:  ${address}   (same Wi-Fi)`);
  console.log('\nPress Ctrl+C to stop.');
});
