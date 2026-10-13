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
// Liked homes are kept here, on this machine only; nothing is sent to OneHome.
const LIKES_FILE = path.join(path.dirname(CONFIG_FILE), 'likes.json');
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
const searches = new Map(); // searchId -> { at, data } | { promise }
const schoolCache = new Map();
let likes = loadLikes(); // listingId -> summary
const details = new Map(); // listingId -> { at, data } | { promise }

function loadLink() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (saved.token) {
      const savedAt = saved.savedAt || fs.statSync(CONFIG_FILE).mtime.toISOString();
      const searchIds = Array.isArray(saved.searchIds) ? saved.searchIds.filter(Boolean) : [saved.searchId].filter(Boolean);
      return { token: saved.token, searchIds, savedAt };
    }
  } catch {}
  return { token: '', searchIds: [], savedAt: null };
}

function saveLink() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(link, null, 2) + '\n');
}

// Each emailed link opens one saved search. A link for the same person adds its
// search to the list; a link for someone else starts over.
function setLink(next) {
  if (next.token === link.token) {
    if (next.searchId && !link.searchIds.includes(next.searchId)) {
      link.searchIds.push(next.searchId);
      saveLink();
    }
    return;
  }
  link = { token: next.token, searchIds: [next.searchId].filter(Boolean), savedAt: new Date().toISOString() };
  linkCheck = { ok: null, at: 0, error: null };
  session = null;
  sessionPromise = null;
  searches.clear();
  schoolCache.clear();
  details.clear();
  saveLink();
}

