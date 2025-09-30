/*
  Frontend app (Vanilla JS)
  - uses Supabase JS client for upload and DB sync
  - integrates with Google Maps (client key must be set in index.html)
  - calls Supabase Edge Function to ingest station (photo QC via OpenAI)
*/

/* ====== CONFIG (replace with your values or set via env in deploy) ====== */
const SUPABASE_URL = window.SUPABASE_URL || (typeof NEXT_PUBLIC_SUPABASE_URL !== 'undefined' ? NEXT_PUBLIC_SUPABASE_URL : null);
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || (typeof NEXT_PUBLIC_SUPABASE_ANON_KEY !== 'undefined' ? NEXT_PUBLIC_SUPABASE_ANON_KEY : null);
if(!SUPABASE_URL || !SUPABASE_ANON_KEY){
  console.warn('Supabase keys not found in runtime. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY for full functionality.');
}

/* Dynamically import supabase client if available */
let supabase = null;
(async () => {
  if(SUPABASE_URL && SUPABASE_ANON_KEY){
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');
    supabase = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
})();

/* Basic app state and sample stations */
const OLD_CITY_CENTER = { lat: 18.7875, lng: 98.993333 };
const RADIUS_METERS = 2000;
let map, userMarker, userPos = null, markers = [], stations = [];

/* Utils */
function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
function distanceMeters(a,b){
  if(!a || !b) return 0;
  const toRad = v=>v*Math.PI/180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const sin1 = Math.sin(dLat/2), sin2 = Math.sin(dLon/2);
  const aa = sin1*sin1 + Math.cos(lat1)*Math.cos(lat2)*sin2*sin2;
  const c = 2*Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R * c;
}

/* Load local storage fallback */
function loadLocalStations(){
  const raw = localStorage.getItem('sabai_stations_v1');
  if(raw){ try{ stations = JSON.parse(raw); }catch(e){ stations = []; } }
  if(!stations || stations.length===0){
    stations = [
      { id:'s1', name:'Sample RO — Moon Muang', lat:18.7882, lng:98.9965, price:0.60, photos:[], rating:4.6, reviews:[] },
      { id:'s2', name:'Sample RO — Ratchadamnoen', lat:18.7879, lng:98.9938, price:0.50, photos:[], rating:4.3, reviews:[] }
    ];
  }
}
function saveLocalStations(){ localStorage.setItem('sabai_stations_v1', JSON.stringify(stations)); }

/* Initialize Map */
function initMap(){
  map = new google.maps.Map(document.getElementById('map'), { center: OLD_CITY_CENTER, zoom:15 });
  // draw 2km circle
  new google.maps.Circle({ map, center: OLD_CITY_CENTER, radius: RADIUS_METERS, fillColor:'#d7f3ff', fillOpacity:0.25, strokeColor:'#3aa0ff', strokeOpacity:0.6, strokeWeight:2 });
  renderMarkers();
  map.addListener('click', e => {
    document.getElementById('sLat').value = e.latLng.lat().toFixed(6);
    document.getElementById('sLng').value = e.latLng.lng().toFixed(6);
  });
}

/* Render markers from stations array */
function clearMarkers(){ markers.forEach(m=>m.setMap(null)); markers = []; }
function renderMarkers(filtered){
  clearMarkers();
  const list = filtered || stations;
  list.forEach(st => {
    const m = new google.maps.Marker({ position:{lat:parseFloat(st.lat), lng:parseFloat(st.lng)}, map, title:st.name });
    m.addListener('click', () => {
      const iw = new google.maps.InfoWindow({ content: `<div style="min-width:220px"><strong>${escapeHtml(st.name)}</strong><div>${st.price} ฿/L</div></div>` });
      iw.open(map, m);
    });
    markers.push(m);
  });
}

/* UI: refresh list */
function refreshList(){
  const container = document.getElementById('listContainer');
  container.innerHTML = '';
  const filtered = stations.filter(s => distanceMeters({lat:s.lat,lng:s.lng}, OLD_CITY_CENTER) <= RADIUS_METERS);
  filtered.forEach(s => {
    const el = document.createElement('div'); el.className='stationItem';
    el.innerHTML = `<div style="display:flex;gap:10px;align-items:center"><div style="height:48px;width:48px;border-radius:8px;background:linear-gradient(135deg,#90e0ef,#00b4d8);display:flex;align-items:center;justify-content:center;color:#fff">W</div><div><div style="font-weight:700">${escapeHtml(s.name)}</div><div class="stationMeta">${(distanceMeters({lat:s.lat,lng:s.lng}, userPos||OLD_CITY_CENTER)/1000).toFixed(2)} km • ${s.price} ฿/L</div></div></div><div style="text-align:right"><div style="font-weight:700">${s.rating?Number(s.rating).toFixed(1):'—'}★</div><div><button class="btn small" data-id="${s.id}" data-action="show">Show</button><button class="btn alt small" data-id="${s.id}" data-action="route">Route</button></div></div>`;
    container.appendChild(el);
  });
  container.querySelectorAll('button[data-action="show"]').forEach(b=>b.onclick = e => {
    const id = e.target.getAttribute('data-id'); const st = stations.find(x=>x.id===id);
    if(st){ map.panTo({lat:parseFloat(st.lat), lng:parseFloat(st.lng)}); map.setZoom(17); }
  });
  container.querySelectorAll('button[data-action="route"]').forEach(b=>b.onclick = e=>{
    const id = e.target.getAttribute('data-id'); const st = stations.find(x=>x.id===id);
    if(st){
      if(userPos) window.open(`https://www.google.com/maps/dir/?api=1&origin=${userPos.lat},${userPos.lng}&destination=${st.lat},${st.lng}`, '_blank');
      else alert('Allow geolocation to route from your location.');
    }
  });
}

/* Handle form save: upload to Supabase Edge function (ingest-station) which will perform photo upload & AI QC */
async function handleSave(){
  const name = document.getElementById('sName').value.trim();
  const lat = parseFloat(document.getElementById('sLat').value);
  const lng = parseFloat(document.getElementById('sLng').value);
  const price = parseFloat(document.getElementById('sPrice').value);
  const note = document.getElementById('sNote').value;
  const photoInput = document.getElementById('sPhoto');
  if(!name || isNaN(lat) || isNaN(lng) || isNaN(price)) return alert('Please fill name, lat, lng and price');
  let photoData = null;
  if(photoInput && photoInput.files && photoInput.files[0]){
    photoData = await fileToBase64(photoInput.files[0]);
  }
  // call edge function (replace /functions/upload by full URL when deployed)
  try{
    const payload = { name, lat, lng, price, note, photo_base64: photoData };
    // If Supabase Edge Function URL available, call it; otherwise fallback to local storage
    if(typeof EDGE_FUNCTION_INGEST_URL !== 'undefined' && EDGE_FUNCTION_INGEST_URL){
      const resp = await fetch(EDGE_FUNCTION_INGEST_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const data = await resp.json();
      if(resp.ok){
        alert('Station uploaded and processed: ' + (data.analysis?.summary || 'OK'));
        // optionally refetch stations from DB
      } else {
        alert('Upload failed: ' + (data.error || resp.statusText));
      }
    } else {
      // local fallback: save to local storage
      const id = 's' + Date.now();
      stations.push({ id, name, lat, lng, price, note, photos: photoData ? [photoData] : [], rating:0, reviews:[] });
      saveLocalStations(); renderMarkers(); refreshList(); alert('Saved locally (Edge function URL not configured).');
    }
  }catch(err){ console.error(err); alert('Error: ' + err.message); }
}

/* helpers */
function fileToBase64(file){ return new Promise((res, rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(file); }); }

/* bootstrap */
document.addEventListener('DOMContentLoaded', ()=>{
  loadLocalStations();
  refreshList();
  // init map once google maps loaded
  const gmInterval = setInterval(()=>{ if(window.google && google.maps && typeof google.maps.Map === 'function'){ clearInterval(gmInterval); initMap(); renderMarkers(); refreshList(); } }, 200);
  document.getElementById('addBtn').addEventListener('click', handleSave);
  document.getElementById('clearBtn').addEventListener('click', ()=>{ document.getElementById('sName').value=''; document.getElementById('sLat').value=''; document.getElementById('sLng').value=''; document.getElementById('sPrice').value=''; document.getElementById('sNote').value=''; document.getElementById('sPhoto').value=''; document.getElementById('photoPreview').innerHTML=''; });
  document.getElementById('sPhoto').addEventListener('change', async (e)=>{ const f=e.target.files[0]; if(!f) return; const b=await fileToBase64(f); document.getElementById('photoPreview').innerHTML = `<img src="${b}" class="thumb">`; });
  // locate
  document.getElementById('locateBtn').addEventListener('click', ()=>{ if(!navigator.geolocation) return alert('Geolocation not supported'); navigator.geolocation.getCurrentPosition(p=>{ userPos={lat:p.coords.latitude,lng:p.coords.longitude}; if(window.userMarker) userMarker.setMap(null); userMarker=new google.maps.Marker({position:userPos,map, title:'You', icon: { path: google.maps.SymbolPath.CIRCLE, scale:8, fillColor:'#00b4d8', fillOpacity:1, strokeColor:'#fff', strokeWeight:2 } }); map.panTo(userPos); }, e=>alert('Location error: '+e.message), { enableHighAccuracy:true }); });
});
