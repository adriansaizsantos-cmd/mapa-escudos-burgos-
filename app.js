const INE_MUNICIPALITIES = 'https://www.ine.es/servergis/rest/services/Hosted/DIRCE_total_2025/FeatureServer/2/query';
const INE_PROVINCES = 'https://www.ine.es/servergis/rest/services/Hosted/DIRCE_total_2025/FeatureServer/1/query';
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const STORAGE_KEY = 'burgos-shields-v1';
const THEME_KEY = 'burgos-shields-theme';
const DB_NAME = 'escudos-burgos-db';
const DB_VERSION = 1;
const DB_STORE = 'app';
let dbPromise;
const MAX_UNDO = 30;
const SPAIN_BOUNDS = [[36.0, -9.5], [43.95, 3.6]];

const state = {
  municipalities: [],
  byCode: new Map(),
  shields: {},
  favorites: {},
  settings: { onlyShields: false },
  selectedCode: null,
  filter: 'all',
  query: '',
  undo: [],
  map: null,
  provinceLayer: null,
  labelLayer: null,
  markerByCode: new Map(),
  burgosBounds: null,
  ready: false
};

const $ = (id) => document.getElementById(id);

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function snapshot() {
  state.undo.push(cloneData({ shields: state.shields, favorites: state.favorites, settings: state.settings }));
  if (state.undo.length > MAX_UNDO) state.undo.shift();
  $('undoBtn').disabled = false;
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function save() {
  const payload = { version: 1, shields: state.shields, favorites: state.favorites, settings: state.settings, savedAt: new Date().toISOString() };
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(payload, 'state');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // Fallback only for small collections/settings; large images should remain in IndexedDB.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
  }
}

async function loadSaved() {
  try {
    const db = await openDB();
    const data = await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get('state');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (data) {
      state.shields = data.shields && typeof data.shields === 'object' ? data.shields : {};
      state.favorites = data.favorites && typeof data.favorites === 'object' ? data.favorites : {};
      state.settings = { ...state.settings, ...(data.settings || {}) };
      return;
    }
  } catch (err) {
    console.warn('IndexedDB no disponible; usando respaldo local', err);
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.shields = data.shields && typeof data.shields === 'object' ? data.shields : {};
    state.favorites = data.favorites && typeof data.favorites === 'object' ? data.favorites : {};
    state.settings = { ...state.settings, ...(data.settings || {}) };
  } catch (err) { console.warn('No se pudo leer el almacenamiento local', err); }
}

