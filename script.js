import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getDatabase, ref, get, set, onValue } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDuQt4SWSlH0xYaFXtZgK069Zre9A5Fiwg",
  authDomain: "waypoint-57c7b.firebaseapp.com",
  databaseURL: "https://waypoint-57c7b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "waypoint-57c7b",
  storageBucket: "waypoint-57c7b.firebasestorage.app",
  messagingSenderId: "971481412931",
  appId: "1:971481412931:web:3f8bc1b9dd263c33eeebf6"
};
const fbApp = initializeApp(firebaseConfig);
const db = getDatabase(fbApp);

/* ---------------- Config ---------------- */
const CATEGORIES = {
  gate:    { label: 'Main Gate / Entry',   color: '#38BDF8', code: 'GATE' },
  academic:{ label: 'Academic Block',      color: '#F5A623', code: 'ACAD' },
  hostel:  { label: 'Hostel / PG',         color: '#2DD4BF', code: 'HSTL' },
  hospital:{ label: 'Hospital / Medical',  color: '#F43F5E', code: 'MED'  },
  society: { label: 'Society / Building',  color: '#8B5CF6', code: 'SOC'  },
  other:   { label: 'Other',               color: '#94A3B8', code: 'PT'   },
};

const DEFAULT_CENTER = [19.0760, 72.8777]; // Mumbai fallback
let map, tempMarker = null, tempLatLng = null, addMode = false;
let buildingLayer = null, buildings3DOn = false, buildingRequestId = 0;
let waypoints = [];
let markerLayer = {};
let ownerPin = null;      // stored (shared) — the passcode the owner set
let isOwner = false;      // this session only
let mapTitle = '';        // stored (shared) — display name for this campus map
let userLoc = null;       // visitor's live GPS, used for distance + directions accuracy

/* ---------------- Modal helpers ---------------- */
function openModal(html){
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').style.display = 'flex';
}
function closeModal(){
  document.getElementById('modal-overlay').style.display = 'none';
}
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if(e.target.id === 'modal-overlay') closeModal();
});

function modalError(msg){
  const el = document.getElementById('modal-err');
  if(el){ el.textContent = msg; el.style.display = 'block'; }
}

function openConfirmModal(title, body, onYes){
  openModal(
    '<h3>' + title + '</h3><p>' + body + '</p>' +
    '<div class="row"><button class="btn" id="m-no">Cancel</button>' +
    '<button class="btn btn-accent" id="m-yes">Confirm</button></div>'
  );
  document.getElementById('m-no').addEventListener('click', closeModal);
  document.getElementById('m-yes').addEventListener('click', () => { closeModal(); onYes(); });
}

function openOwnerModal(){
  if(!ownerPin){
    openModal(
      '<h3>Claim Owner Access</h3>' +
      '<p>Set a passcode. Anyone with this passcode can add, edit or delete waypoints — everyone else can only view and scan. Share it only with people you trust to manage the map.</p>' +
      '<input id="m-pin1" type="text" placeholder="Choose a passcode" />' +
      '<div id="modal-err"></div>' +
      '<div class="row"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn btn-accent" id="m-set">Set & Log In</button></div>'
    );
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('m-set').addEventListener('click', async () => {
      const val = document.getElementById('m-pin1').value.trim();
      if(val.length < 4){ modalError('Use at least 4 characters.'); return; }
      ownerPin = val;
      isOwner = true;
      await saveOwnerPin();
      closeModal();
      updateOwnerUI();
      setStatus('You are now the map owner.');
    });
  } else {
    openModal(
      '<h3>Owner Login</h3>' +
      '<p>Enter the map passcode to unlock editing.</p>' +
      '<input id="m-pin2" type="text" placeholder="Passcode" />' +
      '<div id="modal-err"></div>' +
      '<div class="row"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn btn-accent" id="m-login">Log In</button></div>'
    );
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('m-login').addEventListener('click', () => {
      const val = document.getElementById('m-pin2').value.trim();
      if(val !== ownerPin){ modalError('Incorrect passcode.'); return; }
      isOwner = true;
      closeModal();
      updateOwnerUI();
      setStatus('Editing unlocked.');
    });
  }
}

