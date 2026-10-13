(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SLIDE_MS = 4000;
  // The server's photo addresses for a home go stale, so re-ask after a while.
  const DETAIL_TTL_MS = 15 * 60 * 1000;

  const els = {
    grid: $('grid-view'), cards: $('cards'), gridStatus: $('grid-status'),
    searchName: $('search-name'), searchCount: $('search-count'), sort: $('sort'),
    mapView: $('map-view'), mapResults: $('map-results'), mapCount: $('map-count'), mapCard: $('map-card'),
    mapQuery: $('map-q'), fPrice: $('f-price'), fBeds: $('f-beds'), fSchool: $('f-school'),
    searchPick: $('search-pick'), like: $('toggle-like'), mapBar: document.querySelector('.mapbar'),
    linkPill: $('change-link'), linkStatus: $('link-status'),
    viewer: $('viewer'), photo: $('photo'), backdrop: $('backdrop'), photoStatus: $('photo-status'),
    price: $('v-price'), stats: $('v-stats'), address: $('v-address'),
    homeCount: $('v-home-count'), photoCount: $('v-photo-count'),
    details: $('details'), detailsBody: $('details-body'),
    photos: $('photos'), photosBody: $('photos-body'),
    toast: $('toast'), play: $('toggle-play'), fullscreen: $('fullscreen'),
    dialog: $('link-dialog'), linkInput: $('link-input'), linkError: $('link-error'), linkMessage: $('link-message'),
  };

  const state = {
    homes: [],        // as the agent ordered them
    order: [],        // as currently sorted
    homeId: null,
    photoIndex: 0,
    detail: null,
    likes: new Map(), // id -> summary of each liked home
    view: 'saved',    // which list the grid shows: 'saved' or 'liked'
    searchName: 'Homes',
    nav: [],          // the homes Next/Prev home moves through
    cameFromList: false,
    gridScroll: 0,
    loadToken: 0,
    timer: null,
    toastTimer: null,
    wakeLock: null,
  };
  const detailCache = new Map();
  const historyCache = new Map(); // id -> promise of that home's sale history

  // ---------- helpers ----------

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child != null && child !== false) node.append(child);
    }
    return node;
  }

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const money = (value) => (typeof value === 'number' ? usd.format(value) : 'Price not listed');
  const isSet = (value) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length);
  // MLS feature lists arrive as squashed words like "WalkOutAccess".
  const words = (value) => String(value).replace(/([a-z])([A-Z])/g, '$1 $2');
  const text = (value) => (Array.isArray(value) ? value.map(words).join(', ') : typeof value === 'number' ? num.format(value) : /^\d+\.0+$/.test(value) ? String(Number(value)) : String(value));
  const imgUrl = (id, index) => `/img/${encodeURIComponent(id)}/${index}`;

  function statsLine(home) {
    const parts = [];
    if (isSet(home.beds)) parts.push(`${home.beds} bd`);
    if (isSet(home.baths)) parts.push(`${home.baths} ba`);
    if (isSet(home.sqft)) parts.push(`${text(home.sqft)} sqft`);
    return parts.join(' · ');
  }

  async function getJson(url, options) {
    const res = await fetch(url, options);
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(body?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function getDetail(id) {
    const cached = detailCache.get(id);
    if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.promise;
    const promise = getJson(`/api/listing/${encodeURIComponent(id)}`);
    const entry = { at: Date.now(), promise };
    detailCache.set(id, entry);
    promise.catch(() => { if (detailCache.get(id) === entry) detailCache.delete(id); });
    return promise;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1600);
  }

  // ---------- list of homes ----------

  function sortHomes() {
    const mode = els.sort.value;
    const by = (key, dir) => (a, b) => {
      const x = typeof a[key] === 'number' ? a[key] : null;
      const y = typeof b[key] === 'number' ? b[key] : null;
      if (x === null || y === null) return (x === null) - (y === null);
      return (x - y) * dir;
    };
    const homes = state.view === 'liked' ? [...state.likes.values()] : [...state.homes];
    if (mode === 'price-desc') homes.sort(by('price', -1));
    else if (mode === 'price-asc') homes.sort(by('price', 1));
    else if (mode === 'sqft-desc') homes.sort(by('sqft', -1));
    state.order = homes;
  }

  function heartButton(id) {
    const liked = state.likes.has(id);
    return h('button', {
      class: 'heart', type: 'button', 'data-like': id, 'aria-pressed': String(liked),
      'aria-label': liked ? 'Unlike this home' : 'Like this home',
      onclick: (event) => { event.stopPropagation(); toggleLike(id); },
    }, liked ? '♥' : '♡');
  }

  function schoolLine(home) {
    return [home.highSchool && `${home.highSchool} HS`, home.county && `${home.county} County`].filter(Boolean).join(' · ');
  }

  function renderCards() {
    els.cards.replaceChildren(...state.order.map((home) => {
      const img = h('img', { src: imgUrl(home.id, 0), alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => img.remove());
      const open = () => openFromGrid(home.id);
      return h('div', { class: 'card', role: 'button', tabindex: '0', onclick: open,
        onkeydown: (event) => { if (event.key === 'Enter' && event.target === event.currentTarget) open(); } },
        img,
        isSet(home.status) && h('span', { class: home.status === 'Active' ? 'badge' : 'badge other' }, home.status),
        heartButton(home.id),
        h('div', { class: 'card-body' },
          h('div', { class: 'card-top' },
            h('span', { class: 'card-price' }, money(home.price)),
            h('span', { class: 'card-stats' }, statsLine(home))),
          h('div', { class: 'card-address' }, [home.street, home.cityLine].filter(Boolean).join(', ')),
          schoolLine(home) && h('div', { class: 'card-school' }, schoolLine(home))));
    }));
  }

  // Shows whichever list the grid is on, with its title and count.
  function renderGrid() {
    const liked = state.view === 'liked';
    sortHomes();
    renderCards();
    els.searchName.textContent = liked ? 'Liked homes' : state.searchName;
    els.searchCount.textContent = `${state.order.length} ${state.order.length === 1 ? 'home' : 'homes'}`;
    els.searchPick.hidden = liked || els.searchPick.options.length < 2;
    for (const a of document.querySelectorAll('#grid-switch a')) {
      if (a.getAttribute('href') === (liked ? '#/liked' : '#/')) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (els.gridStatus.classList.contains('error') && !liked) return;
    els.gridStatus.className = 'status';
    els.gridStatus.hidden = state.order.length > 0;
    els.gridStatus.textContent = liked ? 'No liked homes yet. Tap ♡ on any home to keep it here.' : 'This search has no homes right now.';
  }

  // ---------- likes ----------

  function setLikes(homes) {
    state.likes = new Map(homes.map((home) => [home.id, home]));
  }

  async function loadLikes() {
    try { setLikes((await getJson('/api/likes')).homes); } catch {}
    paintLikes();
  }

  // Brings every heart on screen in line with the list of liked homes.
  function paintLikes() {
    for (const button of document.querySelectorAll('[data-like]')) {
      const liked = state.likes.has(button.dataset.like);
      button.setAttribute('aria-pressed', String(liked));
      button.setAttribute('aria-label', liked ? 'Unlike this home' : 'Like this home');
      button.textContent = liked ? '♥' : '♡';
    }
    const liked = state.likes.has(state.homeId);
    els.like.setAttribute('aria-pressed', String(liked));
    els.like.textContent = liked ? '♥ Liked' : '♡ Like';
    if (state.view === 'liked' && !els.grid.hidden) renderGrid();
    if (mapState.map && !els.mapView.hidden) drawPins();
  }

  async function toggleLike(id) {
    if (!id) return;
    const liked = state.likes.has(id);
    try {
      setLikes((await getJson(`/api/likes/${encodeURIComponent(id)}`, { method: liked ? 'DELETE' : 'PUT' })).homes);
    } catch (err) {
      if (!els.viewer.hidden) toast(`Could not save: ${err.message}`);
      return;
    }
    paintLikes();
    if (!els.viewer.hidden) toast(liked ? 'Removed from liked' : '♥ Liked');
  }

  const SEARCH_STORE = 'onehome-search';

  async function loadSearch(wanted) {
    let id = wanted;
    if (!id) { try { id = localStorage.getItem(SEARCH_STORE); } catch {} }
    els.gridStatus.className = 'status';
    els.gridStatus.textContent = 'Loading homes…';
    els.gridStatus.hidden = false;
    els.cards.replaceChildren();
    try {
      const search = await getJson(`/api/search${id ? `?id=${encodeURIComponent(id)}` : ''}`);
      state.homes = search.homes || [];
      state.searchName = search.name || 'Homes';
      document.title = state.searchName;
      try { localStorage.setItem(SEARCH_STORE, search.id); } catch {}
      els.searchPick.replaceChildren(...(search.searches || []).map((item) => h('option', { value: item.id }, item.name || 'Saved search')));
      els.searchPick.value = search.id;
      renderGrid();
      return true;
    } catch (err) {
      els.gridStatus.className = 'status error';
      els.gridStatus.textContent = `Could not load homes: ${err.message}`;
      if (err.status === 400 || err.status === 401 || err.status === 404) {
        showLinkDialog('That link is not working any more. Paste a fresh link from your agent’s email.');
      }
      return false;
    }
  }

  // ---------- viewer ----------

  const homeIndex = () => state.nav.findIndex((home) => home.id === state.homeId);

  function writeHash() {
    const hash = `#/home/${encodeURIComponent(state.homeId)}/${state.photoIndex + 1}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function openFromGrid(id) {
    state.gridScroll = window.scrollY;
    state.cameFromList = true;
    state.nav = state.order;
    $('back').textContent = state.view === 'liked' ? '‹ Liked' : '‹ All homes';
    location.hash = `#/home/${encodeURIComponent(id)}/1`;
  }

  function showViewer() {
    if (!els.viewer.hidden) return;
    els.grid.hidden = true;
    els.mapView.hidden = true;
    els.viewer.hidden = false;
    els.viewer.classList.remove('clean');
    requestWakeLock();
  }

  function leaveViewer() {
    stopSlideshow();
    closeSheets();
    releaseWakeLock();
    state.homeId = null;
    state.detail = null;
    els.viewer.hidden = true;
  }

  function showGrid(view) {
    leaveViewer();
    els.mapView.hidden = true;
    els.grid.hidden = false;
    const changed = view !== state.view;
    state.view = view;
    renderGrid();
    window.scrollTo(0, changed ? 0 : state.gridScroll);
  }

  function renderHeadline(home) {
    els.price.textContent = money(home.price);
    els.stats.textContent = statsLine(home);
    els.address.textContent = [home.street, home.cityLine].filter(Boolean).join(', ');
    const index = homeIndex();
    paintLikes();
    els.homeCount.textContent = index >= 0 ? `Home ${index + 1} of ${state.nav.length}` : '';
  }

  // `photo` is a zero-based index, or 'last'.
  async function openHome(id, photo) {
    showViewer();
    closeSheets();
    const token = ++state.loadToken;
    state.homeId = id;
    state.detail = null;
    state.photoIndex = 0;

    // A home opened from a bookmark or reload has no list behind it yet.
    if (!state.nav.some((home) => home.id === id)) state.nav = state.order;
    const summary = state.nav.find((home) => home.id === id);
    if (summary) renderHeadline(summary);
    els.photoCount.textContent = '';
    state.history = null;
    $('v-flip').hidden = true;
    loadHistory(id);
    els.photo.classList.add('loading');
    els.photoStatus.textContent = 'Loading photos…';
    els.photoStatus.hidden = false;

    let detail;
    try {
      detail = await getDetail(id);
    } catch (err) {
      if (token !== state.loadToken) return;
      els.photo.removeAttribute('src');
      els.backdrop.style.backgroundImage = '';
      els.photoStatus.textContent = `Could not load this home: ${err.message}`;
      return;
    }
    if (token !== state.loadToken) return;

    state.detail = detail;
    renderHeadline(detail);
    const count = detail.photos.length;
    if (!count) {
      els.photo.removeAttribute('src');
      els.backdrop.style.backgroundImage = '';
      els.photoStatus.textContent = 'This home has no photos.';
      writeHash();
      return;
    }
    const wanted = photo === 'last' ? count - 1 : Number(photo) || 0;
    showPhoto(Math.min(Math.max(wanted, 0), count - 1));

    // Warm up the neighbours so moving between homes is quick.
    const index = homeIndex();
    for (const neighbour of index >= 0 ? [state.nav[index + 1], state.nav[index - 1]] : []) {
      if (neighbour) getDetail(neighbour.id).catch(() => {});
    }
  }

  // Sale history arrives after the photos; it fills in the FLIP badge and the
  // history section if Details is already open.
  function loadHistory(id) {
    if (!historyCache.has(id)) {
      const promise = getJson(`/api/history/${encodeURIComponent(id)}`);
      historyCache.set(id, promise);
      promise.catch(() => historyCache.delete(id));
    }
    historyCache.get(id).then(
      (history) => {
        if (state.homeId !== id) return;
        state.history = history;
        $('v-flip').hidden = !history.flip;
        if (!els.details.hidden) renderDetails();
      },
      () => {
        if (state.homeId !== id) return;
        state.history = { failed: true, records: [] };
        if (!els.details.hidden) renderDetails();
      },
    );
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Record dates come as YYYY, YYYY-MM or YYYY-MM-DD.
  function recordDate(text) {
    const [year, month, day] = text.split('-');
    if (!month) return year;
    return `${MONTHS[Number(month) - 1]} ${day ? `${Number(day)}, ` : ''}${year}`;
  }

  function historySection() {
    const history = state.history;
    if (!history) return h('p', { class: 'history-note' }, 'Loading sale records…');
    if (history.failed) return h('p', { class: 'history-note' }, 'Sale records could not be loaded.');
    if (!history.records.length) return h('p', { class: 'history-note' }, 'No public sale records were found for this home.');
    return [
      h('table', { class: 'history' }, history.records.map((record) => h('tr', null,
        h('td', null, recordDate(record.date)),
        h('td', null, record.price ? money(record.price) : '—'),
        h('td', null, record.marketSale ? 'Sold' : `Transfer, not a market sale${record.deed ? ` (${record.deed})` : ''}`)))),
      h('p', { class: 'history-note' }, 'From county records. Transfers between family, trusts or lenders usually show no price.'),
    ];
  }

  function showPhoto(index) {
    const { detail } = state;
    if (!detail || !detail.photos[index]) return;
    state.photoIndex = index;
    const token = ++state.loadToken;
    const url = imgUrl(detail.id, index);
    const photo = detail.photos[index];

    els.photoStatus.hidden = true;
    els.photo.classList.add('loading');
    els.photo.onload = () => {
      if (token !== state.loadToken) return;
      els.photo.classList.remove('loading');
      els.backdrop.style.backgroundImage = `url("${url}")`;
    };
    els.photo.onerror = () => {
      if (token !== state.loadToken) return;
      els.photoStatus.textContent = 'This photo did not load. Tap the right side to move on.';
      els.photoStatus.hidden = false;
    };
    els.photo.src = url;
    els.photo.alt = photo.caption || `Photo ${index + 1}`;

    const label = photo.kind === 'floorplan' ? 'Floor plan · ' : '';
    els.photoCount.textContent = `${label}${index + 1} / ${detail.photos.length}`;
    writeHash();

    for (const ahead of [index + 1, index + 2]) {
      if (detail.photos[ahead]) new Image().src = imgUrl(detail.id, ahead);
    }
    if (!els.photos.hidden) markCurrentThumb();
  }

  function stepHome(direction, photo = 0) {
    const index = homeIndex();
    const next = index >= 0 ? state.nav[index + direction] : null;
    if (!next) {
      toast(direction > 0 ? 'That was the last home' : 'This is the first home');
      stopSlideshow();
      return false;
    }
    openHome(next.id, photo);
    toast(next.street || (direction > 0 ? 'Next home' : 'Previous home'));
    return true;
  }

  function stepPhoto(direction) {
    const { detail } = state;
    if (!detail) return;
    const next = state.photoIndex + direction;
    if (next >= 0 && next < detail.photos.length) showPhoto(next);
    else stepHome(direction, direction > 0 ? 0 : 'last');
  }

  // ---------- sheets ----------

  function closeSheets() {
    els.details.hidden = true;
    els.photos.hidden = true;
    $('toggle-details').setAttribute('aria-pressed', 'false');
    $('toggle-photos').setAttribute('aria-pressed', 'false');
  }

  function factList(rows) {
    const shown = rows.filter(([, value]) => isSet(value));
    if (!shown.length) return null;
    return h('dl', { class: 'facts' }, shown.map(([label, value]) => [h('dt', null, label), h('dd', null, text(value))]));
  }

  function section(title, content) {
    return content ? [h('h3', null, title), content] : [];
  }

  function renderDetails() {
    const d = state.detail;
    if (!d) return;
    const p = d.property || {};
    const baths = isSet(p.BathroomsFull)
      ? `${p.BathroomsFull} full${p.BathroomsHalf ? `, ${p.BathroomsHalf} half` : ''}`
      : d.baths;
    const hoa = isSet(p.AssociationFee) ? `${money(p.AssociationFee)}${p.AssociationFeeFrequency ? ` ${String(p.AssociationFeeFrequency).toLowerCase()}` : ''}` : null;
    const taxes = isSet(p.TaxAnnualAmount) ? `${money(p.TaxAnnualAmount)}${p.TaxYear ? ` (${p.TaxYear})` : ''}` : null;
    const flip = state.history?.flip;
    const place = [d.street, d.cityLine].filter(Boolean).join(', ') || `${d.lat},${d.lng}`;
    const lot = isSet(d.lot) ? `${text(d.lot)} ${d.lotUnits || ''}`.trim() : null;

    els.detailsBody.replaceChildren(
      h('h2', null, money(d.price), flip && h('span', { class: 'flip-badge' }, 'FLIP')),
      ...(flip ? [h('p', { class: 'flip-note' },
        `Bought ${recordDate(flip.purchaseDate)} for ${money(flip.purchasePrice)}, listed ${flip.increasePercent}% higher ${flip.monthsHeld < 1 ? 'the same month' : `${flip.monthsHeld} ${flip.monthsHeld === 1 ? 'month' : 'months'} later`}.`)] : []),
      h('p', { class: 'where' }, [d.street, d.cityLine].filter(Boolean).join(', ')),
      h('p', { class: 'link-row' },
        h('a', { class: 'pill', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}` }, 'Google Maps ↗'),
        typeof d.lat === 'number' && typeof d.lng === 'number'
          && h('a', { class: 'pill', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${d.lat},${d.lng}` }, 'Street View ↗')),
      ...section('Schools', factList([
        ['High', p.HighSchool],
        ['Middle', p.MiddleOrJuniorSchool],
        ['Elementary', p.ElementarySchool],
        ['County', d.county],
      ])),
      h('h3', null, 'Purchase history'),
      ...[historySection()].flat(),
      ...section('The basics', factList([
        ['Status', d.status],
        ['Bedrooms', d.beds],
        ['Bathrooms', baths],
        ['Square feet', d.sqft],
        ['Finished below grade', p.BelowGradeFinishedArea],
        ['Lot', lot],
        ['Year built', isSet(p.YearBuilt) ? String(p.YearBuilt) : null],
        ['Stories', p.StoriesTotal || p.Levels],
        ['Style', p.ArchitecturalStyle],
        ['Garage spaces', p.GarageSpaces],
        ['Basement', p.Basement],
        ['Days on market', p.DaysOnMarket],
        ['Was', isSet(d.previousPrice) && d.previousPrice !== d.price ? money(d.previousPrice) : null],
      ])),
      ...section('About this home', isSet(p.PublicRemarks) ? h('p', { class: 'remarks' }, p.PublicRemarks) : null),
      ...section('Costs', factList([['HOA', hoa], ['Taxes', taxes]])),
      ...section('Inside and out', factList([
        ['Heating', p.Heating],
        ['Cooling', p.Cooling],
        ['Flooring', p.Flooring],
        ['Appliances', p.Appliances],
        ['Interior', p.InteriorFeatures],
        ['Fireplaces', p.FireplacesTotal],
        ['Exterior', p.ExteriorFeatures],
        ['Porch and patio', p.PatioAndPorchFeatures],
        ['Pool', p.PoolFeatures],
        ['Parking', p.ParkingFeatures],
        ['Lot features', p.LotFeatures],
      ])),
      ...section('Neighborhood', factList([
        ['Subdivision', p.SubdivisionName],
        ['Community', p.CommunityFeatures],
      ])),
      ...section('Listing', factList([
        ['MLS #', p.ListingId],
        ['Listed by', [p.ListAgentFullName, p.ListOfficeName].filter(Boolean).join(', ')],
      ])),
    );
  }

  function markCurrentThumb() {
    els.photosBody.querySelectorAll('.thumb').forEach((thumb, index) => {
      thumb.classList.toggle('current', index === state.photoIndex);
    });
  }

  function renderPhotoSheet() {
    const d = state.detail;
    if (!d) return;
    els.photosBody.replaceChildren(...d.photos.map((photo, index) =>
      h('button', { class: 'thumb', type: 'button', onclick: () => { closeSheets(); showPhoto(index); } },
        h('img', { src: imgUrl(d.id, index), alt: photo.caption || `Photo ${index + 1}`, loading: 'lazy', decoding: 'async' }),
        h('span', null, photo.kind === 'floorplan' ? `Floor plan ${index + 1}` : String(index + 1)))));
    markCurrentThumb();
    els.photosBody.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }

  function toggleSheet(name) {
    const sheet = name === 'details' ? els.details : els.photos;
    const wasOpen = !sheet.hidden;
    closeSheets();
    if (wasOpen || !state.detail) return;
    stopSlideshow();
    sheet.hidden = false;
    $(`toggle-${name}`).setAttribute('aria-pressed', 'true');
    if (name === 'details') { renderDetails(); els.details.scrollTop = 0; } else renderPhotoSheet();
  }

  // ---------- slideshow, full screen, wake lock ----------

  function stopSlideshow() {
    clearInterval(state.timer);
    state.timer = null;
    els.play.textContent = '▶ Play';
    els.play.setAttribute('aria-pressed', 'false');
  }

  function toggleSlideshow() {
    if (state.timer) { stopSlideshow(); return; }
    closeSheets();
    state.timer = setInterval(() => stepPhoto(1), SLIDE_MS);
    els.play.textContent = '❚❚ Pause';
    els.play.setAttribute('aria-pressed', 'true');
  }

  function restartSlideshowTimer() {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = setInterval(() => stepPhoto(1), SLIDE_MS);
  }

  async function requestWakeLock() {
    try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
  function releaseWakeLock() {
    state.wakeLock?.release().catch(() => {});
    state.wakeLock = null;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  // ---------- link dialog ----------

  function showLinkDialog(message) {
    if (message) els.linkMessage.textContent = message;
    els.linkError.hidden = true;
    els.linkInput.value = '';
    if (!els.dialog.open) els.dialog.showModal();
  }

  async function submitLink(event) {
    event.preventDefault();
    els.linkError.hidden = true;
    let added;
    try {
      added = await getJson('/api/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: els.linkInput.value }),
      });
    } catch (err) {
      els.linkError.textContent = err.message;
      els.linkError.hidden = false;
      return;
    }
    els.dialog.close();
    detailCache.clear();
    historyCache.clear();
    resetMap();
    refreshLinkStatus();
    history.replaceState(null, '', '#/');
    showGrid('saved');
    loadSearch(added.searchId);
  }

  // ---------- link status ----------

  let linkInfo = null;

  function ago(iso) {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (minutes < 2) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }

  function timeLeft(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${Math.max(minutes, 1)} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} hr ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} days`;
  }

  function renderLinkStatus() {
    const info = linkInfo;
    let stateName = 'unknown';
    let label = 'Checking link…';
    if (info && !info.hasLink) {
      stateName = 'warn';
      label = 'No link yet · paste one';
    } else if (info && info.ok === false) {
      stateName = 'warn';
      label = 'Stopped working · paste a new one';
    } else if (info && info.expiresAt) {
      const left = new Date(info.expiresAt).getTime() - Date.now();
      stateName = left < 60 * 60000 ? 'warn' : 'ok';
      label = left <= 0 ? 'Expired · paste a new one' : `Expires in ${timeLeft(left)}`;
    } else if (info && info.ok) {
      stateName = 'ok';
      label = info.savedAt ? `Working · added ${ago(info.savedAt)}` : 'Working';
    } else if (info) {
      label = 'Not checked yet';
    }
    els.linkPill.dataset.state = stateName;
    els.linkStatus.textContent = label;
    els.linkPill.title = info?.checkedAt ? `Last checked with OneHome ${ago(info.checkedAt)}` : '';
  }

  async function refreshLinkStatus() {
    try { linkInfo = await getJson('/api/link/status'); } catch {}
    renderLinkStatus();
  }

  // ---------- map ----------

  const MAP_STORE = 'onehome-map';
  const mapState = { map: null, layer: null, pins: [], selectedId: null, token: 0, schoolToken: 0, timer: null };

  function readStore() {
    try { return JSON.parse(localStorage.getItem(MAP_STORE)) || {}; } catch { return {}; }
  }
  function writeStore() {
    const { map } = mapState;
    if (!map) return;
    const center = map.getCenter();
    const saved = { lat: center.lat, lng: center.lng, zoom: map.getZoom(), price: els.fPrice.value, beds: els.fBeds.value, school: els.fSchool.value };
    try { localStorage.setItem(MAP_STORE, JSON.stringify(saved)); } catch {}
  }

  function priceTag(value) {
    if (typeof value !== 'number') return '—';
    if (value >= 1e6) return `$${(value / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
    return `$${Math.round(value / 1000)}k`;
  }

  function initMap() {
    if (mapState.map) return;
    const stored = readStore();
    for (const [select, value] of [[els.fPrice, stored.price], [els.fBeds, stored.beds]]) {
      if (value && [...select.options].some((option) => option.value === value)) select.value = value;
    }
    setSchoolOptions(stored.school ? [stored.school] : []);
    els.fSchool.value = stored.school || '';
    const map = L.map('map', { zoomControl: false, worldCopyJump: true, minZoom: 4, maxZoom: 19 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    mapState.map = map;
    mapState.layer = L.layerGroup().addTo(map);

    const savedSpots = state.homes.filter((home) => typeof home.lat === 'number' && typeof home.lng === 'number');
    if (typeof stored.lat === 'number' && typeof stored.lng === 'number') map.setView([stored.lat, stored.lng], stored.zoom || 12);
    else if (savedSpots.length) map.fitBounds(savedSpots.map((home) => [home.lat, home.lng]), { padding: [40, 40], maxZoom: 14 });
    else map.setView([39.5, -98.35], 4);

    map.on('moveend', () => { writeStore(); scheduleMapLoad(); });
    map.on('click', () => { els.mapResults.hidden = true; closeMapCard(); });
    scheduleMapLoad();
  }

  function showMap() {
    leaveViewer();
    els.grid.hidden = true;
    els.mapView.hidden = false;
    initMap();
    // Leaflet measures its box once; it was hidden while the viewer was open.
    mapState.map.invalidateSize();
  }

  function resetMap() {
    mapState.pins = [];
    mapState.selectedId = null;
    mapState.layer?.clearLayers();
    els.mapCard.hidden = true;
    els.mapCount.textContent = '';
    if (mapState.map) scheduleMapLoad();
  }

  function scheduleMapLoad() {
    clearTimeout(mapState.timer);
    mapState.timer = setTimeout(loadPins, 300);
  }

  async function loadPins() {
    const { map } = mapState;
    if (!map || els.mapView.hidden) return;
    const bounds = map.getBounds();
    const [min, max] = els.fPrice.value.split('-');
    const params = new URLSearchParams({
      s: bounds.getSouth(), w: bounds.getWest(), n: bounds.getNorth(), e: bounds.getEast(),
      // One level deeper than the screen, so more homes show as prices rather than bubbles.
      zoom: map.getZoom() + 1,
    });
    if (els.fSchool.value) params.set('school', els.fSchool.value);
    loadSchools(bounds);
    if (min) params.set('min', min);
    if (max) params.set('max', max);
    if (els.fBeds.value) params.set('beds', els.fBeds.value);

    const token = ++mapState.token;
    els.mapCount.textContent = 'Looking for homes…';
    let data;
    try {
      data = await getJson(`/api/map?${params}`);
    } catch (err) {
      if (token === mapState.token) els.mapCount.textContent = `Could not load homes: ${err.message}`;
      return;
    }
    if (token !== mapState.token) return;
    mapState.pins = data.pins;
    drawPins();
    const grouped = data.pins.some((pin) => pin.cluster);
    els.mapCount.textContent = !data.total ? 'No homes here with these filters'
      : `${num.format(data.total)} ${data.total === 1 ? 'home' : 'homes'}${grouped ? ' · zoom in to see each one' : ''}`;
  }

  // Keeps the chosen school in the list even when no home in view belongs to it.
  function setSchoolOptions(names) {
    const chosen = els.fSchool.value;
    const all = [...new Set([...(chosen ? [chosen] : []), ...names])].sort((a, b) => a.localeCompare(b));
    els.fSchool.replaceChildren(h('option', { value: '' }, 'Any school'), ...all.map((name) => h('option', { value: name }, `${name} HS`)));
    els.fSchool.value = chosen;
  }

  async function loadSchools(bounds) {
    const params = new URLSearchParams({ s: bounds.getSouth(), w: bounds.getWest(), n: bounds.getNorth(), e: bounds.getEast() });
    const token = ++mapState.schoolToken;
    try {
      const { schools } = await getJson(`/api/schools?${params}`);
      // Leave the list alone while someone has it open.
      if (token === mapState.schoolToken && document.activeElement !== els.fSchool) setSchoolOptions(schools);
    } catch {}
  }

  function drawPins() {
    const { map, layer } = mapState;
    const savedIds = new Set(state.homes.map((home) => home.id));
    layer.clearLayers();
    for (const pin of mapState.pins) {
      let classes = 'pin';
      let label;
      if (pin.cluster) {
        classes += ' pin-cluster';
        label = num.format(pin.count);
      } else {
        if (pin.ids.some((id) => savedIds.has(id))) classes += ' pin-saved';
        const liked = pin.ids.some((id) => state.likes.has(id));
        if (liked) classes += ' pin-liked';
        if (pin.ids.includes(mapState.selectedId)) classes += ' pin-selected';
        label = `${liked ? '♥ ' : ''}${priceTag(pin.price)}${pin.ids.length > 1 ? ` ×${pin.ids.length}` : ''}`;
      }
      const icon = L.divIcon({ className: classes, html: h('span', null, label), iconSize: null });
      const marker = L.marker([pin.lat, pin.lng], { icon, keyboard: false, zIndexOffset: pin.cluster ? 0 : 500 });
      marker.on('click', () => {
        if (pin.cluster) { map.setView([pin.lat, pin.lng], Math.min(map.getZoom() + 2, 18)); return; }
        // Several homes can share one spot; tapping again steps through them.
        const at = pin.ids.indexOf(mapState.selectedId);
        selectOnMap(pin.ids[(at + 1) % pin.ids.length], pin.price);
      });
      layer.addLayer(marker);
    }
  }

  function closeMapCard() {
    if (els.mapCard.hidden) return;
    els.mapCard.hidden = true;
    mapState.selectedId = null;
    drawPins();
  }

  async function selectOnMap(id, price) {
    mapState.selectedId = id;
    drawPins();
    const fill = (home, loaded) => {
      const picture = loaded && home.photos?.length
        ? h('img', { src: imgUrl(id, 0), alt: '' })
        : h('div', { class: 'no-photo' });
      els.mapCard.replaceChildren(
        h('button', { class: 'map-card-open', type: 'button', onclick: () => openFromMap(id) },
          picture,
          h('div', { class: 'map-card-text' },
            h('div', { class: 'map-card-price' }, money(home.price)),
            h('div', { class: 'map-card-stats' }, loaded ? statsLine(home) : 'Loading…'),
            h('div', { class: 'map-card-address' }, loaded ? [home.street, home.cityLine].filter(Boolean).join(', ') : ''),
            loaded && schoolLine(home) && h('div', { class: 'map-card-school' }, schoolLine(home)),
            h('div', { class: 'map-card-cta' }, 'View photos ›'))),
        heartButton(id),
        h('button', { class: 'map-card-close', type: 'button', 'aria-label': 'Close', onclick: closeMapCard }, '✕'));
      els.mapCard.hidden = false;
    };
    fill({ price }, false);
    try {
      const detail = await getDetail(id);
      if (mapState.selectedId === id) fill(detail, true);
      return detail;
    } catch (err) {
      if (mapState.selectedId === id) els.mapCard.querySelector('.map-card-stats').textContent = `Could not load: ${err.message}`;
      return null;
    }
  }

  function openFromMap(id) {
    const homes = mapState.pins.filter((pin) => !pin.cluster)
      .flatMap((pin) => pin.ids.map((pinId) => ({ id: pinId, price: pin.price })))
      .sort((a, b) => (b.price || 0) - (a.price || 0));
    if (!homes.some((home) => home.id === id)) homes.unshift({ id });
    state.nav = homes;
    state.cameFromList = true;
    $('back').textContent = '‹ Map';
    location.hash = `#/home/${encodeURIComponent(id)}/1`;
  }

  async function searchMap(event) {
    event.preventDefault();
    const query = els.mapQuery.value.trim();
    if (query.length < 2) return;
    els.mapQuery.blur();
    els.mapResults.replaceChildren(h('p', null, 'Searching…'));
    els.mapResults.hidden = false;
    let found;
    try {
      found = await getJson(`/api/lookup?q=${encodeURIComponent(query)}`);
    } catch (err) {
      els.mapResults.replaceChildren(h('p', null, `Search did not work: ${err.message}`));
      return;
    }
    const { map } = mapState;
    const places = found.places.map((place) => h('button', { class: 'result', type: 'button', onclick: () => {
      els.mapResults.hidden = true;
      const b = place.bounds;
      if ([b.south, b.west, b.north, b.east].every(Number.isFinite)) map.fitBounds([[b.south, b.west], [b.north, b.east]], { maxZoom: 16 });
      else map.setView([place.lat, place.lng], 13);
    } }, h('b', null, place.name.split(',')[0]), h('span', null, place.name.split(',').slice(1).join(',').trim())));
    const homes = found.homes.map((home) => h('button', { class: 'result', type: 'button', onclick: async () => {
      els.mapResults.hidden = true;
      const detail = await selectOnMap(home.id, home.price);
      if (detail && typeof detail.lat === 'number' && typeof detail.lng === 'number') map.setView([detail.lat, detail.lng], 16);
    } }, h('b', null, home.street || 'Home'), h('span', null, [money(home.price), home.cityLine].filter(Boolean).join(' · '))));
    els.mapResults.replaceChildren(
      ...(places.length ? [h('h3', null, 'Places'), ...places] : []),
      ...(homes.length ? [h('h3', null, 'Homes for sale'), ...homes] : []),
      !places.length && !homes.length && h('p', null, `Nothing found for “${query}”.`),
    );
  }

  // ---------- routing and input ----------

  function route() {
    const match = location.hash.match(/^#\/home\/([^/]+)(?:\/(\d+))?/);
    if (!match) {
      if (location.hash.startsWith('#/map')) showMap();
      else showGrid(location.hash.startsWith('#/liked') ? 'liked' : 'saved');
      return;
    }
    const id = decodeURIComponent(match[1]);
    const index = Math.max((Number(match[2]) || 1) - 1, 0);
    if (id === state.homeId && state.detail) {
      if (index !== state.photoIndex) showPhoto(Math.min(index, state.detail.photos.length - 1));
      return;
    }
    openHome(id, index);
  }

  function goBack() {
    if (state.cameFromList) { state.cameFromList = false; history.back(); return; }
    history.replaceState(null, '', '#/');
    showGrid('saved');
  }

  function manual(action) {
    return () => { action(); restartSlideshowTimer(); };
  }

  $('zone-prev').addEventListener('click', manual(() => stepPhoto(-1)));
  $('zone-next').addEventListener('click', manual(() => stepPhoto(1)));
  $('zone-mid').addEventListener('click', () => els.viewer.classList.toggle('clean'));
  $('prev-home').addEventListener('click', manual(() => stepHome(-1)));
  $('next-home').addEventListener('click', manual(() => stepHome(1)));
  $('back').addEventListener('click', goBack);
  $('toggle-details').addEventListener('click', () => toggleSheet('details'));
  $('toggle-photos').addEventListener('click', () => toggleSheet('photos'));
  els.play.addEventListener('click', toggleSlideshow);
  els.viewer.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeSheets));

  if (document.documentElement.requestFullscreen) {
    els.fullscreen.hidden = false;
    els.fullscreen.addEventListener('click', toggleFullscreen);
  }

  // Swipe sideways for photos, up or down for homes.
  let swipe = null;
  let swallowClick = false;
  els.viewer.addEventListener('touchstart', (event) => {
    swipe = event.touches.length === 1 && !event.target.closest('.sheet, .hud')
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
      : null;
  }, { passive: true });
  els.viewer.addEventListener('touchend', (event) => {
    if (!swipe) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - swipe.x;
    const dy = touch.clientY - swipe.y;
    swipe = null;
    const far = Math.max(Math.abs(dx), Math.abs(dy));
    if (far < 45) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 400);
    if (Math.abs(dx) > Math.abs(dy)) stepPhoto(dx < 0 ? 1 : -1);
    else stepHome(dy < 0 ? 1 : -1);
    restartSlideshowTimer();
  }, { passive: true });
  els.viewer.addEventListener('click', (event) => {
    if (swallowClick) { event.stopPropagation(); event.preventDefault(); swallowClick = false; }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (els.viewer.hidden || els.dialog.open || event.metaKey || event.ctrlKey || event.altKey) return;
    const sheetOpen = !els.details.hidden || !els.photos.hidden;
    const actions = {
      ArrowRight: () => !sheetOpen && stepPhoto(1),
      ArrowLeft: () => !sheetOpen && stepPhoto(-1),
      ArrowDown: () => !sheetOpen && stepHome(1),
      ArrowUp: () => !sheetOpen && stepHome(-1),
      Escape: () => (sheetOpen ? closeSheets() : goBack()),
      ' ': toggleSlideshow,
      i: () => toggleSheet('details'),
      l: () => toggleLike(state.homeId),
      g: () => toggleSheet('photos'),
      f: () => document.documentElement.requestFullscreen && toggleFullscreen(),
      h: () => els.viewer.classList.toggle('clean'),
    };
    const action = actions[event.key];
    if (!action) return;
    if (sheetOpen && event.key.startsWith('Arrow')) return; // let the sheet scroll
    event.preventDefault();
    action();
    restartSlideshowTimer();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!els.viewer.hidden) requestWakeLock();
    refreshLinkStatus();
  });

  els.sort.addEventListener('change', renderGrid);
  $('change-link').addEventListener('click', () => showLinkDialog('Paste a link from your agent’s email (the whole address, including ?token=…). A link to another of your saved searches is added alongside this one.'));
  $('link-cancel').addEventListener('click', () => els.dialog.close());
  $('link-form').addEventListener('submit', submitLink);
  $('map-search').addEventListener('submit', searchMap);
  // The enlarged search bar stays up briefly after focus leaves, so a tap on Go still lands.
  let searchingTimer = null;
  els.mapQuery.addEventListener('focus', () => { clearTimeout(searchingTimer); els.mapBar.classList.add('searching'); });
  els.mapQuery.addEventListener('blur', () => { searchingTimer = setTimeout(() => els.mapBar.classList.remove('searching'), 250); });
  els.like.addEventListener('click', () => toggleLike(state.homeId));
  els.searchPick.addEventListener('change', () => loadSearch(els.searchPick.value));
  for (const select of [els.fPrice, els.fBeds, els.fSchool]) {
    select.addEventListener('change', () => { writeStore(); closeMapCard(); scheduleMapLoad(); });
  }
  setInterval(refreshLinkStatus, 60000);
  setInterval(renderLinkStatus, 30000);
  window.addEventListener('hashchange', route);

  Promise.all([loadSearch(), loadLikes()]).then(route);
  refreshLinkStatus();
})();