function applyTheme() {
  const theme = localStorage.getItem(THEME_KEY) || 'light';
  document.documentElement.dataset.theme = theme;
  $('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
}

function normalizeMunicipality(feature) {
  const p = feature.properties || {};
  const code = String(p.codigo || p.cmun || '').padStart(5, '0');
  return { code, name: p.nmun || p.municipio || 'Municipio', geometry: feature.geometry };
}

async function fetchGeoJSON(url, params) {
  const qs = new URLSearchParams(params);
  const response = await fetch(`${url}?${qs.toString()}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadMunicipalities() {
  const data = await fetchGeoJSON(INE_MUNICIPALITIES, {
    where: "cpro='09'",
    outFields: 'codigo,nmun,cmun,cpro',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });
  if (!data.features || data.features.length !== 371) {
    throw new Error(`La fuente oficial devolvió ${data.features?.length || 0} municipios; se esperaban 371.`);
  }
  state.municipalities = data.features.map(normalizeMunicipality).sort((a,b) => a.name.localeCompare(b.name, 'es'));
  state.byCode = new Map(state.municipalities.map(m => [m.code, m]));
  state.municipalities.forEach(m => {
    const saved = state.shields[m.code];
    if (saved && saved.lat == null) delete state.shields[m.code];
  });
}

async function loadProvince() {
  const data = await fetchGeoJSON(INE_PROVINCES, {
    where: "cpro='09'",
    outFields: 'cpro,npro',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });
  if (!data.features?.length) throw new Error('No se pudo cargar el límite oficial de Burgos.');
  return data.features[0];
}

function createMap() {
  state.map = L.map('map', { zoomControl: true, minZoom: 5, maxZoom: 19, preferCanvas: true }).fitBounds(SPAIN_BOUNDS);
  L.tileLayer(ESRI_IMAGERY, {
    maxZoom: 19,
    attribution: '© Esri, Maxar, Earthstar Geographics y colaboradores'
  }).addTo(state.map);
  state.map.on('zoomend moveend', updateLabelVisibility);
}

function drawProvince(feature) {
  state.provinceLayer = L.geoJSON(feature, {
    style: { color: '#000000', weight: 3, opacity: .98, fillColor: '#000000', fillOpacity: .035 }
  }).addTo(state.map);
  state.burgosBounds = state.provinceLayer.getBounds();
  state.map.fitBounds(SPAIN_BOUNDS);
}

function centroidOfGeometry(geometry) {
  const coords = [];
  const walk = (x) => {
    if (!Array.isArray(x)) return;
    if (typeof x[0] === 'number' && typeof x[1] === 'number') { coords.push(x); return; }
    x.forEach(walk);
  };
  walk(geometry?.coordinates);
  if (!coords.length) return [42.34, -3.70];
  let sx = 0, sy = 0;
  coords.forEach(([lng, lat]) => { sx += lng; sy += lat; });
  return [sy / coords.length, sx / coords.length];
}

function defaultPosition(m) {
  const [lat, lng] = centroidOfGeometry(m.geometry);
  return { lat, lng };
}

function markerIcon(code, shield) {
  const size = Math.max(56, Math.min(260, shield.size || 120));
  const locked = shield.locked ? '<span class="lock-badge">🔒</span>' : '';
  const html = `<div class="shield-marker-inner ${shield.locked ? 'locked' : ''}"><img src="${shield.image}" alt="Escudo de ${escapeHtml(state.byCode.get(code)?.name || '')}">${locked}</div>`;
  return L.divIcon({ className: 'shield-marker', html, iconSize: [size, size], iconAnchor: [size/2, size/2] });
}

function renderShieldMarker(code) {
  const shield = state.shields[code];
  const existing = state.markerByCode.get(code);
  if (existing) {
    existing.remove();
    state.markerByCode.delete(code);
  }
  if (!shield || !shield.image) return;
  const marker = L.marker([shield.lat, shield.lng], {
    icon: markerIcon(code, shield),
    draggable: !shield.locked,
    autoPan: true,
    zIndexOffset: 500
  }).addTo(state.map);
  marker.on('click', () => selectMunicipality(code));
  marker.on('dragstart', () => {
    if (!state.shields[code]?.locked) snapshot();
  });
  marker.on('dragend', () => {
    if (state.shields[code]?.locked) return;
    const p = marker.getLatLng();
    state.shields[code].lat = p.lat;
    state.shields[code].lng = p.lng;
    save();
    refreshUI();
  });
  state.markerByCode.set(code, marker);
}

function renderAllShieldMarkers() {
  state.markerByCode.forEach(m => m.remove());
  state.markerByCode.clear();
  Object.keys(state.shields).forEach(renderShieldMarker);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function municipalityMatches(m) {
  const q = state.query.trim().toLocaleLowerCase('es');
  if (q && !m.name.toLocaleLowerCase('es').includes(q)) return false;
  const has = !!state.shields[m.code]?.image;
  if (state.filter === 'missing' && has) return false;
  if (state.filter === 'complete' && !has) return false;
  if (state.filter === 'favorites' && !state.favorites[m.code]) return false;
  return true;
}

function renderMunicipalityList() {
  const list = state.municipalities.filter(municipalityMatches);
  $('visibleCount').textContent = list.length;
  const container = $('municipalityList');
  if (!list.length) {
    container.innerHTML = '<div class="empty-state">No hay municipios que coincidan.</div>';
    return;
  }
  container.innerHTML = list.map(m => {
    const has = !!state.shields[m.code]?.image;
    const fav = !!state.favorites[m.code];
    const locked = !!state.shields[m.code]?.locked;
    return `<button class="municipality-item ${has ? 'complete' : ''}" data-code="${m.code}">
      <span class="dot"></span><span class="name">${escapeHtml(m.name)}</span>
      <span class="icons">${fav ? '★' : ''}${locked ? '🔒' : ''}</span>
    </button>`;
  }).join('');
  container.querySelectorAll('.municipality-item').forEach(btn => btn.addEventListener('click', () => selectMunicipality(btn.dataset.code)));
}

function updateStats() {
  const complete = Object.values(state.shields).filter(s => s?.image).length;
  const favs = Object.values(state.favorites).filter(Boolean).length;
  const locked = Object.values(state.shields).filter(s => s?.image && s.locked).length;
  const pct = (complete / 371) * 100;
  $('progressCount').textContent = complete;
  $('progressBar').style.width = `${pct}%`;
  $('progressPercent').textContent = `${pct.toFixed(1).replace('.0','')} % completado`;
  $('favoriteCount').textContent = favs;
  $('lockedCount').textContent = locked;
}

function refreshUI() {
  updateStats();
  renderMunicipalityList();
  renderPanel();
  updateLabelVisibility();
}

function selectMunicipality(code) {
  const m = state.byCode.get(code);
  if (!m) return;
  state.selectedCode = code;
  $('municipalityPanel').classList.remove('hidden');
  if (window.innerWidth <= 820) $('sidebar').classList.remove('open');
  if (state.map) {
    const shield = state.shields[code];
    const target = shield?.image ? [shield.lat, shield.lng] : defaultPosition(m);
    state.map.flyTo(target, Math.max(state.map.getZoom(), 11), { duration: .35 });
  }
  renderPanel();
}

function renderPanel() {
  const code = state.selectedCode;
  const m = code ? state.byCode.get(code) : null;
  if (!m) return;
  const shield = state.shields[code];
  $('panelMunicipalityName').textContent = m.name;
  const preview = $('panelShieldPreview');
  if (shield?.image) {
    preview.classList.remove('empty');
    preview.innerHTML = `<img src="${shield.image}" alt="Escudo de ${escapeHtml(m.name)}">`;
    $('uploadLabel').textContent = 'Cambiar imagen';
    $('shieldControls').classList.remove('hidden');
    $('sizeRange').value = shield.size || 120;
    $('sizeOutput').textContent = `${shield.size || 120} px`;
    $('lockBtn').textContent = shield.locked ? '🔓 Desbloquear posición' : '🔒 Bloquear posición';
    $('deleteShieldBtn').disabled = false;
  } else {
    preview.className = 'shield-preview empty';
    preview.textContent = 'Sin escudo añadido';
    $('uploadLabel').textContent = 'Añadir escudo';
    $('shieldControls').classList.add('hidden');
    $('deleteShieldBtn').disabled = true;
  }
  $('favoriteBtn').textContent = state.favorites[code] ? '★ Favorito' : '☆ Favorito';
}

function updateLabelVisibility() {
  if (!state.map || !state.municipalities.length) return;
  if (state.labelLayer) state.labelLayer.remove();
  state.labelLayer = L.layerGroup();
  const zoom = state.map.getZoom();
  if (!state.settings.onlyShields && zoom >= 10) {
    state.municipalities.forEach(m => {
      const [lat, lng] = defaultPosition(m);
      const marker = L.marker([lat, lng], {
        interactive: false,
        icon: L.divIcon({ className:'municipality-label', html:`<span>${escapeHtml(m.name)}</span>`, iconSize:null })
      });
      marker.addTo(state.labelLayer);
    });
    state.labelLayer.addTo(state.map);
  }
}

function toggleOnlyShields() {
  snapshot();
  state.settings.onlyShields = !state.settings.onlyShields;
  save();
  $('onlyShieldsBtn').textContent = state.settings.onlyShields ? '👁️ Ver municipios' : '👁️ Solo escudos';
  updateLabelVisibility();
}

function addOrReplaceShield(file) {
  if (!file || !state.selectedCode) return;
  if (!file.type.startsWith('image/')) return alert('Selecciona una imagen válida.');
  const reader = new FileReader();
  reader.onload = () => {
    const code = state.selectedCode;
    const previous = state.shields[code];
    snapshot();
    const position = previous?.lat != null ? { lat: previous.lat, lng: previous.lng } : defaultPosition(state.byCode.get(code));
    state.shields[code] = {
      image: reader.result,
      lat: position.lat,
      lng: position.lng,
      size: previous?.size || 120,
      locked: previous?.locked || false,
      updatedAt: new Date().toISOString()
    };
    save();
    renderShieldMarker(code);
    refreshUI();
    checkAchievements();
  };
  reader.readAsDataURL(file);
}

function toggleFavorite() {
  if (!state.selectedCode) return;
  snapshot();
  state.favorites[state.selectedCode] = !state.favorites[state.selectedCode];
  save(); refreshUI();
}

function deleteShield() {
  if (!state.selectedCode || !state.shields[state.selectedCode]) return;
  if (!confirm('¿Borrar el escudo de este municipio? La posición y configuración se eliminarán también.')) return;
  snapshot();
  const code = state.selectedCode;
  delete state.shields[code];
  renderShieldMarker(code);
  save(); refreshUI(); checkAchievements();
}

function toggleLock() {
  if (!state.selectedCode || !state.shields[state.selectedCode]) return;
  snapshot();
  state.shields[state.selectedCode].locked = !state.shields[state.selectedCode].locked;
  save(); renderShieldMarker(state.selectedCode); refreshUI();
}

function changeSize(value) {
  if (!state.selectedCode || !state.shields[state.selectedCode]) return;
  state.shields[state.selectedCode].size = Number(value);
  $('sizeOutput').textContent = `${value} px`;
  const marker = state.markerByCode.get(state.selectedCode);
  if (marker) marker.setIcon(markerIcon(state.selectedCode, state.shields[state.selectedCode]));
  save();
}

let sizeSnapshotTaken = false;
function beginSizeChange() {
  if (!state.selectedCode || !state.shields[state.selectedCode] || sizeSnapshotTaken) return;
  snapshot();
  sizeSnapshotTaken = true;
}
function finishSizeChange() {
  if (!state.selectedCode || !state.shields[state.selectedCode]) return;
  save();
  sizeSnapshotTaken = false;
}

function undo() {
  const previous = state.undo.pop();
  if (!previous) return;
  state.shields = previous.shields || {};
  state.favorites = previous.favorites || {};
  state.settings = previous.settings || { onlyShields:false };
  save(); renderAllShieldMarkers(); refreshUI();
  $('undoBtn').disabled = state.undo.length === 0;
}

function exportBackup() {
  const payload = {
    app: 'Escudos de Burgos',
    version: 1,
    exportedAt: new Date().toISOString(),
    municipalityCount: 371,
    shields: state.shields,
    favorites: state.favorites,
    settings: state.settings
  };
  const blob = new Blob([JSON.stringify(payload)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `escudos-burgos-backup-${new Date().toISOString().slice(0,10)}.json`; a.click();
  URL.revokeObjectURL(url);
}

function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.app !== 'Escudos de Burgos' || !data.shields || !data.favorites) throw new Error('Formato no reconocido.');
      snapshot();
      const clean = {};
      Object.entries(data.shields).forEach(([code, shield]) => {
        if (!state.byCode.has(code) || !shield?.image) return;
        clean[code] = {
          image: shield.image,
          lat: Number(shield.lat), lng: Number(shield.lng),
          size: Math.max(56, Math.min(260, Number(shield.size) || 120)),
          locked: !!shield.locked,
          updatedAt: shield.updatedAt || new Date().toISOString()
        };
      });
      state.shields = clean;
      state.favorites = Object.fromEntries(Object.entries(data.favorites).filter(([code,val]) => state.byCode.has(code) && !!val));
      state.settings = { ...state.settings, ...(data.settings || {}) };
      save(); renderAllShieldMarkers(); refreshUI(); checkAchievements();
      alert('Copia restaurada correctamente.');
    } catch (err) {
      alert(`No se pudo importar la copia: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function autoArrange() {
  const codes = Object.keys(state.shields).filter(code => state.shields[code]?.image && !state.shields[code].locked);
  if (!codes.length) return;
  if (!state.burgosBounds) return;
  snapshot();
  const center = state.burgosBounds.getCenter();
  const radiusLat = Math.max((state.burgosBounds.getNorth() - state.burgosBounds.getSouth()) * .42, .08);
  const radiusLng = Math.max((state.burgosBounds.getEast() - state.burgosBounds.getWest()) * .42, .08);
  codes.forEach((code, i) => {
    const angle = i * 0.82;
    const ring = Math.floor(i / 24) + 1;
    state.shields[code].lat = center.lat + Math.sin(angle) * radiusLat * (ring / Math.ceil(codes.length / 24));
    state.shields[code].lng = center.lng + Math.cos(angle) * radiusLng * (ring / Math.ceil(codes.length / 24));
  });
  save(); renderAllShieldMarkers(); refreshUI();
}

function checkAchievements() {
  const count = Object.values(state.shields).filter(s => s?.image).length;
  const milestones = [[1,'🏆 Primer escudo añadido'],[10,'🏆 10 municipios completados'],[50,'🏆 50 municipios completados'],[100,'🏆 100 municipios completados'],[371,'🏆 Colección completa de Burgos']];
  const hit = milestones.find(([n]) => count === n);
  if (!hit) return;
  const toast = $('achievementToast');
  toast.textContent = hit[1]; toast.classList.remove('hidden');
  clearTimeout(checkAchievements.timer);
  checkAchievements.timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function goBurgos() {
  if (state.burgosBounds) state.map.fitBounds(state.burgosBounds, { padding:[30,30] });
}
function goSpain() { state.map.fitBounds(SPAIN_BOUNDS); }

function closePanel() { state.selectedCode = null; $('municipalityPanel').classList.add('hidden'); }

function wireUI() {
  $('themeBtn').addEventListener('click', toggleTheme);
  $('burgosBtn').addEventListener('click', goBurgos);
  $('spainBtn').addEventListener('click', goSpain);
  $('onlyShieldsBtn').addEventListener('click', toggleOnlyShields);
  $('closePanelBtn').addEventListener('click', closePanel);
  $('shieldInput').addEventListener('change', e => { addOrReplaceShield(e.target.files[0]); e.target.value=''; });
  $('favoriteBtn').addEventListener('click', toggleFavorite);
  $('deleteShieldBtn').addEventListener('click', deleteShield);
  $('lockBtn').addEventListener('click', toggleLock);
  $('sizeRange').addEventListener('pointerdown', beginSizeChange);
  $('sizeRange').addEventListener('input', e => changeSize(e.target.value));
  $('sizeRange').addEventListener('change', finishSizeChange);
  $('undoBtn').addEventListener('click', undo);
  $('arrangeBtn').addEventListener('click', autoArrange);
  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', e => { importBackup(e.target.files[0]); e.target.value=''; });
  $('searchInput').addEventListener('input', e => { state.query = e.target.value; renderMunicipalityList(); });
  document.querySelectorAll('.filter').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); state.filter = btn.dataset.filter; renderMunicipalityList();
  }));
  $('fullscreenBtn').addEventListener('click', async () => {
    try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); } catch {}
    setTimeout(() => state.map.invalidateSize(), 250);
  });
  // Mobile sidebar gesture/button: the top-left area is intentionally kept minimal.
  const mobileMenu = document.querySelector('.topbar');
  mobileMenu.addEventListener('click', e => {
    if (window.innerWidth > 820) return;
    if (e.target.closest('.icon-btn')) return;
    $('sidebar').classList.toggle('open');
  });
}

async function init() {
  await loadSaved(); applyTheme(); wireUI(); createMap();
  $('mapStatus').textContent = 'Cargando datos oficiales…';
  try {
    const [municipalityPromise, provincePromise] = [loadMunicipalities(), loadProvince()];
    const [_, province] = await Promise.all([municipalityPromise, provincePromise]);
    drawProvince(province);
    state.ready = true;
    renderAllShieldMarkers();
    refreshUI();
    $('mapStatus').textContent = 'Datos oficiales · INE';
    setTimeout(() => { $('mapStatus').style.opacity = '.55'; }, 2200);
  } catch (err) {
    console.error(err);
    $('mapStatus').textContent = 'Error al cargar datos oficiales';
    $('municipalityList').innerHTML = `<div class="empty-state">No se han podido cargar los 371 municipios desde la fuente oficial del INE.<br><br><small>${escapeHtml(err.message)}</small></div>`;
  }
}

init();