document.getElementById('tagline-text').addEventListener('click', async () => {
  if(!isOwner) return;
  const val = prompt('Name this campus map (shown on the printed QR poster):', mapTitle || '');
  if(val === null) return;
  mapTitle = val.trim();
  document.getElementById('tagline-text').textContent = mapTitle || 'scan once, find any exact spot on campus';
  await saveMapTitle();
});

document.getElementById('owner-btn').addEventListener('click', () => {
  if(isOwner){
    openConfirmModal('Log out?', 'You will go back to view-only mode on this device.', () => {
      isOwner = false;
      addMode = false;
      hideAddForm();
      updateOwnerUI();
      setStatus('Logged out — view only now.');
    });
  } else {
    openOwnerModal();
  }
});

function updateOwnerUI(){
  const btn = document.getElementById('owner-btn');
  btn.classList.toggle('is-owner', isOwner);
  btn.textContent = isOwner ? '🔓 Owner (logout)' : (ownerPin ? '🔒 Owner Login' : '🔑 Claim Owner Access');
  document.getElementById('toggle-add').style.display = isOwner ? 'inline-block' : 'none';
  document.getElementById('clear-btn').style.display = isOwner ? 'inline-block' : 'none';
  document.getElementById('viewer-banner').style.display = isOwner ? 'none' : 'block';
  const tag = document.getElementById('tagline-text');
  tag.style.cursor = isOwner ? 'pointer' : 'default';
  tag.title = isOwner ? 'Click to rename this campus map' : '';
  renderAllMarkers();
  renderList();
}

/* ---------------- Init map ---------------- */
function initMap(center){
  map = L.map('map', { zoomControl: true }).setView(center, 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  buildingLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    if(!addMode || !isOwner) return;
    tempLatLng = e.latlng;
    if(tempMarker) map.removeLayer(tempMarker);
    tempMarker = L.marker(e.latlng).addTo(map);
    document.getElementById('coord-preview').textContent = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6);
    document.getElementById('add-form').style.display = 'block';
    document.getElementById('wp-name').focus();
  });
}

function renderExtrudedBuilding(ring, height){
  const depth = Math.min(.00022, Math.max(.000055, height / 210000));
  const offset = ring.map(([lat,lng]) => [lat + depth, lng + depth * 1.15]);
  for(let i=0;i<ring.length-1;i++){
    L.polygon([ring[i],ring[i+1],offset[i+1],offset[i]], {color:'#9CB9A8', weight:1, opacity:.55, fillColor:'#55766F', fillOpacity:.48, interactive:false}).addTo(buildingLayer);
  }
  L.polygon(offset, {color:'#D8FF44', weight:1, opacity:.5, fillColor:'#789A86', fillOpacity:.53, interactive:false, className:'building-top'}).addTo(buildingLayer);
}

function renderFallbackBuildings(){
  const bounds = map.getBounds();
  const latSpan = bounds.getNorth() - bounds.getSouth();
  const lngSpan = bounds.getEast() - bounds.getWest();
  const latSize = Math.min(latSpan * .075, .00062);
  const lngSize = Math.min(lngSpan * .08, .0008);
  let count = 0;
  for(let row=1;row<7;row++){
    for(let col=1;col<8;col++){
      if((row * 7 + col * 11) % 4 === 0) continue;
      const lat = bounds.getSouth() + latSpan * (row / 8);
      const lng = bounds.getWest() + lngSpan * (col / 9);
      const skew = ((row + col) % 3) * .00004;
      const ring = [[lat,lng],[lat + latSize,lng + skew],[lat + latSize,lng + lngSize + skew],[lat,lng + lngSize],[lat,lng]];
      renderExtrudedBuilding(ring, 8 + ((row * 3 + col) % 6) * 3);
      count++;
    }
  }
  return count;
}

