/* Автоинструктор — ядро: граф дорог, построение маршрута, голосовые подсказки.
   Работает без интернета и без внешних библиотек. */
(function (root) {
  'use strict';

  // ---------- Геометрия ----------
  const R = 6371000, D2R = Math.PI / 180;
  function dist(a1, o1, a2, o2) {
    const dA = (a2 - a1) * D2R, dO = (o2 - o1) * D2R;
    const s = Math.sin(dA / 2) ** 2 + Math.cos(a1 * D2R) * Math.cos(a2 * D2R) * Math.sin(dO / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a1, o1, a2, o2) {
    const y = Math.sin((o2 - o1) * D2R) * Math.cos(a2 * D2R);
    const x = Math.cos(a1 * D2R) * Math.sin(a2 * D2R) - Math.sin(a1 * D2R) * Math.cos(a2 * D2R) * Math.cos((o2 - o1) * D2R);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  // > 0 — поворот направо, < 0 — налево
  function angDiff(a, b) { let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ---------- Классы дорог ----------
  const HW = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
  const SPEED = [90, 70, 50, 45, 40, 35, 30, 10, 15];        // км/ч для оценки времени
  const CALM = [3, 2.2, 1.7, 1.3, 1.1, 1, 1, 1.3, 1.5];        // штраф «спокойного маршрута»
  function hwCode(h) { const i = HW.indexOf(String(h).replace('_link', '')); return i < 0 ? 5 : i; }
  function parseMaxspeed(s) {
    if (!s) return 0;
    s = String(s).toLowerCase();
    if (s.includes('living')) return 20;
    if (s.includes('urban')) return 60;
    if (s.includes('rural')) return 90;
    if (s.includes('motorway')) return 110;
    const n = parseInt(s, 10);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(250, s.includes('mph') ? Math.round(n * 1.609) : n);
  }
  function limitFor(g, wi) {
    const m = g.wMax[wi];
    if (m) return m;
    const h = g.wHw[wi];
    return (h === 7 || h === 8) ? 20 : 60; // жилая зона / дворы — 20, город — 60
  }

  // ---------- Опасные места ----------
  // 1 светофор, 2 пешеходный переход, 3 «Стоп», 4 «Уступи дорогу», 5 лежачий полицейский, 6 ж/д переезд
  function hazardCode(t) {
    if (t.railway === 'level_crossing') return 6;
    if (t.highway === 'traffic_signals') return 1;
    if (t.highway === 'stop') return 3;
    if (t.highway === 'give_way') return 4;
    if (t.traffic_calming && /^(yes|bump|hump|table|cushion|speed_bump|speed_hump|rumble_strip)$/.test(t.traffic_calming)) return 5;
    if (t.highway === 'crossing') return t.crossing === 'traffic_signals' ? 1 : 2;
    return 0;
  }
  const HZ_TEXT = {
    1: 'Впереди светофор. Смотри на сигнал и будь готова остановиться.',
    2: 'Впереди пешеходный переход. Сбавь скорость и посмотри, нет ли пешеходов.',
    3: 'Впереди знак «Стоп». Нужно полностью остановиться у стоп-линии, потом посмотреть по сторонам.',
    4: 'Впереди знак «Уступи дорогу». Пропусти машины на главной дороге.',
    5: 'Впереди лежачий полицейский. Плавно сбавь скорость заранее.',
    6: 'Впереди железнодорожный переезд. Сбавь скорость, посмотри и послушай, нет ли поезда.'
  };
  const HZ_GAP = { 1: 12000, 2: 25000, 3: 8000, 4: 8000, 5: 15000, 6: 5000 };

  // ---------- Запрос к OpenStreetMap ----------
  function overpassRoadsQuery(b) { // b = [юг, запад, север, восток]
    const bb = b.join(',');
    return `[out:json][timeout:180];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$"]["access"!~"^(private|no)$"]["area"!="yes"](${bb});
  way["highway"="service"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"]["access"!~"^(private|no)$"]["area"!="yes"](${bb});
)->.roads;
.roads out body;
node(w.roads)->.rn;
.rn out skel qt;
node.rn["highway"~"^(traffic_signals|crossing|stop|give_way)$"];
out body qt;
node.rn["traffic_calming"];
out body qt;
node.rn["railway"="level_crossing"];
out body qt;`;
  }
  function overpassAddrQuery(b) {
    const bb = b.join(',');
    return `[out:json][timeout:180];
node["addr:housenumber"]["addr:street"](${bb});
out qt;
way["addr:housenumber"]["addr:street"](${bb});
out tags center qt;`;
  }

  // ---------- Построение графа ----------
  function buildGraph(elements, bbox) {
    const coord = new Map(), tagged = new Map(), ways = [];
    for (const e of elements) {
      if (e.type === 'node') {
        if (e.lat != null) coord.set(e.id, [e.lat, e.lon]);
        if (e.tags) tagged.set(e.id, e.tags);
      } else if (e.type === 'way' && e.nodes && e.tags && e.tags.highway) ways.push(e);
    }
    const idx = new Map(), lat = [], lon = [];
    let n = 0;
    const id2i = (id) => {
      let i = idx.get(id);
      if (i === undefined) {
        const c = coord.get(id);
        if (!c) return -1;
        i = n++; idx.set(id, i); lat.push(c[0]); lon.push(c[1]);
      }
      return i;
    };
    const eFrom = [], eTo = [], eLen = [], eWay = [];
    const wName = [], wHw = [], wMax = [], wRb = [], wStart = [0], wNodes = [];
    const degPairs = [];
    for (const w of ways) {
      const t = w.tags, wi = wName.length;
      wName.push(t.name || t.ref || '');
      wHw.push(hwCode(t.highway));
      wMax.push(parseMaxspeed(t.maxspeed));
      const rb = t.junction === 'roundabout' || t.junction === 'circular';
      wRb.push(rb ? 1 : 0);
      let ow = 0;
      if (t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1') ow = 1;
      else if (t.oneway === '-1' || t.oneway === 'reverse') ow = -1;
      else if (t.oneway !== 'no' && (rb || t.highway === 'motorway' || t.highway === 'motorway_link')) ow = 1;
      let prev = -1;
      for (const nid of w.nodes) {
        const i = id2i(nid);
        if (i < 0) { prev = -1; continue; }
        wNodes.push(i);
        if (prev >= 0 && prev !== i) {
          const L = dist(lat[prev], lon[prev], lat[i], lon[i]);
          degPairs.push(prev, i);
          if (ow >= 0) { eFrom.push(prev); eTo.push(i); eLen.push(L); eWay.push(wi); }
          if (ow <= 0) { eFrom.push(i); eTo.push(prev); eLen.push(L); eWay.push(wi); }
        }
        prev = i;
      }
      wStart.push(wNodes.length);
    }
    const m = eFrom.length;
    const off = new Int32Array(n + 1);
    for (let k = 0; k < m; k++) off[eFrom[k] + 1]++;
    for (let i = 0; i < n; i++) off[i + 1] += off[i];
    const pos = off.slice(0, n);
    const to = new Int32Array(m), len = new Float32Array(m), way = new Int32Array(m);
    for (let k = 0; k < m; k++) { const p = pos[eFrom[k]]++; to[p] = eTo[k]; len[p] = eLen[k]; way[p] = eWay[k]; }
    const deg = new Uint8Array(n);
    for (const i of degPairs) if (deg[i] < 255) deg[i]++;
    const hz = new Uint8Array(n);
    for (const [id, t] of tagged) { const i = idx.get(id); if (i !== undefined) hz[i] = hazardCode(t); }
    return {
      v: 1, n, bbox: bbox || null, created: Date.now(),
      lat: Float64Array.from(lat), lon: Float64Array.from(lon),
      off, to, len, way, deg, hz,
      wName, wHw: Uint8Array.from(wHw), wMax: Uint8Array.from(wMax.map(x => Math.min(255, x))), wRb: Uint8Array.from(wRb),
      wStart: Int32Array.from(wStart), wNodes: Int32Array.from(wNodes)
    };
  }

  // ---------- Адреса и поиск ----------
  const STREET_WORDS = /(^|\s)(улица|ул|проспект|просп|пр-т|переулок|пер|площадь|пл|бульвар|б-р|шоссе|ш|проезд|пр-д|тупик|спуск|набережная|наб|линия|аллея|микрорайон|мкр|станица|ст|город|г|таганрог)(?=\s|$)/g;
  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[.,«»"()]/g, ' ')
      .replace(STREET_WORDS, ' ').replace(/\s+/g, ' ').trim();
  }
  function buildAddresses(elements) {
    const out = [];
    for (const e of elements) {
      const t = e.tags; if (!t) continue;
      const la = e.lat != null ? e.lat : e.center && e.center.lat;
      const lo = e.lon != null ? e.lon : e.center && e.center.lon;
      if (la == null) continue;
      out.push({ s: norm(t['addr:street']), h: String(t['addr:housenumber']).toLowerCase().replace(/\s/g, ''), label: `${t['addr:street']}, ${t['addr:housenumber']}`, lat: la, lon: lo });
    }
    return out;
  }
  function buildStreetIndex(g) {
    const streets = new Map();
    for (let w = 0; w < g.wName.length; w++) {
      const name = g.wName[w]; if (!name) continue;
      const key = norm(name); if (!key) continue;
      const a = g.wStart[w], b = g.wStart[w + 1];
      const L = b - a;
      const cur = streets.get(key);
      if (!cur || L > cur.L) { const mid = g.wNodes[a + (L >> 1)]; streets.set(key, { name, lat: g.lat[mid], lon: g.lon[mid], L }); }
    }
    return streets;
  }
  function search(query, streets, addresses, limit) {
    limit = limit || 8;
    const q = norm(query);
    if (!q) return [];
    const mm = q.match(/^(.*?)\s*(\d+[а-яa-z]?(?:\/\d+[а-яa-z]?)?(?:\s?к\d+)?)$/);
    const res = [];
    if (mm && mm[1] && addresses) {
      const s = mm[1].trim(), h = mm[2].replace(/\s/g, '');
      for (const a of addresses) {
        if (a.s.includes(s) && a.h.startsWith(h)) res.push({ label: a.label, lat: a.lat, lon: a.lon, score: (a.h === h ? 0 : 1) + (a.s === s ? 0 : 0.5) + (a.s.startsWith(s) ? 0 : 0.3) });
      }
      res.sort((x, y) => x.score - y.score || x.label.localeCompare(y.label, 'ru'));
      if (res.length) return res.slice(0, limit);
    }
    const sq = mm && mm[1] ? mm[1].trim() : q;
    for (const [key, v] of streets) if (key.includes(sq)) res.push({ label: v.name, lat: v.lat, lon: v.lon, score: key.startsWith(sq) ? 0 : 1 });
    res.sort((x, y) => x.score - y.score || x.label.localeCompare(y.label, 'ru'));
    return res.slice(0, limit);
  }

  // ---------- Пространственный индекс ----------
  function indexGraph(g) {
    const C = 0.002, cells = new Map();
    for (let i = 0; i < g.n; i++) {
      if (g.deg[i] === 0) continue;
      const k = Math.floor(g.lat[i] / C) + ',' + Math.floor(g.lon[i] / C);
      let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i);
    }
    g._cells = cells; g._C = C;
  }
  function nearestNodes(g, la, lo, maxD, k) {
    if (!g._cells) indexGraph(g);
    const C = g._C, r = Math.ceil(maxD / (C * 111000 * Math.cos(la * D2R))) + 1;
    const ci = Math.floor(la / C), cj = Math.floor(lo / C), res = [];
    for (let a = ci - r; a <= ci + r; a++) for (let b = cj - r; b <= cj + r; b++) {
      const arr = g._cells.get(a + ',' + b); if (!arr) continue;
      for (const i of arr) { const d = dist(la, lo, g.lat[i], g.lon[i]); if (d <= maxD) res.push({ i, d }); }
    }
    res.sort((x, y) => x.d - y.d);
    return res.slice(0, k || 10);
  }
  // Ближайшая дорога с учётом направления движения (для режима без маршрута)
  function currentWay(g, la, lo, heading) {
    const near = nearestNodes(g, la, lo, 40, 4);
    let best = -1, bestScore = Infinity;
    for (const c of near) for (let p = g.off[c.i]; p < g.off[c.i + 1]; p++) {
      const j = g.to[p];
      let score = c.d;
      if (heading != null) {
        const b = bearing(g.lat[c.i], g.lon[c.i], g.lat[j], g.lon[j]);
        const d1 = Math.abs(angDiff(heading, b)), d2 = 180 - d1; // ребро могло прийти «навстречу»
        score += Math.min(d1, d2) * 0.5;
      }
      if (score < bestScore) { bestScore = score; best = g.way[p]; }
    }
    return best;
  }

  // ---------- Поиск пути (A*) ----------
  function Heap() { this.ids = []; this.keys = []; }
  Heap.prototype.push = function (id, key) {
    const I = this.ids, K = this.keys; let i = I.length; I.push(id); K.push(key);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; I[i] = I[p]; K[i] = K[p]; i = p; }
    I[i] = id; K[i] = key;
  };
  Heap.prototype.pop = function () {
    const I = this.ids, K = this.keys, top = I[0], lastI = I.pop(), lastK = K.pop(), n = I.length;
    if (n) {
      let i = 0;
      while (true) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= lastK) break;
        I[i] = I[c]; K[i] = K[c]; i = c;
      }
      I[i] = lastI; K[i] = lastK;
    }
    return top;
  };
  Object.defineProperty(Heap.prototype, 'size', { get() { return this.ids.length; } });

  function astar(g, s, t, calm) {
    const n = g.n, gs = new Float64Array(n).fill(Infinity), prevE = new Int32Array(n).fill(-1), prevN = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
    const vmax = 90 / 3.6, tl = g.lat[t], to = g.lon[t];
    const h = (i) => dist(g.lat[i], g.lon[i], tl, to) / vmax;
    const heap = new Heap();
    gs[s] = 0; heap.push(s, h(s));
    while (heap.size) {
      const u = heap.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === t) break;
      for (let p = g.off[u]; p < g.off[u + 1]; p++) {
        const v = g.to[p]; if (closed[v]) continue;
        const hw = g.wHw[g.way[p]];
        let c = g.len[p] / (SPEED[hw] / 3.6);
        if (calm) c *= CALM[hw];
        const ng = gs[u] + c;
        if (ng < gs[v]) { gs[v] = ng; prevE[v] = p; prevN[v] = u; heap.push(v, ng + h(v)); }
      }
    }
    if (!closed[t]) return null;
    const nodes = [t], edges = [];
    let cur = t;
    while (cur !== s) { edges.push(prevE[cur]); cur = prevN[cur]; nodes.push(cur); }
    nodes.reverse(); edges.reverse();
    return { nodes, edges };
  }

  function findRoute(g, from, to, opts) {
    const S = nearestNodes(g, from[0], from[1], 500, 8).filter(c => g.off[c.i + 1] > g.off[c.i]);
    const T = nearestNodes(g, to[0], to[1], 500, 8);
    if (!S.length) return { error: 'start' };
    if (!T.length) return { error: 'end' };
    for (const s of S.slice(0, 3)) for (const t of T.slice(0, 3)) {
      if (s.i === t.i) return { error: 'same' };
      const p = astar(g, s.i, t.i, opts && opts.calm);
      if (p) return makeRoute(g, p);
    }
    return { error: 'noroute' };
  }

  // ---------- Маршрут и манёвры ----------
  function pointAt(pts, cum, d) {
    if (d <= 0) return pts[0];
    const last = cum.length - 1;
    if (d >= cum[last]) return pts[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const seg = cum[hi] - cum[lo], f = seg ? (d - cum[lo]) / seg : 0;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
  }

  function classify(turn) {
    const a = Math.abs(turn);
    if (a < 30) return null;
    const dir = turn > 0 ? 'right' : 'left';
    if (a >= 150) return { type: 'uturn', dir: 'left' };
    if (a >= 55) return { type: 'turn', dir };
    return { type: 'slight', dir };
  }

  function makeRoute(g, path) {
    const { nodes, edges } = path;
    const pts = nodes.map(i => [g.lat[i], g.lon[i]]);
    const cum = new Float64Array(pts.length);
    for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + g.len[edges[k - 1]];
    const length = cum[cum.length - 1];
    let time = 0;
    for (const e of edges) time += g.len[e] / (SPEED[g.wHw[g.way[e]]] / 3.6);

    const raw = [];
    const N = nodes.length;
    for (let k = 1; k < N - 1; k++) {
      const v = nodes[k], wIn = g.way[edges[k - 1]], wOut = g.way[edges[k]];
      if (!g.wRb[wIn] && g.wRb[wOut]) { // въезд на кольцо
        let exits = 0, j = k + 1;
        for (; j < N - 1; j++) {
          const vj = nodes[j];
          for (let p = g.off[vj]; p < g.off[vj + 1]; p++) if (!g.wRb[g.way[p]]) { exits++; break; }
          if (!g.wRb[g.way[edges[j]]]) break;
        }
        const wAfter = g.way[edges[Math.min(j, N - 2)]];
        raw.push({ type: 'roundabout', dir: 'right', exit: Math.max(1, exits), cum: cum[k], name: g.wName[wAfter], k, k2: j });
        k = j;
        continue;
      }
      if (g.wRb[wIn]) continue;
      if (g.deg[v] <= 2) continue;
      const a = pointAt(pts, cum, cum[k] - 20), b = pointAt(pts, cum, cum[k] + 20);
      const turn = angDiff(bearing(a[0], a[1], pts[k][0], pts[k][1]), bearing(pts[k][0], pts[k][1], b[0], b[1]));
      const c = classify(turn);
      if (!c) continue;
      raw.push(Object.assign(c, { cum: cum[k], name: g.wName[wOut], k, k2: k, angle: turn }));
    }
    // Склеиваем близкие манёвры (перекрёстки с разделительной полосой и т.п.)
    const man = [];
    for (const m of raw) {
      const prev = man[man.length - 1];
      if (prev && m.type !== 'roundabout' && prev.type !== 'roundabout' && m.cum - prev.cum < 35) {
        const a = pointAt(pts, cum, prev.cum - 20), b = pointAt(pts, cum, m.cum + 20);
        const pk = pts[prev.k], mk = pts[m.k];
        const turn = angDiff(bearing(a[0], a[1], pk[0], pk[1]), bearing(mk[0], mk[1], b[0], b[1]));
        const c = classify(turn);
        if (!c) { man.pop(); continue; }
        Object.assign(prev, c, { name: m.name, k2: m.k, angle: turn });
        continue;
      }
      man.push(m);
    }
    man.push({ type: 'arrive', cum: length, name: '' });

    const hazards = [];
    for (let k = 1; k < N; k++) {
      const c = g.hz[nodes[k]];
      if (!c) continue;
      const last = hazards[hazards.length - 1];
      if (last && last.type === c && cum[k] - last.cum < 40) continue;
      hazards.push({ type: c, cum: cum[k] });
    }
    return { pts, cum, nodes, edges, maneuvers: man, hazards, length, time: time + man.length * 6 };
  }

  // ---------- Слова ----------
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  function distWords(m) {
    if (m >= 950) {
      const km = Math.round(m / 100) / 10;
      if (Number.isInteger(km)) return km + ' ' + plural(km, 'километр', 'километра', 'километров');
      return String(km).replace('.', ',') + ' километра';
    }
    const r = m >= 200 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
    return r + ' ' + plural(r, 'метр', 'метра', 'метров');
  }
  function minutesWords(sec) {
    const mn = Math.max(1, Math.round(sec / 60));
    if (mn < 60) return mn + ' ' + plural(mn, 'минуту', 'минуты', 'минут');
    const h = Math.floor(mn / 60), r = mn % 60;
    return h + ' ' + plural(h, 'час', 'часа', 'часов') + (r ? ' ' + r + ' ' + plural(r, 'минуту', 'минуты', 'минут') : '');
  }
  const ORD = ['', 'первый', 'второй', 'третий', 'четвёртый', 'пятый', 'шестой', 'седьмой', 'восьмой', 'девятый'];
  const ordWord = (n) => ORD[n] || (n + '-й');
  const DIR = { right: 'направо', left: 'налево' };
  const SIDE = { right: 'правее', left: 'левее' };

  function shortText(m) {
    switch (m.type) {
      case 'turn': return 'поворот ' + DIR[m.dir];
      case 'slight': return 'держись ' + SIDE[m.dir];
      case 'uturn': return 'разворот';
      case 'roundabout': return 'круговое движение, ' + ordWord(m.exit) + ' съезд';
      case 'arrive': return 'конец маршрута';
    }
    return '';
  }
  function maneuverText(m, stage, d) {
    const nm = m.name && m.type !== 'arrive' ? ` — ${m.name}` : '';
    if (stage === 'far') return `Через ${distWords(d)} ${shortText(m)}${nm}.`;
    if (stage === 'prep') {
      const head = `Через ${distWords(d)} ${shortText(m)}. `;
      switch (m.type) {
        case 'turn': return head + (m.dir === 'right'
          ? 'Посмотри в правое зеркало, включи правый поворотник и прижмись к правому краю.'
          : 'Посмотри в левое зеркало, включи левый поворотник и займи крайний левый ряд. При повороте пропусти встречные машины.');
        case 'slight': return head + `Сначала зеркало, потом поворотник, и плавно перестраивайся ${SIDE[m.dir]}.`;
        case 'uturn': return head + 'Включи левый поворотник и займи крайний левый ряд. Разворачивайся только там, где это разрешено, и пропусти встречных.';
        case 'roundabout': return `Через ${distWords(d)} кольцо. Сбавь скорость и смотри на знаки приоритета — обычно уступаем тем, кто уже едет по кольцу. Нам нужен ${ordWord(m.exit)} съезд.`;
        case 'arrive': return `Через ${distWords(d)} мы на месте. Присматривай, где можно безопасно остановиться.`;
      }
    }
    if (stage === 'now') {
      switch (m.type) {
        case 'turn': return `Поворачивай ${DIR[m.dir]}. Спокойно, без спешки.`;
        case 'slight': return `Держись ${SIDE[m.dir]}.`;
        case 'uturn': return 'Разворачивайся. Не торопись, сначала убедись, что никому не мешаешь.';
        case 'roundabout': return `Заезжаем на кольцо. ${ordWord(m.exit)[0].toUpperCase() + ordWord(m.exit).slice(1)} съезд. Перед съездом включи правый поворотник.`;
      }
    }
    return '';
  }
  function startPhrase(route, name) {
    const hi = name ? `${name}, поехали!` : 'Поехали!';
    return `${hi} Маршрут ${distWords(route.length)}, примерно ${minutesWords(route.time)}. Не спеши — я подскажу всё заранее.`;
  }

  const TIPS = [
    'Держи дистанцию: до машины впереди — не меньше двух секунд.',
    'Посматривай в зеркала каждые несколько секунд.',
    'Держи руль двумя руками, плечи расслабь.',
    'Смотри дальше вперёд, а не прямо перед капотом — так проще держать полосу.',
    'Если сзади сигналят — это не повод спешить. Едем так, как безопасно тебе.',
    'Дыши спокойно. У тебя хорошо получается.',
    'Перед перестроением: зеркало, поворотник, ещё раз зеркало — и только потом руль.',
    'Если что-то непонятно — можно спокойно снизить скорость. Это нормально.'
  ];
  const PRAISE = ['Отлично!', 'Хорошо получилось.', 'Молодец!', 'Так держать.'];

  // ---------- Сессия поездки ----------
  function createSession(g, route, opts) {
    opts = Object.assign({ name: '', tolerance: 5, tips: true }, opts || {});
    const S = {
      route: null, seg: 0, along: 0, mi: 0, spoken: [], hzDone: new Set(), joined: false, offCount: 0, done: false,
      last: null, lastSpeak: -1e12, lastTip: -1e12, lastSpeedWarn: -1e12, lastBrakeWarn: -1e12, lastBrakeT: -1e12, hzLast: {},
      overSince: 0, isOver: false, overCounted: false, limit: 60, street: '', tipI: 0, praiseI: 0, passed: 0,
      stats: { start: null, end: null, dist: 0, maxKmh: 0, speeding: 0, hardBrakes: 0, offRoute: 0 }
    };
    function setRoute(r) {
      S.route = r; S.seg = 0; S.along = 0; S.mi = 0; S.joined = false; S.offCount = 0;
      S.spoken = r ? r.maneuvers.map(() => ({})) : []; S.hzDone = new Set();
    }
    setRoute(route);

    function project(la, lo, a, b) {
      const p = S.route.pts, kx = Math.cos(la * D2R) * 111320, ky = 110540;
      const ax = (p[a][1] - lo) * kx, ay = (p[a][0] - la) * ky, bx = (p[b][1] - lo) * kx, by = (p[b][0] - la) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? -(ax * dx + ay * dy) / L2 : 0;
      t = clamp(t, 0, 1);
      return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
    }
    function snap(la, lo) {
      const p = S.route.pts;
      let best = { d: Infinity, seg: S.seg, t: 0 };
      const lo2 = Math.max(0, S.seg - 2), hi = Math.min(p.length - 2, S.seg + 80);
      for (let s = lo2; s <= hi; s++) { const r = project(la, lo, s, s + 1); if (r.d < best.d) best = { d: r.d, seg: s, t: r.t }; }
      if (best.d > 50) for (let s = 0; s < p.length - 1; s++) { const r = project(la, lo, s, s + 1); if (r.d < best.d) best = { d: r.d, seg: s, t: r.t }; }
      return best;
    }

    function state(kmh) {
      const r = S.route, st = { kmh: kmh || 0, limit: S.limit, street: S.street, done: S.done, stats: S.stats };
      if (r) {
        const m = r.maneuvers[S.mi];
        st.remaining = Math.max(0, r.length - S.along);
        st.remainingTime = r.length ? r.time * st.remaining / r.length : 0;
        st.next = { type: m.type, dir: m.dir, exit: m.exit, name: m.name, dist: Math.max(0, m.cum - S.along) };
        st.along = S.along;
      }
      return st;
    }

    function update(fix) {
      const ev = [], t = fix.t;
      const say = (text, prio) => { ev.push({ text, prio: prio == null ? 1 : prio }); S.lastSpeak = t; };
      if (S.done) return { events: ev, state: state(0) };
      if (!S.stats.start) { S.stats.start = t; S.lastTip = t; }

      // Скорость и резкие торможения
      let v = fix.speed;
      if (S.last) {
        const dt = (t - S.last.t) / 1000, dd = dist(S.last.lat, S.last.lon, fix.lat, fix.lon);
        if ((v == null || v < 0) && dt > 0) v = dd / dt;
        if (dt > 0 && dt < 15 && (fix.acc == null || fix.acc < 50)) S.stats.dist += dd;
        if (dt >= 0.5 && dt <= 3 && S.last.v > 4 && v != null && v >= 0) {
          const dec = (S.last.v - v) / dt;
          if (dec > 3.5 && t - S.lastBrakeT > 5000) {
            S.lastBrakeT = t; S.stats.hardBrakes++;
            if (t - S.lastBrakeWarn > 45000) { S.lastBrakeWarn = t; say('Резковато затормозили. Старайся заранее отпускать газ и тормозить плавно.', 1); }
          }
        }
      }
      if (v == null || v < 0) v = 0;
      const kmh = v * 3.6;
      if (kmh > S.stats.maxKmh && (fix.acc == null || fix.acc < 30) && kmh < 250) S.stats.maxKmh = kmh;
      const heading = fix.heading != null && fix.heading >= 0 ? fix.heading
        : (S.last && dist(S.last.lat, S.last.lon, fix.lat, fix.lon) > 3 ? bearing(S.last.lat, S.last.lon, fix.lat, fix.lon) : null);
      S.last = { lat: fix.lat, lon: fix.lon, t, v };

      let wayNow = -1;
      const r = S.route;
      if (r) {
        const sn = snap(fix.lat, fix.lon);
        const accOk = fix.acc == null || fix.acc < 35;
        if (sn.d < 25) { S.joined = true; S.offCount = 0; }
        else if (sn.d > 45 && accOk && S.joined && v > 1.5) S.offCount++;
        if (S.offCount >= 3) {
          S.offCount = 0; S.stats.offRoute++;
          say('Ничего страшного, мы немного свернули. Строю новый маршрут.', 3);
          ev.push({ reroute: true });
          return { events: ev, state: state(kmh) };
        }
        if (sn.d <= 45) {
          S.seg = sn.seg;
          const a = r.cum[sn.seg] + sn.t * (r.cum[sn.seg + 1] - r.cum[sn.seg]);
          if (a > S.along - 30) S.along = a; // защита от прыжков GPS назад
          wayNow = g.way[r.edges[Math.min(S.seg, r.edges.length - 1)]];
        }
        // Прибытие
        if (r.length - S.along < 25 && (S.joined || r.length < 40)) {
          S.done = true; S.stats.end = t;
          say(`Мы на месте${opts.name ? ', ' + opts.name : ''}! Остановись там, где это безопасно и разрешено. Ты молодец.`, 3);
          ev.push({ arrived: true });
          return { events: ev, state: state(kmh) };
        }
        // Пройденные манёвры
        while (S.mi < r.maneuvers.length - 1 && r.maneuvers[S.mi].cum < S.along - 15) {
          const wasSpoken = S.spoken[S.mi].now;
          S.mi++;
          if (wasSpoken) {
            S.passed++;
            const nx = r.maneuvers[S.mi], dn = nx.cum - S.along;
            const praise = (S.passed % 3 === 1) ? PRAISE[S.praiseI++ % PRAISE.length] + ' ' : '';
            if (dn > 1200) say(`${praise}Теперь прямо ${distWords(dn)}.`, 1);
            else if (praise) say(praise.trim(), 0);
          }
        }
        // Подсказки о манёвре
        const m = r.maneuvers[S.mi], sp = S.spoken[S.mi], d = m.cum - S.along;
        const vv = Math.max(v, 8);
        const farD = clamp(vv * 25, 300, 800), prepD = clamp(vv * 11, 120, 250), nowD = clamp(vv * 4, 25, 60);
        if (m.type === 'arrive') {
          if (!sp.prep && d <= 250 && d > 60) { sp.prep = 1; say(maneuverText(m, 'prep', d), 2); }
        } else {
          if (!sp.far && d <= farD && d > prepD + 60) { sp.far = 1; say(maneuverText(m, 'far', d), 2); }
          if (!sp.prep && d <= prepD && d > nowD + 15) { sp.prep = sp.far = 1; say(maneuverText(m, 'prep', d), 2); }
          if (!sp.now && d <= nowD) { sp.now = sp.prep = sp.far = 1; say(maneuverText(m, 'now', d), 3); }
        }
        // Опасные места впереди
        for (const h of r.hazards) {
          if (S.hzDone.has(h)) continue;
          const dh = h.cum - S.along;
          if (dh > 170) break;
          S.hzDone.add(h);
          if (dh < 35) continue;
          if (m.type !== 'arrive' && Math.abs(h.cum - m.cum) < 50) continue; // рядом с манёвром — не перегружаем
          if (h.type === 2 && kmh < 20) continue;
          const lastT = S.hzLast[h.type] || -1e12;
          if (t - lastT < HZ_GAP[h.type]) continue;
          if (t - S.lastSpeak < 2500) continue;
          S.hzLast[h.type] = t;
          say(HZ_TEXT[h.type], 1);
        }
      } else {
        wayNow = currentWay(g, fix.lat, fix.lon, heading);
      }

      // Ограничение скорости
      if (wayNow >= 0) { S.limit = limitFor(g, wayNow); S.street = g.wName[wayNow] || ''; }
      if (kmh > S.limit + opts.tolerance && (fix.acc == null || fix.acc < 30)) {
        if (!S.isOver) { S.isOver = true; S.overSince = t; }
        if (t - S.overSince >= 3000) {
          if (!S.overCounted) { S.overCounted = true; S.stats.speeding++; }
          if (t - S.lastSpeedWarn > 25000) { S.lastSpeedWarn = t; say(`Скорость ${Math.round(kmh)}. Здесь можно ${S.limit}. Плавно отпусти газ.`, 2); }
        }
      } else if (kmh < S.limit + opts.tolerance - 3) { S.isOver = false; S.overCounted = false; }

      // Советы инструктора на спокойных участках
      if (opts.tips && kmh > 15 && t - S.lastSpeak > 60000 && t - S.lastTip > 150000) {
        const okRoute = !r || (r.maneuvers[S.mi].cum - S.along > 600);
        if (okRoute) { S.lastTip = t; say(TIPS[S.tipI++ % TIPS.length], 0); }
      }
      return { events: ev, state: state(kmh) };
    }

    function finish(t) { if (!S.stats.end) S.stats.end = t; S.done = true; return S.stats; }
    return { update, setRoute, finish, get stats() { return S.stats; }, get route() { return S.route; } };
  }

  const Core = {
    dist, bearing, angDiff, buildGraph, buildAddresses, buildStreetIndex, search, indexGraph, nearestNodes,
    findRoute, makeRoute, pointAt, createSession, startPhrase, maneuverText, distWords, minutesWords, plural,
    overpassRoadsQuery, overpassAddrQuery, limitFor, norm, HZ_TEXT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof self !== 'undefined' ? self : this);
