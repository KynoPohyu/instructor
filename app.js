/* Автоинструктор — интерфейс приложения */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAGANROG_BBOX = [47.17, 38.78, 47.30, 39.02]; // юг, запад, север, восток
  const TAGANROG_CENTER = [47.218, 38.915];
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  // ---------- Настройки ----------
  const DEF = { name: '', rate: 1, tolerance: 5, tips: true, calm: true, muted: false };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ai.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ai.' + k, JSON.stringify(v)); } catch (e) { /* нет места */ } }
  };
  const settings = Object.assign({}, DEF, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // ---------- IndexedDB (карта) ----------
  const IDB = {
    db: null,
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('autoinstructor', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    },
    get(k) {
      return new Promise((res, rej) => {
        const q = this.db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
    },
    set(k, v) {
      return new Promise((res, rej) => {
        const tx = this.db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
    }
  };

  // ---------- Голос ----------
  const Voice = {
    voice: null,
    ok: 'speechSynthesis' in window,
    init() {
      if (!this.ok) return;
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find(v => /^ru/i.test(v.lang) && /milena|милена/i.test(v.name))
          || vs.find(v => /^ru/i.test(v.lang)) || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    },
    unlock() { // iOS разрешает речь только после нажатия
      if (!this.ok) return;
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { /* */ }
    },
    say(text, prio) {
      showSubtitle(text);
      if (!this.ok || settings.muted) return;
      if (prio >= 3) speechSynthesis.cancel();
      else if (prio === 0 && (speechSynthesis.speaking || speechSynthesis.pending)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      if (this.voice) u.voice = this.voice;
      u.rate = settings.rate;
      speechSynthesis.speak(u);
    }
  };
  let subTimer = 0;
  function showSubtitle(text) {
    if (!document.body.classList.contains('driving')) return;
    const el = $('subtitle');
    el.textContent = text; el.classList.remove('hidden');
    clearTimeout(subTimer);
    subTimer = setTimeout(() => el.classList.add('hidden'), Math.max(4000, text.length * 75));
  }
  function toast(text, ms) {
    const el = $('toast'); el.textContent = text; el.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms || 2500);
  }

  // ---------- Модальное окно ----------
  function modal(html, onClose) {
    $('modalBody').innerHTML = html;
    $('modal').classList.remove('hidden');
    modal.onClose = onClose || null;
  }
  function closeModal() { $('modal').classList.add('hidden'); if (modal.onClose) { const f = modal.onClose; modal.onClose = null; f(); } }
  $('modalClose').onclick = closeModal;
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Карта ----------
  const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true }).setView(TAGANROG_CENTER, 13);
  map.attributionControl.setPrefix(false);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  let vectorLayer = null, vectorOn = false, tileErrors = 0;
  tiles.on('tileerror', () => { if (++tileErrors >= 4) showVector(true); });
  tiles.on('tileload', () => { tileErrors = 0; });
  window.addEventListener('offline', () => showVector(true));

  function buildVector() {
    if (!G) return null;
    const styles = [
      { color: '#ffb648', weight: 6 }, { color: '#ffb648', weight: 6 }, { color: '#f5d76e', weight: 5 },
      { color: '#e8e3c8', weight: 4.5 }, { color: '#d7dde2', weight: 4 }, { color: '#aeb8c1', weight: 3 },
      { color: '#aeb8c1', weight: 3 }, { color: '#7e8b96', weight: 2.5 }, { color: '#5d6a75', weight: 2 }
    ];
    const lines = styles.map(() => []);
    for (let w = 0; w < G.wName.length; w++) {
      const a = G.wStart[w], b = G.wStart[w + 1], line = [];
      for (let k = a; k < b; k++) { const i = G.wNodes[k]; line.push([G.lat[i], G.lon[i]]); }
      if (line.length > 1) lines[G.wHw[w]].push(line);
    }
    const group = L.layerGroup();
    for (let c = lines.length - 1; c >= 0; c--) if (lines[c].length) group.addLayer(L.polyline(lines[c], Object.assign({ interactive: false, opacity: 0.95 }, styles[c])));
    return group;
  }
  function showVector(on) {
    if (on === vectorOn) return;
    if (on) {
      if (!vectorLayer) vectorLayer = buildVector();
      if (!vectorLayer) return;
      vectorLayer.addTo(map);
    } else if (vectorLayer) map.removeLayer(vectorLayer);
    vectorOn = on;
  }

  const meMarker = L.marker(TAGANROG_CENTER, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false });
  const destMarker = L.marker(TAGANROG_CENTER, { icon: L.divIcon({ className: '', html: '<div class="dest-pin"></div>', iconSize: [26, 26], iconAnchor: [13, 26] }), interactive: false });
  let routeLine = null, doneLine = null;

  // ---------- Данные ----------
  let G = null, ADDR = null, STREETS = null;
  async function loadData() {
    try {
      await IDB.open();
      const g = await IDB.get('graph');
      if (g && g.v === 1) { G = g; Core.indexGraph(G); STREETS = Core.buildStreetIndex(G); }
      ADDR = (await IDB.get('addr')) || null;
    } catch (e) { console.warn(e); }
    updateMapStatus();
    if (!navigator.onLine) showVector(true);
    if (!G) setTimeout(openMapData, 600);
  }
  function updateMapStatus() {
    const el = $('mapStatus');
    if (!G) { el.className = 'status warn'; el.textContent = 'Карта ещё не скачана. Нажми «Карта города», чтобы она работала без интернета.'; return; }
    const d = new Date(G.created);
    el.className = 'status';
    el.textContent = `Офлайн-карта сохранена ${d.toLocaleDateString('ru-RU')} · ${G.wName.length.toLocaleString('ru-RU')} улиц и проездов` + (ADDR ? ` · ${ADDR.length.toLocaleString('ru-RU')} адресов` : '');
  }

  async function overpass(q, status) {
    let lastErr = null;
    for (const ep of OVERPASS) {
      try {
        status(`Связываюсь с сервером карт (${new URL(ep).host})…`);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 200000);
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        if (!r.ok) { clearTimeout(timer); throw new Error('сервер ответил ' + r.status); }
        status('Скачиваю данные…');
        const j = await r.json();
        clearTimeout(timer);
        if (!j.elements || !j.elements.length) throw new Error('пустой ответ');
        return j.elements;
      } catch (e) { lastErr = e; console.warn(ep, e); }
    }
    throw lastErr || new Error('нет связи');
  }

  async function downloadMap(bbox) {
    const st = (t, p) => { const s = $('dlStatus'); if (s) s.textContent = t; const b = $('dlBar'); if (b && p != null) b.style.width = p + '%'; };
    const btns = document.querySelectorAll('#modalBody button'); btns.forEach(b => b.disabled = true);
    try {
      st('Скачиваю дороги…', 5);
      const roads = await overpass(Core.overpassRoadsQuery(bbox), (t) => st('Дороги: ' + t, 15));
      st('Строю дорожный граф…', 55);
      await new Promise(r => setTimeout(r, 50));
      const g = Core.buildGraph(roads, bbox);
      await IDB.set('graph', g);
      G = g; Core.indexGraph(G); STREETS = Core.buildStreetIndex(G);
      if (vectorLayer) { if (vectorOn) map.removeLayer(vectorLayer); vectorLayer = null; vectorOn = false; }
      st('Дороги сохранены. Скачиваю адреса домов…', 65);
      try {
        const ad = await overpass(Core.overpassAddrQuery(bbox), (t) => st('Адреса: ' + t, 75));
        ADDR = Core.buildAddresses(ad);
        await IDB.set('addr', ADDR);
      } catch (e) { st('Адреса скачать не удалось — поиск будет только по улицам. Можно повторить позже.', 95); }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      st('Готово! Карта сохранена в телефоне и работает без интернета.', 100);
      updateMapStatus();
    } catch (e) {
      st('Не получилось скачать: ' + e.message + '. Проверь интернет и попробуй ещё раз.', 0);
    }
    btns.forEach(b => b.disabled = false);
  }

  function openMapData() {
    const has = !!G;
    modal(`<h2>Карта города</h2>
      <p>${has ? 'Офлайн-карта уже есть. Можно обновить её — например, раз в пару месяцев.' : 'Чтобы навигатор работал без интернета, один раз скачай карту Таганрога. Нужен интернет (лучше Wi-Fi), это займёт 1–3 минуты.'}</p>
      <div class="progress"><div id="dlBar"></div></div>
      <p id="dlStatus" class="muted"></p>
      <div class="row"><button class="btn primary" id="dlTag">${has ? 'Обновить Таганрог' : 'Скачать Таганрог'}</button></div>
      <div class="row"><button class="btn" id="dlView">Скачать то, что видно на карте</button></div>
      <p class="muted" style="font-size:13px">Данные карты — © участники OpenStreetMap.</p>`);
    $('dlTag').onclick = () => downloadMap(TAGANROG_BBOX);
    $('dlView').onclick = () => {
      const b = map.getBounds(), bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(x => +x.toFixed(4));
      if ((bb[2] - bb[0]) * (bb[3] - bb[1]) > 0.06) { $('dlStatus').textContent = 'Слишком большая область. Приблизь карту к нужному городу.'; return; }
      downloadMap(bb);
    };
  }

  // ---------- Местоположение ----------
  let lastFix = null;
  function getPosition(timeout) {
    return new Promise((res) => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(
        (p) => { lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, t: Date.now() }; res(lastFix); },
        () => res(null),
        { enableHighAccuracy: true, timeout: timeout || 10000, maximumAge: 15000 }
      );
    });
  }
  $('btnLocate').onclick = async () => {
    if (driving) { follow = true; if (lastFix) map.setView([lastFix.lat, lastFix.lon], 17); return; }
    toast('Ищу тебя на карте…');
    const p = await getPosition();
    if (!p) { toast('Не удалось определить место. Разреши доступ к геопозиции.'); return; }
    meMarker.setLatLng([p.lat, p.lon]).addTo(map);
    map.setView([p.lat, p.lon], 16);
  };

  // ---------- Поиск ----------
  function favs() { return store.get('favs', []); }
  function renderResults(items) {
    const ul = $('results');
    ul.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}`;
      li.onclick = () => { $('q').blur(); selectDest([it.lat, it.lon], it.label); };
      ul.appendChild(li);
    }
  }
  function showFavs() { renderResults(favs().map(f => ({ label: f.label, lat: f.lat, lon: f.lon, sub: '★' }))); }
  $('q').addEventListener('input', () => {
    const q = $('q').value.trim();
    if (!q) { showFavs(); return; }
    if (!G) { renderResults([]); $('hint').textContent = 'Сначала скачай карту города (кнопка «Карта города»).'; return; }
    const f = favs().filter(x => Core.norm(x.label).includes(Core.norm(q))).map(x => ({ ...x, sub: '★' }));
    const res = f.concat(Core.search(q, STREETS, ADDR, 8));
    renderResults(res);
    $('hint').textContent = res.length ? '' : 'Ничего не нашлось. Попробуй иначе или нажми на карту.';
  });
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const li = $('results').querySelector('li'); if (li) li.click(); } });

  // ---------- Предпросмотр маршрута ----------
  let dest = null, destLabel = '', previewRoute = null, origin = null;
  map.on('click', (e) => { if (!driving) selectDest([e.latlng.lat, e.latlng.lng], 'Точка на карте'); });

  async function selectDest(ll, label) {
    if (!G) { openMapData(); return; }
    dest = ll; destLabel = label;
    destMarker.setLatLng(ll).addTo(map);
    $('homeView').classList.add('hidden'); $('previewView').classList.remove('hidden');
    $('pvTitle').textContent = label;
    $('pvInfo').textContent = 'Определяю, где ты…';
    $('pvCalm').checked = settings.calm;
    const p = await getPosition(8000);
    origin = p ? [p.lat, p.lon] : null;
    if (origin) meMarker.setLatLng(origin).addTo(map);
    computePreview();
  }
  function computePreview() {
    if (!dest) return;
    let from = origin, note = '';
    if (!from || Core.dist(from[0], from[1], dest[0], dest[1]) > 60000) {
      const c = map.getCenter();
      from = [c.lat, c.lng];
      if (Core.dist(from[0], from[1], dest[0], dest[1]) < 300) from = TAGANROG_CENTER;
      note = origin ? 'Ты сейчас далеко от карты — маршрут построен от центра (для демо). ' : 'Геопозиция недоступна — маршрут построен от центра карты (для демо). ';
    }
    const r = Core.findRoute(G, from, dest, { calm: $('pvCalm').checked });
    if (r.error) {
      previewRoute = null; clearRouteLines();
      $('pvInfo').textContent = { start: 'Рядом с тобой нет дорог из скачанной карты.', end: 'Рядом с точкой назначения нет дороги.', same: 'Ты уже на месте 🙂', noroute: 'Не получилось проложить маршрут. Попробуй выбрать точку рядом.' }[r.error];
      $('btnGo').disabled = $('btnDemo').disabled = true;
      return;
    }
    previewRoute = r; previewRoute.from = from; previewRoute.demoOnly = !!note;
    $('btnGo').disabled = false; $('btnDemo').disabled = false;
    const turns = r.maneuvers.length - 1;
    $('pvInfo').textContent = `${note}${Core.distWords(r.length)} · около ${Core.minutesWords(r.time)} · ${turns} ${Core.plural(turns, 'манёвр', 'манёвра', 'манёвров')}`;
    drawRoute(r);
    map.fitBounds(routeLine.getBounds(), { paddingTopLeft: [30, 30], paddingBottomRight: [30, $('sheet').offsetHeight + 30] });
  }
  $('pvCalm').onchange = () => { settings.calm = $('pvCalm').checked; saveSettings(); computePreview(); };
  function clearRouteLines() { if (routeLine) map.removeLayer(routeLine); if (doneLine) map.removeLayer(doneLine); routeLine = doneLine = null; }
  function drawRoute(r) {
    clearRouteLines();
    routeLine = L.layerGroup([
      L.polyline(r.pts, { color: '#0b3d2a', weight: 11, opacity: 0.9, interactive: false }),
      L.polyline(r.pts, { color: '#3ddc97', weight: 7, opacity: 1, interactive: false })
    ]).addTo(map);
    routeLine.getBounds = () => L.latLngBounds(r.pts);
  }
  function backHome() {
    dest = null; previewRoute = null; clearRouteLines(); map.removeLayer(destMarker);
    $('previewView').classList.add('hidden'); $('homeView').classList.remove('hidden');
    $('q').value = ''; showFavs(); $('hint').textContent = 'Или нажми на карту, чтобы выбрать точку.';
    sheetHeight();
  }
  $('btnCancel').onclick = backHome;
  $('btnFav').onclick = () => {
    const name = prompt('Как назвать это место? Например: Дом, Работа, Мама', destLabel !== 'Точка на карте' ? destLabel : '');
    if (!name) return;
    const f = favs().filter(x => x.label !== name);
    f.unshift({ label: name, lat: dest[0], lon: dest[1] });
    store.set('favs', f.slice(0, 20));
    toast('Сохранено ★');
  };
  $('btnGo').onclick = () => {
    if (!previewRoute) return;
    if (previewRoute.demoOnly) { toast('Ты далеко от маршрута — запускаю демо'); startDrive(previewRoute, true); return; }
    startDrive(previewRoute, false);
  };
  $('btnDemo').onclick = () => previewRoute && startDrive(previewRoute, true);
  $('btnFree').onclick = () => {
    if (!G) { openMapData(); return; }
    startDrive(null, false);
  };

  // ---------- Поездка ----------
  let driving = false, demo = false, session = null, watchId = null, simTimer = null, wakeLock = null, follow = true, rerouting = false;
  map.on('dragstart', () => { if (driving) follow = false; });

  async function requestWake() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) { /* */ }
  }
  document.addEventListener('visibilitychange', () => { if (driving && document.visibilityState === 'visible') requestWake(); });

  function startDrive(route, isDemo) {
    Voice.unlock();
    driving = true; demo = isDemo; follow = true; rerouting = false;
    document.body.classList.add('driving');
    $('drivePanel').classList.remove('hidden'); $('driveBottom').classList.remove('hidden');
    $('btnMute').textContent = settings.muted ? '🔇' : '🔊';
    session = Core.createSession(G, route, { name: settings.name, tolerance: settings.tolerance, tips: settings.tips });
    requestWake();
    if (route) {
      drawRoute(route);
      doneLine = L.polyline([], { color: '#5d6a75', weight: 7, opacity: 1, interactive: false }).addTo(map);
      setTimeout(() => Voice.say(Core.startPhrase(route, settings.name), 2), 300);
    } else {
      clearRouteLines();
      setTimeout(() => Voice.say(`${settings.name ? settings.name + ', ' : ''}катаемся без маршрута. Я слежу за скоростью и подскажу, если что. Спокойно, не спеши.`, 2), 300);
    }
    renderState({ kmh: 0, limit: 60, street: '', next: route ? route.maneuvers[0] && { ...route.maneuvers[0], dist: route.maneuvers[0].cum } : null, remaining: route ? route.length : null, remainingTime: route ? route.time : null });
    map.setZoom(17);
    if (isDemo) runDemo(route);
    else if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(onFix, (err) => {
        if (err.code === 1) Voice.say('Мне нужен доступ к геопозиции. Разреши его в настройках телефона.', 3);
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    }
  }

  function runDemo(route) {
    if (!route) return;
    let d = 0, t = Date.now(), v = 0;
    simTimer = setInterval(() => {
      if (!session || !session.route) return;
      const r = session.route;
      const m = r.maneuvers.find(x => x.cum > d - 5);
      const near = m && m.type !== 'arrive' && m.cum - d < 45 && m.cum - d > -15;
      const target = near ? 5 : 11; // ~18 и ~40 км/ч
      v += Math.max(-2, Math.min(2, target - v)); // плавно, как аккуратный водитель
      d += v; t += 1000;
      const p = Core.pointAt(r.pts, r.cum, d);
      onFix({ coords: { latitude: p[0], longitude: p[1], speed: v, accuracy: 5, heading: null }, timestamp: t });
    }, 1000);
  }

  function onFix(pos) {
    if (!driving) return;
    const c = pos.coords;
    const fix = { lat: c.latitude, lon: c.longitude, speed: c.speed, acc: c.accuracy, heading: c.heading, t: pos.timestamp || Date.now() };
    lastFix = fix;
    meMarker.setLatLng([fix.lat, fix.lon]).addTo(map);
    if (follow) map.panTo([fix.lat, fix.lon], { animate: true, duration: 0.5 });
    const out = session.update(fix);
    for (const e of out.events) {
      if (e.text) Voice.say(e.text, e.prio);
      if (e.reroute) reroute(fix);
      if (e.arrived) setTimeout(() => stopDrive(true), 2500);
    }
    renderState(out.state);
    if (doneLine && session.route && out.state.along != null) {
      const r = session.route, pts = [];
      for (let k = 0; k < r.pts.length && r.cum[k] <= out.state.along; k++) pts.push(r.pts[k]);
      pts.push(Core.pointAt(r.pts, r.cum, out.state.along));
      doneLine.setLatLngs(pts);
    }
  }

  function reroute(fix) {
    if (rerouting || !dest) return;
    rerouting = true;
    setTimeout(() => {
      const r = Core.findRoute(G, [fix.lat, fix.lon], dest, { calm: settings.calm });
      rerouting = false;
      if (r.error) { Voice.say('Не получается построить новый маршрут. Остановись в безопасном месте, и попробуем ещё раз.', 2); return; }
      session.setRoute(r);
      drawRoute(r);
      if (doneLine) { map.removeLayer(doneLine); }
      doneLine = L.polyline([], { color: '#5d6a75', weight: 7, interactive: false }).addTo(map);
      Voice.say(`Новый маршрут: ${Core.distWords(r.length)}.`, 1);
    }, 30);
  }

  const ICONS = {
    straight: '<path d="M24 42V8"/><path d="M13 19L24 8l11 11"/>',
    turn_right: '<path d="M14 42V26a8 8 0 0 1 8-8h18"/><path d="M31 9l9 9-9 9"/>',
    turn_left: '<path d="M34 42V26a8 8 0 0 0-8-8H8"/><path d="M17 9l-9 9 9 9"/>',
    slight_right: '<path d="M18 42V28l16-16"/><path d="M22 11h13v13"/>',
    slight_left: '<path d="M30 42V28L14 12"/><path d="M26 11H13v13"/>',
    uturn_left: '<path d="M32 42V20a8 8 0 0 0-16 0v18"/><path d="M8 30l8 8 8-8"/>',
    roundabout_right: '<circle cx="24" cy="20" r="8"/><path d="M24 42V28"/><path d="M30 14l9-9"/><path d="M31 5h8v8"/>',
    arrive: '<path d="M14 42V7"/><path d="M14 8h21l-6 8 6 8H14"/>',
    free: '<path d="M8 32a16 16 0 0 1 32 0"/><path d="M24 32l8-10"/><circle cx="24" cy="32" r="2.5"/>'
  };
  function iconFor(n) {
    if (!n) return ICONS.free;
    if (n.type === 'arrive') return ICONS.arrive;
    return ICONS[n.type + '_' + n.dir] || ICONS.straight;
  }
  function renderState(st) {
    const spd = Math.round(st.kmh || 0);
    $('spd').textContent = spd;
    $('lim').textContent = st.limit || 60;
    $('spd').parentElement.classList.toggle('over', spd > (st.limit || 60) + settings.tolerance);
    const panel = $('drivePanel');
    if (st.next) {
      panel.classList.remove('free');
      $('manIcon').innerHTML = `<svg viewBox="0 0 48 48">${iconFor(st.next)}</svg>`;
      const d = st.next.dist;
      $('manDist').textContent = d >= 1000 ? (d / 1000).toFixed(1).replace('.', ',') + ' км' : (d >= 200 ? Math.round(d / 50) * 50 : Math.round(d / 10) * 10) + ' м';
      const what = { turn: st.next.dir === 'right' ? 'Направо' : 'Налево', slight: st.next.dir === 'right' ? 'Правее' : 'Левее', uturn: 'Разворот', roundabout: `Кольцо, ${st.next.exit}-й съезд`, arrive: 'Финиш' }[st.next.type] || '';
      $('manName').textContent = what + (st.next.name ? ' · ' + st.next.name : '');
      $('rem').textContent = Core.distWords(st.remaining).replace('километра', 'км').replace('километров', 'км').replace('километр', 'км').replace(/метр\S*/, 'м');
      $('remT').textContent = st.remainingTime != null ? 'ещё ~' + Core.minutesWords(st.remainingTime) : '';
    } else {
      panel.classList.add('free');
      $('manIcon').innerHTML = `<svg viewBox="0 0 48 48">${ICONS.free}</svg>`;
      $('manDist').textContent = 'Свободная езда';
      $('manName').textContent = st.street || '';
      const s = session ? session.stats : null;
      $('rem').textContent = s ? (s.dist / 1000).toFixed(1).replace('.', ',') + ' км' : '';
      $('remT').textContent = 'проехали';
    }
  }

  function stopDrive(arrived) {
    if (!driving) return;
    driving = false;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearInterval(simTimer); simTimer = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    const stats = session.finish(lastFix ? lastFix.t : Date.now());
    const wasDemo = demo;
    session = null;
    document.body.classList.remove('driving');
    $('drivePanel').classList.add('hidden'); $('driveBottom').classList.add('hidden'); $('subtitle').classList.add('hidden');
    if (!arrived && Voice.ok) speechSynthesis.cancel();
    showSummary(stats, arrived, wasDemo);
    backHome();
  }
  $('btnStop').onclick = () => { if (confirm('Завершить поездку?')) stopDrive(false); };
  $('btnMute').onclick = () => {
    settings.muted = !settings.muted; saveSettings();
    $('btnMute').textContent = settings.muted ? '🔇' : '🔊';
    if (settings.muted && Voice.ok) speechSynthesis.cancel();
  };

  function verdict(s) {
    const issues = s.speeding + s.hardBrakes;
    if (issues === 0) return 'Идеальная поездка — ни одного превышения и резкого торможения. Ты умница!';
    if (issues <= 2) return 'Очень хорошо! Пара моментов есть — в следующий раз будет ещё лучше.';
    return 'Ты справилась! Есть над чем поработать: следи за скоростью и тормози плавнее. Каждая поездка — это опыт.';
  }
  function showSummary(s, arrived, wasDemo) {
    const mins = s.start && s.end ? Math.max(1, Math.round((s.end - s.start) / 60000)) : 0;
    const km = (s.dist / 1000).toFixed(1).replace('.', ',');
    if (!wasDemo && s.dist > 200) {
      const h = store.get('history', []);
      h.unshift({ date: Date.now(), km: s.dist / 1000, mins, speeding: s.speeding, brakes: s.hardBrakes, maxKmh: Math.round(s.maxKmh), to: destLabel || 'Свободная езда' });
      store.set('history', h.slice(0, 200));
    }
    modal(`<h2>${arrived ? 'Приехали! 🎉' : 'Поездка завершена'}</h2>
      ${wasDemo ? '<p class="muted">Это была демо-поездка, в историю она не записывается.</p>' : ''}
      <div class="stats">
        <div class="stat"><b>${km} км</b><small>проехали</small></div>
        <div class="stat"><b>${mins} мин</b><small>в пути</small></div>
        <div class="stat"><b>${s.speeding}</b><small>превышений скорости</small></div>
        <div class="stat"><b>${s.hardBrakes}</b><small>резких торможений</small></div>
      </div>
      <p>${verdict(s)}</p>`);
  }

  // ---------- Чек-лист ----------
  const CHECK = [
    'Отрегулируй кресло: колени чуть согнуты, запястья достают до верха руля.',
    'Настрой зеркала: салонное и оба боковых. Края своей машины — чуть видны.',
    'Пристегнись и попроси пассажиров пристегнуться.',
    'Автомат — в положении P, механика — нейтраль и ручник. Потом заводи.',
    'Включи ближний свет фар — по правилам он нужен и днём.',
    'Закрепи телефон в держателе. Во время езды его не трогаем — я всё скажу голосом.',
    'Рядом сидит опытный водитель. Договоритесь, что он подсказывает спокойно.',
    'Сделай глубокий вдох и выдох. Никто никуда не спешит.'
  ];
  $('btnCheck').onclick = () => {
    modal(`<h2>Перед поездкой</h2>
      ${CHECK.map((c, i) => `<label class="check" id="ck${i}"><input type="checkbox"><span>${esc(c)}</span></label>`).join('')}
      <div class="row"><button class="btn" id="ckRead">🔊 Прочитать вслух</button></div>`);
    CHECK.forEach((_, i) => { const el = $('ck' + i); el.querySelector('input').onchange = (e) => el.classList.toggle('done', e.target.checked); });
    $('ckRead').onclick = () => {
      Voice.unlock();
      if (Voice.ok) speechSynthesis.cancel();
      const wasMuted = settings.muted; settings.muted = false;
      CHECK.forEach((c, i) => Voice.say((i + 1) + '. ' + c, 1));
      settings.muted = wasMuted;
    };
  };

  // ---------- История ----------
  $('btnHistory').onclick = () => {
    const h = store.get('history', []);
    if (!h.length) { modal('<h2>Мои поездки</h2><p>Пока пусто. После каждой поездки здесь появится её разбор, и будет видно, как растёт уверенность.</p>'); return; }
    const km = h.reduce((a, x) => a + x.km, 0), mins = h.reduce((a, x) => a + x.mins, 0);
    const last5 = h.slice(0, 5), prev5 = h.slice(5, 10);
    const rate = (arr) => arr.length ? arr.reduce((a, x) => a + x.speeding + x.brakes, 0) / Math.max(1, arr.reduce((a, x) => a + x.km, 0)) : null;
    const r1 = rate(last5), r2 = rate(prev5);
    let trend = '';
    if (r1 != null && r2 != null) trend = r1 < r2 ? '<p>📉 Ошибок на километр стало меньше, чем раньше. Прогресс налицо!</p>' : '<p>Продолжай практиковаться — уверенность приходит с километрами.</p>';
    modal(`<h2>Мои поездки</h2>
      <div class="stats">
        <div class="stat"><b>${h.length}</b><small>поездок</small></div>
        <div class="stat"><b>${km.toFixed(1).replace('.', ',')} км</b><small>всего</small></div>
        <div class="stat"><b>${Math.floor(mins / 60)} ч ${mins % 60} мин</b><small>за рулём</small></div>
        <div class="stat"><b>${h.filter(x => x.speeding + x.brakes === 0).length}</b><small>идеальных поездок</small></div>
      </div>${trend}
      ${h.slice(0, 30).map(x => `<div class="trip"><b>${new Date(x.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</b> · ${esc(x.to)}<div class="muted">${x.km.toFixed(1).replace('.', ',')} км · ${x.mins} мин · превышений: ${x.speeding} · резких торможений: ${x.brakes}</div></div>`).join('')}`);
  };

  // ---------- Настройки ----------
  $('btnSettings').onclick = () => {
    modal(`<h2>Настройки</h2>
      <label class="field"><span>Имя (инструктор будет обращаться по имени)</span><input type="text" id="sName" value="${esc(settings.name)}" placeholder="Например: Катя"></label>
      <label class="field"><span>Скорость речи</span><select id="sRate"><option value="0.85">Медленнее</option><option value="1">Обычная</option><option value="1.15">Быстрее</option></select></label>
      <label class="field"><span>Предупреждать о превышении</span><select id="sTol"><option value="0">Сразу</option><option value="5">Больше чем на 5 км/ч</option><option value="10">Больше чем на 10 км/ч</option></select></label>
      <label class="toggle"><input type="checkbox" id="sTips"><span>Советы инструктора в пути</span></label>
      <label class="toggle"><input type="checkbox" id="sCalm"><span>Спокойный маршрут по умолчанию</span></label>
      <div class="row"><button class="btn" id="sTest">🔊 Проверить голос</button></div>
      <p class="muted" style="font-size:13px">Если голос звучит с акцентом: Настройки iPhone → Универсальный доступ → Устный контент → Голоса → Русский → скачай «Милена (улучшенный)».</p>`,
    () => {
      settings.name = $('sName').value.trim();
      settings.rate = +$('sRate').value; settings.tolerance = +$('sTol').value;
      settings.tips = $('sTips').checked; settings.calm = $('sCalm').checked;
      saveSettings();
    });
    $('sRate').value = String(settings.rate); $('sTol').value = String(settings.tolerance);
    $('sTips').checked = settings.tips; $('sCalm').checked = settings.calm;
    $('sTest').onclick = () => {
      Voice.unlock(); settings.rate = +$('sRate').value;
      const n = $('sName').value.trim();
      const was = settings.muted; settings.muted = false;
      Voice.say(`${n ? 'Привет, ' + n + '! ' : 'Привет! '}Через 300 метров поворот направо. Посмотри в правое зеркало и включи правый поворотник.`, 3);
      settings.muted = was;
    };
  };

  // ---------- Помощь ----------
  $('btnHelp').onclick = () => modal(`<h2>Как пользоваться</h2>
    <h3>Один раз</h3>
    <ol><li>Открой «Карта города» и скачай Таганрог (нужен интернет).</li>
    <li>В «Настройках» впиши своё имя и проверь голос.</li>
    <li>Если приложение ещё не на экране «Домой»: в Safari нажми «Поделиться» → «На экран „Домой“».</li></ol>
    <h3>Каждая поездка</h3>
    <ol><li>Пройди чек-лист «Перед поездкой».</li>
    <li>Введи адрес или нажми на карту → «Поехали». Или выбери «Просто покататься».</li>
    <li>Закрепи телефон в держателе и не трогай его в пути. Экран должен оставаться включённым — приложение старается не давать ему гаснуть.</li></ol>
    <h3>Попробовать дома</h3>
    <p>Выбери любую точку и нажми «Демо» — приложение «проедет» маршрут само, и ты услышишь все подсказки.</p>
    <h3>Важно</h3>
    <ul><li>Подсказки — помощник, а не замена инструктору. Пока учишься, рядом всегда должен быть опытный водитель.</li>
    <li>Смотри на дорогу и знаки, а не на экран. Если знак говорит одно, а приложение другое — верь знаку.</li>
    <li>Если включить другое приложение или заблокировать экран, iPhone остановит навигацию.</li></ul>`);

  // ---------- Высота панели (для кнопки «Где я») ----------
  function sheetHeight() { requestAnimationFrame(() => document.documentElement.style.setProperty('--sheet-h', $('sheet').offsetHeight + 'px')); }
  window.addEventListener('resize', sheetHeight);

  // ---------- Старт ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  Voice.init();
  showFavs();
  sheetHeight();
  loadData();
  // Показать себя на карте, если разрешение уже дано
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') getPosition().then(f => { if (f) { meMarker.setLatLng([f.lat, f.lon]).addTo(map); if (Core.dist(f.lat, f.lon, TAGANROG_CENTER[0], TAGANROG_CENTER[1]) < 40000) map.setView([f.lat, f.lon], 15); } }); }).catch(() => {});
  }
})();