async function load3DBuildings(){
  if(!map || !buildingLayer) return;
  buildingLayer.clearLayers();
  const bounds = map.getBounds().pad(.06);
  const token = ++buildingRequestId;
  setStatus('Loading 3D building footprints…');
  const query = '[out:json][timeout:18];way["building"](' + bounds.getSouth() + ',' + bounds.getWest() + ',' + bounds.getNorth() + ',' + bounds.getEast() + ');out geom;';
  try{
    const res = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query));
    if(!res.ok) throw new Error('building data unavailable');
    const data = await res.json();
    if(token !== buildingRequestId || !buildings3DOn) return;
    let count = 0;
    (data.elements || []).forEach((building) => {
      const ring = (building.geometry || []).map(point => [point.lat, point.lon]);
      if(ring.length < 3) return;
      const levels = parseFloat(building.tags && building.tags['building:levels']) || 2;
      const height = parseFloat(building.tags && building.tags.height) || levels * 3.2;
      renderExtrudedBuilding(ring, height);
      count++;
    });
    if(count){ setStatus(count + ' 3D buildings rendered.'); }
    else { const fallbackCount = renderFallbackBuildings(); setStatus('3D massing fallback · ' + fallbackCount + ' buildings shown.'); }
  }catch(err){
    if(token === buildingRequestId && buildings3DOn){
      const fallbackCount = renderFallbackBuildings();
      setStatus('3D massing fallback · ' + fallbackCount + ' buildings shown.');
    }
  }
}

document.getElementById('toggle-3d').addEventListener('click', () => {
  buildings3DOn = !buildings3DOn;
  const button = document.getElementById('toggle-3d');
  button.classList.toggle('is-active', buildings3DOn);
  button.setAttribute('aria-pressed', String(buildings3DOn));
  button.textContent = buildings3DOn ? '3D on' : '3D buildings';
  if(buildings3DOn) load3DBuildings();
  else { buildingRequestId++; buildingLayer.clearLayers(); setStatus('3D building layer hidden.'); }
});

function renderCategoryChips(container, selectedKey, onSelect){
  container.innerHTML = '';
  Object.entries(CATEGORIES).forEach(([key, c]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cat-chip' + (key === selectedKey ? ' active' : '');
    chip.textContent = c.label;
    chip.addEventListener('click', () => onSelect(key));
    container.appendChild(chip);
  });
}
let addSelectedCat = Object.keys(CATEGORIES)[0];
function refreshAddChips(){
  renderCategoryChips(document.getElementById('wp-cat-chips'), addSelectedCat, (key) => {
    addSelectedCat = key;
    refreshAddChips();
  });
}

/* ---------------- Add mode toggle ---------------- */
document.getElementById('toggle-add').addEventListener('click', () => {
  if(!isOwner){ openOwnerModal(); return; }
  addMode = !addMode;
  const btn = document.getElementById('toggle-add');
  btn.classList.toggle('active', addMode);
  btn.textContent = addMode ? '✕ Cancel Adding' : '＋ Add Waypoint';
  document.getElementById('map-hint').style.display = addMode ? 'block' : 'none';
  if(!addMode) hideAddForm();
});

function hideAddForm(){
  document.getElementById('add-form').style.display = 'none';
  document.getElementById('wp-name').value = '';
  if(tempMarker){ map.removeLayer(tempMarker); tempMarker = null; }
}

document.getElementById('wp-cancel').addEventListener('click', hideAddForm);

document.getElementById('wp-confirm').addEventListener('click', () => {
  const name = document.getElementById('wp-name').value.trim();
  const cat = addSelectedCat;
  if(!name || !tempLatLng){ return; }
  addWaypoint(name, cat, tempLatLng.lat, tempLatLng.lng);
  hideAddForm();
});

/* ---------------- Waypoint logic ---------------- */
function nextSeq(catKey){
  const count = waypoints.filter(w => w.cat === catKey).length + 1;
  return String(count).padStart(2,'0');
}

