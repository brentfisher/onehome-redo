(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SLIDE_MS = 4000;
  // The server's photo addresses for a home go stale, so re-ask after a while.
  const DETAIL_TTL_MS = 15 * 60 * 1000;

  const els = {
    grid: $('grid-view'), cards: $('cards'), gridStatus: $('grid-status'),
    searchName: $('search-name'), searchCount: $('search-count'), sort: $('sort'),
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
    cameFromGrid: false,
    gridScroll: 0,
    loadToken: 0,
    timer: null,
    toastTimer: null,
    wakeLock: null,
  };
  const detailCache = new Map();

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
    const homes = [...state.homes];
    if (mode === 'price-desc') homes.sort(by('price', -1));
    else if (mode === 'price-asc') homes.sort(by('price', 1));
    else if (mode === 'sqft-desc') homes.sort(by('sqft', -1));
    state.order = homes;
  }

  function renderCards() {
    els.cards.replaceChildren(...state.order.map((home) => {
      const img = h('img', { src: imgUrl(home.id, 0), alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => img.remove());
      return h('button', { class: 'card', type: 'button', onclick: () => openFromGrid(home.id) },
        img,
        isSet(home.status) && h('span', { class: home.status === 'Active' ? 'badge' : 'badge other' }, home.status),
        h('div', { class: 'card-body' },
          h('div', { class: 'card-top' },
            h('span', { class: 'card-price' }, money(home.price)),
            h('span', { class: 'card-stats' }, statsLine(home))),
          h('div', { class: 'card-address' }, [home.street, home.cityLine].filter(Boolean).join(', '))));
    }));
  }

  async function loadSearch() {
    els.gridStatus.className = 'status';
    els.gridStatus.textContent = 'Loading homes…';
    els.gridStatus.hidden = false;
    els.cards.replaceChildren();
    try {
      const search = await getJson('/api/search');
      state.homes = search.homes || [];
      els.searchName.textContent = search.name || 'Homes';
      document.title = search.name || 'Homes';
      els.searchCount.textContent = `${state.homes.length} ${state.homes.length === 1 ? 'home' : 'homes'}`;
      sortHomes();
      renderCards();
      els.gridStatus.hidden = state.homes.length > 0;
      els.gridStatus.textContent = 'This search has no homes right now.';
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

  const homeIndex = () => state.order.findIndex((home) => home.id === state.homeId);

  function writeHash() {
    const hash = `#/home/${encodeURIComponent(state.homeId)}/${state.photoIndex + 1}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function openFromGrid(id) {
    state.gridScroll = window.scrollY;
    state.cameFromGrid = true;
    location.hash = `#/home/${encodeURIComponent(id)}/1`;
  }

  function showViewer() {
    if (!els.viewer.hidden) return;
    els.grid.hidden = true;
    els.viewer.hidden = false;
    els.viewer.classList.remove('clean');
    requestWakeLock();
  }

  function showGrid() {
    stopSlideshow();
    closeSheets();
    releaseWakeLock();
    state.homeId = null;
    state.detail = null;
    els.viewer.hidden = true;
    els.grid.hidden = false;
    window.scrollTo(0, state.gridScroll);
  }

  function renderHeadline(home) {
    els.price.textContent = money(home.price);
    els.stats.textContent = statsLine(home);
    els.address.textContent = [home.street, home.cityLine].filter(Boolean).join(', ');
    const index = homeIndex();
    els.homeCount.textContent = index >= 0 ? `Home ${index + 1} of ${state.order.length}` : '';
  }

  // `photo` is a zero-based index, or 'last'.
  async function openHome(id, photo) {
    showViewer();
    closeSheets();
    const token = ++state.loadToken;
    state.homeId = id;
    state.detail = null;
    state.photoIndex = 0;

    const summary = state.order.find((home) => home.id === id);
    if (summary) renderHeadline(summary);
    els.photoCount.textContent = '';
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
    for (const neighbour of [state.order[index + 1], state.order[index - 1]]) {
      if (neighbour) getDetail(neighbour.id).catch(() => {});
    }
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
    const next = state.order[homeIndex() + direction];
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
    const lot = isSet(d.lot) ? `${text(d.lot)} ${d.lotUnits || ''}`.trim() : null;

    els.detailsBody.replaceChildren(
      h('h2', null, money(d.price)),
      h('p', { class: 'where' }, [d.street, d.cityLine].filter(Boolean).join(', ')),
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
      ...section('Schools', factList([
        ['Elementary', p.ElementarySchool],
        ['Middle', p.MiddleOrJuniorSchool],
        ['High', p.HighSchool],
      ])),
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
        ['County', p.CountyOrParish],
        ['Community', p.CommunityFeatures],
      ])),
      ...section('Listing', factList([
        ['MLS #', p.ListingId],
        ['Listed by', [p.ListAgentFullName, p.ListOfficeName].filter(Boolean).join(', ')],
      ])),
    );
    els.details.scrollTop = 0;
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
    if (name === 'details') renderDetails(); else renderPhotoSheet();
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
    try {
      await getJson('/api/link', {
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
    history.replaceState(null, '', '#/');
    showGrid();
    loadSearch();
  }

  // ---------- routing and input ----------

  function route() {
    const match = location.hash.match(/^#\/home\/([^/]+)(?:\/(\d+))?/);
    if (!match) { showGrid(); return; }
    const id = decodeURIComponent(match[1]);
    const index = Math.max((Number(match[2]) || 1) - 1, 0);
    if (id === state.homeId && state.detail) {
      if (index !== state.photoIndex) showPhoto(Math.min(index, state.detail.photos.length - 1));
      return;
    }
    openHome(id, index);
  }

  function goBack() {
    if (state.cameFromGrid) { state.cameFromGrid = false; history.back(); return; }
    history.replaceState(null, '', '#/');
    showGrid();
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
    if (document.visibilityState === 'visible' && !els.viewer.hidden) requestWakeLock();
  });

  els.sort.addEventListener('change', () => { sortHomes(); renderCards(); });
  $('change-link').addEventListener('click', () => showLinkDialog('Paste the link your agent sent you (the whole address, including ?token=…).'));
  $('link-cancel').addEventListener('click', () => els.dialog.close());
  $('link-form').addEventListener('submit', submitLink);
  window.addEventListener('hashchange', route);

  loadSearch().then(route);
})();