function loadLikes() {
  try {
    const saved = JSON.parse(fs.readFileSync(LIKES_FILE, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
  } catch {}
  return {};
}

function saveLikes() {
  fs.writeFileSync(LIKES_FILE, JSON.stringify(likes, null, 2) + '\n');
}

function likedHomes() {
  return Object.values(likes).sort((a, b) => String(b.likedAt).localeCompare(String(a.likedAt)));
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

// Trades a link token for a session. `rejected` on the error means OneHome
// refused the token itself, as opposed to being unreachable.
async function checkToken(token) {
  const res = await fetch(`${API}/api/authentication/checkToken`, {
    method: 'POST',
    headers: upstreamHeaders(),
    body: JSON.stringify({ emailToken: token }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch {}
  if (res.status >= 500) throw new UpstreamError(`OneHome returned HTTP ${res.status}`, 502);
  if (!res.ok || !data?.sessionToken || !data?.groupID) {
    const err = new UpstreamError(res.ok ? 'OneHome did not return a session for this link' : `OneHome rejected the link (HTTP ${res.status})`, 401);
    err.rejected = true;
    throw err;
  }
  return data;
}

async function openSession() {
  if (!link.token) throw new UpstreamError('No OneHome link yet. Paste the link from your agent’s email.', 401);
  try {
    const data = await checkToken(link.token);
    linkCheck = { ok: true, at: Date.now(), error: null };
    return data;
  } catch (err) {
    if (err.rejected) linkCheck = { ok: false, at: Date.now(), error: err.message };
    throw err;
  }
}

// Takes in a pasted link. Emails to different addresses carry different tokens
// for the same OneHome account, so a link whose token opens the account already
// in use only adds its saved search; any other link replaces the current one.
async function acceptLink(next) {
  if (link.token && next.token !== link.token) {
    try {
      const [mine, theirs] = await Promise.all([getSession(), checkToken(next.token)]);
      if (mine.groupID === theirs.groupID) {
        next = { token: link.token, searchId: next.searchId || theirs.savedSearchID || '' };
      }
    } catch {}
  }
  // Check an extra search really opens before keeping it in the list.
  if (next.token === link.token && next.searchId && !link.searchIds.includes(next.searchId)) {
    try {
      await loadSearch(next.searchId);
    } catch (err) {
      throw new UpstreamError(`OneHome would not open that saved search (${err.message}).`, 400);
    }
  }
  setLink(next);
  return next.searchId || null;
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
        HighSchool CountyOrParish
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
    highSchool: p.HighSchool || null,
    county: [p.CountyOrParish].flat().filter(Boolean).join(', ') || null,
  };
}

async function searchIds() {
  if (link.searchIds.length) return link.searchIds;
  const fallback = (await getSession()).savedSearchID;
  return fallback ? [fallback] : [];
}

async function fetchSearch(searchId) {
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
  return { id: searchId, name: savedSearch.name, homes: listings.map(summarize) };
}

function loadSearch(searchId) {
  const entry = searches.get(searchId);
  if (entry?.data && Date.now() - entry.at < SEARCH_TTL_MS) return Promise.resolve(entry.data);
  if (entry?.promise) return entry.promise;
  const promise = fetchSearch(searchId).then(
    (data) => {
      if (searches.get(searchId)?.promise === promise) searches.set(searchId, { at: Date.now(), data });
      return data;
    },
    (err) => {
      if (searches.get(searchId)?.promise === promise) searches.delete(searchId);
      throw err;
    },
  );
  searches.set(searchId, { promise });
  return promise;
}

// The search asked for, or the first one, plus the names of all of them for the picker.
async function getSearch(wanted) {
  const ids = await searchIds();
  if (!ids.length) throw new UpstreamError('This link has no saved search (searchId) attached', 400);
  const id = ids.includes(wanted) ? wanted : ids[0];
  const [current, ...others] = await Promise.all([
    loadSearch(id),
    ...ids.filter((other) => other !== id).map((other) => loadSearch(other).catch(() => ({ id: other, name: 'Saved search' }))),
  ]);
  const names = new Map([current, ...others].map((search) => [search.id, search.name]));
  return { ...current, searches: ids.map((searchId) => ({ id: searchId, name: names.get(searchId) })) };
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
  // Houses only; otherwise results include land, condos and commercial property.
  filters.push({ fieldName: '', type: 'PROPERTY_TYPE', values: ['House'] });
  const min = whole('min');
  const max = whole('max');
  if (min !== null || max !== null) {
    filters.push({ fieldName: 'property.ListPrice', type: 'RANGE', values: [String(min ?? 0), String(max ?? PRICE_CEILING)] });
  }
  const beds = whole('beds');
  if (beds) filters.push({ fieldName: 'property.BedroomsTotal', type: 'RANGE', values: [String(beds), String(BEDS_CEILING)] });
  // School names must match OneHome's spelling and capitals exactly.
  const school = (params.get('school') || '').trim().slice(0, 80);
  if (school) filters.push({ fieldName: 'property.HighSchool', type: 'TERMS', values: [school] });
  return filters;
}

function mapPolygon(params) {
  const [south, west, north, east] = ['s', 'w', 'n', 'e'].map((key) => Number(params.get(key)));
  const valid = [south, west, north, east].every(Number.isFinite)
    && south < north && west < east && Math.abs(south) <= 90 && Math.abs(north) <= 90;
  if (!valid) throw new UpstreamError('The map area is not valid', 400);
  return [
    { latitude: north, longitude: east },
    { latitude: south, longitude: east },
    { latitude: south, longitude: west },
    { latitude: north, longitude: west },
  ];
}

const SCHOOLS_QUERY = `query($groupId: String!, $browseParameter: BrowseParameter) {
  listings(groupId: $groupId, browseParameter: $browseParameter, includeDislikes: false) {
    listings { property { HighSchool } }
  }
}`;

// High schools of the homes for sale in the area, most common first. It reads a
// sample of up to 200 homes, so a very wide view can miss a small school.
async function mapSchools(params) {
  const polygon = mapPolygon(params);
  const key = polygon.map((point) => `${point.latitude.toFixed(2)},${point.longitude.toFixed(2)}`).join('|');
  const cached = schoolCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.data;
  const data = await gql(SCHOOLS_QUERY, (s) => ({
    groupId: s.groupID,
    browseParameter: { searchQuery: mapFilters(new URLSearchParams()), polygon, pageInput: { pageNum: 0, size: 200 } },
  }));
  const counts = new Map();
  for (const listing of data.listings?.listings || []) {
    const name = listing.property?.HighSchool;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const schools = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  if (schoolCache.size > 100) schoolCache.clear();
  schoolCache.set(key, { at: Date.now(), data: { schools } });
  return { schools };
}

async function mapPins(params) {
  const polygon = mapPolygon(params);
  const zoom = Math.round(Number(params.get('zoom')));
  if (!Number.isFinite(zoom)) throw new UpstreamError('The map area is not valid', 400);
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
    return sendJson(res, 200, { ok: true, searchId: await acceptLink(next) });
  }
  if (parts[0] === 'api' && parts[1] === 'likes' && parts[2] && parts.length === 3) {
    const id = parts[2];
    if (req.method === 'PUT') {
      // The server looks the home up itself, so the page cannot store made-up details.
      const { property: _property, photos: _photos, ...summary } = await getDetail(id);
      likes[id] = { ...summary, likedAt: likes[id]?.likedAt || new Date().toISOString() };
      saveLikes();
      return sendJson(res, 200, { homes: likedHomes() });
    }
    if (req.method === 'DELETE') {
      if (likes[id]) { delete likes[id]; saveLikes(); }
      return sendJson(res, 200, { homes: likedHomes() });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

  // The original OneHome link works here too with the host swapped for this server.
  if (url.searchParams.has('token')) {
    const next = parseLink(url.href);
    if (next) await acceptLink(next);
    res.writeHead(302, { location: '/' });
    return res.end();
  }

  if (url.pathname === '/api/search') return sendJson(res, 200, await getSearch(url.searchParams.get('id')));
  if (url.pathname === '/api/likes') return sendJson(res, 200, { homes: likedHomes() });
  if (url.pathname === '/api/schools') return sendJson(res, 200, await mapSchools(url.searchParams));
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