function addWaypoint(name, cat, lat, lng){
  const seq = nextSeq(cat);
  const wp = {
    id: 'wp_' + Date.now() + '_' + Math.floor(Math.random()*999),
    name, cat, lat, lng,
    code: CATEGORIES[cat].code + '-' + seq
  };
  waypoints.push(wp);
  saveWaypoints();
  renderMarker(wp);
  renderList();
}

function updateWaypoint(id, name, cat){
  const wp = waypoints.find(w => w.id === id);
  if(!wp) return;
  wp.name = name;
  if(wp.cat !== cat){
    wp.cat = cat;
    wp.code = CATEGORIES[cat].code + '-' + nextSeq(cat);
  }
  saveWaypoints();
  renderAllMarkers();
  renderList();
}

function moveWaypoint(id, lat, lng){
  const wp = waypoints.find(w => w.id === id);
  if(!wp) return;
  wp.lat = lat; wp.lng = lng;
  saveWaypoints();
  renderList();
}

function removeWaypoint(id){
  waypoints = waypoints.filter(w => w.id !== id);
  if(markerLayer[id]){ map.removeLayer(markerLayer[id]); delete markerLayer[id]; }
  saveWaypoints();
  renderList();
}

function mapsUrl(wp){
  // No origin specified on purpose — Google Maps auto-uses the visitor's live GPS
  // as the starting point, so directions are exact to this precise pin.
  return 'https://www.google.com/maps/dir/?api=1&destination=' + wp.lat.toFixed(6) + ',' + wp.lng.toFixed(6) + '&travelmode=walking';
}

function haversine(lat1, lng1, lat2, lng2){
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDist(m){
  return m < 1000 ? Math.round(m) + ' m away' : (m / 1000).toFixed(1) + ' km away';
}
function tryLocate(){
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => { userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; renderList(); },
    () => { /* permission denied or unavailable — fall back silently */ },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function renderMarker(wp){
  const c = CATEGORIES[wp.cat];
  const icon = L.divIcon({
    className: '',
    html: '<div class="wp-pin" style="background:' + c.color + '"><span>' + c.code[0] + '</span></div>',
    iconSize: [26,26], iconAnchor: [13,26]
  });
  const marker = L.marker([wp.lat, wp.lng], { icon, draggable: isOwner }).addTo(map);
  const popupDiv = document.createElement('div');
  popupDiv.className = 'popup-inner';
  popupDiv.innerHTML = '<div class="pname">' + escapeHtml(wp.name) + '</div><div class="pcat">' + c.label + ' · ' + wp.code + (isOwner ? ' · drag pin to reposition' : '') + '</div><a class="pdir" href="' + mapsUrl(wp) + '" target="_blank" rel="noopener">🧭 Get Directions</a>';
  marker.bindPopup(popupDiv);
  if(isOwner){
    marker.on('dragend', (ev) => {
      const pos = ev.target.getLatLng();
      moveWaypoint(wp.id, pos.lat, pos.lng);
    });
  }
  markerLayer[wp.id] = marker;
}

function renderAllMarkers(){
  Object.values(markerLayer).forEach(m => map.removeLayer(m));
  markerLayer = {};
  waypoints.forEach(renderMarker);
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ---------------- Sidebar list ---------------- */
function renderList(){
  const list = document.getElementById('wp-list');
  const sortedByDist = !isOwner && userLoc;
  document.getElementById('wp-count').textContent = waypoints.length + (waypoints.length === 1 ? ' location mapped' : ' locations mapped') + (isOwner ? '' : (sortedByDist ? ' · nearest first' : ' · view only'));
  list.innerHTML = '';
  if(waypoints.length === 0){
    list.innerHTML = '<div id="empty-state">No waypoints yet.<br><br>' + (isOwner ?
      '<b>Click "＋ Add Waypoint"</b> then tap the exact spot — a hostel gate, hospital entrance, or society block — so visitors get pinpoint directions.' :
      "The map owner hasn't added any locations yet.") + '</div>';
    return;
  }

  let ordered;
  if(sortedByDist){
    ordered = waypoints.map(wp => ({ wp, d: haversine(userLoc.lat, userLoc.lng, wp.lat, wp.lng) }))
      .sort((a, b) => a.d - b.d).map(x => x.wp);
  } else {
    ordered = waypoints.slice().reverse();
  }

  ordered.forEach(wp => {
    const c = CATEGORIES[wp.cat];
    const coordLine = userLoc
      ? '<span class="ticket-dist">' + formatDist(haversine(userLoc.lat, userLoc.lng, wp.lat, wp.lng)) + '</span>'
      : wp.lat.toFixed(5) + ', ' + wp.lng.toFixed(5);
    const card = document.createElement('div');
    card.className = 'ticket';
    card.innerHTML =
      '<div class="stripe" style="background:' + c.color + '"></div>' +
      '<div class="ticket-body">' +
        '<div class="ticket-info" id="info-' + wp.id + '">' +
          '<div class="ticket-code">' + wp.code + '</div>' +
          '<div class="ticket-name">' + escapeHtml(wp.name) + '</div>' +
          '<div class="ticket-cat" style="background:' + c.color + '22;color:' + c.color + '">' + c.label + '</div>' +
          '<div class="ticket-coords">' + coordLine + '</div>' +
          '<div class="ticket-actions">' +
            '<a class="btn-dir" href="' + mapsUrl(wp) + '" target="_blank" rel="noopener">🧭 Directions</a>' +
            '<button data-act="focus" data-id="' + wp.id + '">📍 Focus</button>' +
            (isOwner ? '<button data-act="edit" data-id="' + wp.id + '">✎ Edit</button><button data-act="del" data-id="' + wp.id + '" class="danger">Delete</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    list.appendChild(card);
  });

  list.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const wp = waypoints.find(w => w.id === id);
      if(!wp) return;
      if(btn.dataset.act === 'focus'){
        map.setView([wp.lat, wp.lng], 19);
        markerLayer[id].openPopup();
      } else if(btn.dataset.act === 'del'){
        openConfirmModal('Delete waypoint?', 'Remove "' + escapeHtml(wp.name) + '" from the map. This cannot be undone.', () => removeWaypoint(id));
      } else if(btn.dataset.act === 'edit'){
        openEditRow(wp);
      }
    });
  });
}

function openEditRow(wp){
  const info = document.getElementById('info-' + wp.id);
  if(!info) return;
  let editCat = wp.cat;
  const chipsId = 'edit-cat-chips-' + wp.id;
  info.innerHTML =
    '<div class="edit-row"><label>Name</label><input id="edit-name-' + wp.id + '" type="text" value="' + escapeHtml(wp.name).replace(/"/g,'&quot;') + '" /></div>' +
    '<div class="edit-row"><label>Category</label><div class="cat-chips" id="' + chipsId + '"></div></div>' +
    '<div class="ticket-actions">' +
      '<button data-save="' + wp.id + '">✓ Save</button>' +
      '<button data-cancel="' + wp.id + '">Cancel</button>' +
    '</div>';
  const chipsEl = document.getElementById(chipsId);
  function refreshEditChips(){
    renderCategoryChips(chipsEl, editCat, (key) => { editCat = key; refreshEditChips(); });
  }
  refreshEditChips();
  info.querySelector('[data-save]').addEventListener('click', () => {
    const newName = document.getElementById('edit-name-' + wp.id).value.trim();
    if(!newName) return;
    updateWaypoint(wp.id, newName, editCat);
  });
  info.querySelector('[data-cancel]').addEventListener('click', renderList);
}

/* ---------------- Single Campus QR (share modal + poster print) ---------------- */
let shareUrl = (location.protocol === 'http:' || location.protocol === 'https:') ? location.href : '';

function renderMasterQr(){
  const holder = document.getElementById('master-qr');
  if(!holder) return;
  holder.innerHTML = '';
  const err = document.getElementById('qr-url-err');
  if(!shareUrl){
    if(err){ err.style.display = 'block'; err.textContent = 'Enter the public web address this file is hosted at, then click Update.'; }
    return;
  }
  if(typeof QRCode === 'undefined'){
    if(err){ err.style.display = 'block'; err.textContent = 'QR library failed to load — check your internet connection and reload the page.'; }
    return;
  }
  if(err) err.style.display = 'none';
  new QRCode(holder, { text: shareUrl, width: 180, height: 180, colorDark: '#0B1220', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
}

function openShareModal(){
  openModal(
    '<h3>📱 Campus QR</h3>' +
    '<p>One QR for the whole campus. This only works if <b>this file is hosted at a real, public web address</b> — a QR pointing at a file on your own computer or an unpublished preview can\'t be reached by someone else\'s phone. Confirm the address below, then print the poster.</p>' +
    '<label style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:3px;">Public URL of this page</label>' +
    '<div class="link-row"><input id="share-link" type="text" placeholder="https://your-site.com/campus-map.html" value="' + (shareUrl ? shareUrl.replace(/"/g,'&quot;') : '') + '" /><button class="btn" id="update-link">Update</button></div>' +
    '<div id="qr-url-err" style="color:#f43f5e;font-size:11.5px;margin:-4px 0 10px;display:none;"></div>' +
    '<div id="master-qr"></div>' +
    '<div class="row"><button class="btn" id="copy-link">Copy link</button><button class="btn" id="m-close">Close</button></div>' +
    '<div class="row" style="margin-top:8px;"><button class="btn btn-accent" id="m-print" style="width:100%;">🖨 Print Poster</button></div>'
  );
  renderMasterQr();
  document.getElementById('m-close').addEventListener('click', closeModal);
  document.getElementById('update-link').addEventListener('click', () => {
    shareUrl = document.getElementById('share-link').value.trim();
    renderMasterQr();
  });
  document.getElementById('copy-link').addEventListener('click', async () => {
    if(!shareUrl){ setStatus('Enter the public URL first.'); return; }
    try{ await navigator.clipboard.writeText(shareUrl); setStatus('Link copied.'); }
    catch(err){ setStatus('Could not copy — copy the link manually.'); }
  });
  document.getElementById('m-print').addEventListener('click', () => {
    if(!shareUrl){ setStatus('Enter the public URL first, then print.'); return; }
    closeModal();
    printPoster();
  });
}
function printPoster(){
  const sheet = document.getElementById('print-sheet');
  sheet.innerHTML = '<div class="poster-qr"></div><h2>' + escapeHtml(mapTitle || 'Campus Map') + '</h2><p>Scan to open the map — tap any location for exact walking directions</p>';
  new QRCode(sheet.querySelector('.poster-qr'), { text: shareUrl, width: 260, height: 260, colorDark:'#111', colorLight:'#ffffff', correctLevel: QRCode.CorrectLevel.H });
  setTimeout(() => window.print(), 250);
}
document.getElementById('share-btn').addEventListener('click', () => {
  if(waypoints.length === 0){ setStatus('Add at least one waypoint before sharing the campus QR.'); return; }
  openShareModal();
});

/* ---------------- Export ---------------- */
document.getElementById('export-btn').addEventListener('click', () => {
  if(waypoints.length === 0){ setStatus('Nothing to export yet.'); return; }
  const rows = ['code,name,category,lat,lng,maps_url'];
  waypoints.forEach(wp => {
    rows.push([wp.code, '"'+wp.name.replace(/"/g,'""')+'"', CATEGORIES[wp.cat].label, wp.lat, wp.lng, mapsUrl(wp)].join(','));
  });
  const blob = new Blob([rows.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'campus_waypoints.csv';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('CSV exported (' + waypoints.length + ' waypoints).');
});

document.getElementById('clear-btn').addEventListener('click', () => {
  if(!isOwner){ openOwnerModal(); return; }
  if(waypoints.length === 0){ setStatus('Nothing to clear.'); return; }
  openConfirmModal('Clear all waypoints?', 'This removes all ' + waypoints.length + ' waypoints and their QR tags for everyone viewing this map. This cannot be undone.', () => {
    waypoints = [];
    saveWaypoints();
    renderAllMarkers();
    renderList();
    setStatus('All waypoints cleared.');
  });
});

/* ---------------- Search / geocode ---------------- */
async function geocode(query){
  setStatus('Searching…');
  try{
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query));
    const data = await res.json();
    if(data && data.length){
      const lat = parseFloat(data[0].lat), lon = parseFloat(data[0].lon);
      map.setView([lat, lon], 17);
      setStatus('Found: ' + data[0].display_name.split(',').slice(0,2).join(','));
    } else {
      setStatus('No match — click the map to place a pin manually.');
    }
  } catch(err){
    setStatus('Search unavailable — click the map directly instead.');
  }
}
document.getElementById('search-btn').addEventListener('click', () => {
  const q = document.getElementById('search-input').value.trim();
  if(q) geocode(q);
});
document.getElementById('search-input').addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){ e.preventDefault(); document.getElementById('search-btn').click(); }
});

function setStatus(msg){
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => { el.textContent = ''; }, 5000);
}

/* ---------------- Persistence ---------------- */
// Backed by Firebase Realtime Database, so every device that loads this page
// (owner or QR-scanning visitor) reads/writes the same shared data. Falls
// back to localStorage only if Firebase is unreachable (e.g. offline), so
// the page doesn't hard-crash — but that fallback is local-only and won't
// sync to other devices.
async function storageGet(key){
  try{
    const snap = await get(ref(db, key));
    if(snap.exists()) return snap.val();
    return null;
  } catch(err){
    console.error('Firebase read failed, falling back to local cache', err);
    try{ return localStorage.getItem('waypoint_' + key); } catch(e){ return null; }
  }
}
async function storageSet(key, value){
  try{
    await set(ref(db, key), value);
  } catch(err){
    console.error('Firebase write failed — this change will NOT be visible to other devices', err);
    setStatus('⚠️ Could not save to shared database — check your connection.');
  }
  try{ localStorage.setItem('waypoint_' + key, typeof value === 'string' ? value : JSON.stringify(value)); }
  catch(e){ /* local cache best-effort only */ }
}

async function saveWaypoints(){ await storageSet('campus-waypoints', waypoints); }
async function loadWaypoints(){
  const val = await storageGet('campus-waypoints');
  waypoints = val ? (Array.isArray(val) ? val : Object.values(val)) : [];
}
async function saveOwnerPin(){ await storageSet('owner-pin', ownerPin); }
async function loadOwnerPin(){ ownerPin = await storageGet('owner-pin'); }
async function saveMapTitle(){ await storageSet('campus-title', mapTitle); }
async function loadMapTitle(){ mapTitle = (await storageGet('campus-title')) || ''; }

// Live sync: if the owner adds/edits waypoints on one device, any other
// open tab (e.g. a visitor already viewing the map) updates automatically
// without needing to refresh.
function startLiveSync(){
  onValue(ref(db, 'campus-waypoints'), (snap) => {
    if(!snap.exists()) return;
    const val = snap.val();
    waypoints = Array.isArray(val) ? val : Object.values(val || {});
    renderAllMarkers();
    renderList();
  });
}

/* ---------------- Boot ---------------- */
(async function boot(){
  refreshAddChips();
  initMap(DEFAULT_CENTER);
  await loadOwnerPin();
  await loadMapTitle();
  await loadWaypoints();
  renderAllMarkers();
  renderList();
  if(mapTitle){ document.getElementById('tagline-text').textContent = mapTitle; }
  updateOwnerUI();
  tryLocate();
  setStatus(ownerPin ? 'Search your college, then log in as owner to add exact locations.' : 'Search your college, then claim owner access to start pinning exact locations.');
  startLiveSync();
})();
