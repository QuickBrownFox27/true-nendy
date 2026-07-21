/* True NENDY: parkrun road-distance planner (unofficial) */
"use strict";

const OSRM = "https://router.project-osrm.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const STORE_HOME = "nendy.home";
const STORE_DONE = "nendy.done";
const STORE_ID = "nendy.pkid";
const STORE_INTRO = "nendy.introHidden";

// Ferry terminals where every road route to the mainland funnels through.
// Routing engines (OSRM included) treat these vehicle ferries as roads, but
// our crow-flies pre-filter can't "see" across water, so for island homes
// the true road-nearest events (clustered around the mainland terminal) never
// make the shortlist. For applicable homes we seed the shortlist with the
// events nearest the terminal so OSRM gets asked about them.
const SEED_PER_GATEWAY = 10;
const FERRY_GATEWAYS = [
  {
    // Spirit of Tasmania: Tasmanian homes reach the mainland via the
    // Geelong (Corio Quay) terminal.
    label: "Geelong (Spirit of Tasmania)",
    lat: -38.0920, lng: 144.3960,
    // Tasmania + Bass Strait islands bounding box (excludes mainland Victoria)
    appliesTo: h => h.lat >= -43.8 && h.lat <= -39.2 && h.lng >= 143.7 && h.lng <= 148.6,
  },
];

// ---------- state ----------
let home = loadJSON(STORE_HOME, null);           // {lat, lng, label}
let done = new Set(loadJSON(STORE_DONE, []));    // eventname slugs
let pickMode = false;
let results = [];                                 // last computed ranking
let candidateCache = null;                        // candidates with road metrics, for instant re-ranking
let routeLayer = null;
let selectedRow = null;

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function saveState() {
  localStorage.setItem(STORE_HOME, JSON.stringify(home));
  localStorage.setItem(STORE_DONE, JSON.stringify([...done]));
}

// ---------- map ----------
const map = L.map("map").setView([-27.5, 134], 5); // Australia
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const eventLayer = L.layerGroup().addTo(map);
const rankLayer = L.layerGroup().addTo(map);
let homeMarker = null;

const eventMarkers = {}; // eventname -> circleMarker
function drawEventMarkers() {
  eventLayer.clearLayers();
  for (const ev of PARKRUN_EVENTS) {
    const isDone = done.has(ev.n);
    const m = L.circleMarker([ev.lat, ev.lng], {
      radius: 5,
      weight: 1.5,
      color: "#fff",
      fillColor: isDone ? "#00a888" : (ev.s === 2 ? "#c77dff" : "#3d2b56"),
      fillOpacity: 0.9
    });
    m.bindPopup(popupHtml(ev));
    eventMarkers[ev.n] = m;
    eventLayer.addLayer(m);
  }
}
function popupHtml(ev) {
  const isDone = done.has(ev.n);
  return `<strong>${ev.name}</strong><br><span style="color:#777">${ev.loc || ""}${ev.s === 2 ? " · junior" : ""}</span><br>
    <button onclick="toggleDone('${ev.n}')" style="margin-top:6px">${isDone ? "Unmark ✗" : "Mark as done ✓"}</button>`;
}

function setHome(lat, lng, label) {
  home = { lat, lng, label };
  saveState();
  if (homeMarker) map.removeLayer(homeMarker);
  homeMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: "", html: '<div class="home-badge">🏠</div>', iconSize: [26, 26], iconAnchor: [13, 24] })
  }).addTo(map).bindPopup("Home base");
  document.getElementById("homeLabel").textContent = "🏠 " + label;
  document.getElementById("clearHomeBtn").hidden = false;
  map.setView([lat, lng], Math.max(map.getZoom(), 10));
}

function clearHome() {
  home = null;
  saveState();
  if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
  document.getElementById("homeLabel").textContent = "";
  document.getElementById("clearHomeBtn").hidden = true;
  document.getElementById("addr").value = "";
}
document.getElementById("clearHomeBtn").onclick = clearHome;

map.on("click", e => {
  if (!pickMode) return;
  pickMode = false;
  document.getElementById("pickBtn").classList.remove("active");
  setHome(e.latlng.lat, e.latlng.lng, `Map pin (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`);
});

// ---------- done-list UI ----------
window.toggleDone = function (slug) {
  if (done.has(slug)) done.delete(slug); else done.add(slug);
  saveState();
  renderDone();
  drawEventMarkers();
};

function renderDone() {
  document.getElementById("doneCount").textContent = done.size;
  document.getElementById("clearDoneBtn").hidden = done.size === 0;
  const list = document.getElementById("doneList");
  const byName = Object.fromEntries(PARKRUN_EVENTS.map(e => [e.n, e]));
  list.innerHTML = "";
  [...done].sort().forEach(slug => {
    const ev = byName[slug];
    if (!ev) return;
    const chip = document.createElement("span");
    chip.className = "done-chip";
    chip.textContent = ev.name.replace(" parkrun", "");
    chip.title = "Click to remove";
    chip.onclick = () => toggleDone(slug);
    list.appendChild(chip);
  });
}

document.getElementById("clearDoneBtn").onclick = () => {
  if (!done.size) return;
  if (!confirm(`Clear all ${done.size} done events?`)) return;
  done.clear();
  saveState();
  renderDone();
  drawEventMarkers();
  document.getElementById("doneSearch").value = "";
  document.getElementById("doneSuggest").innerHTML = "";
};

const doneSearch = document.getElementById("doneSearch");
const suggestBox = document.getElementById("doneSuggest");
doneSearch.addEventListener("input", () => {
  const q = doneSearch.value.trim().toLowerCase();
  suggestBox.innerHTML = "";
  if (q.length < 2) return;
  const hits = PARKRUN_EVENTS
    .filter(e => e.name.toLowerCase().includes(q) || (e.loc || "").toLowerCase().includes(q))
    .slice(0, 12);
  if (!hits.length) return;
  const box = document.createElement("div");
  box.className = "items";
  hits.forEach(e => {
    const d = document.createElement("div");
    d.innerHTML = `${e.name} ${done.has(e.n) ? '<span class="done-flag">✓ done</span>' : ""}<br><span style="color:#999;font-size:11px">${e.loc || ""}</span>`;
    d.onclick = () => { toggleDone(e.n); doneSearch.value = ""; suggestBox.innerHTML = ""; };
    box.appendChild(d);
  });
  suggestBox.appendChild(box);
});
document.addEventListener("click", e => {
  if (!suggestBox.contains(e.target) && e.target !== doneSearch) suggestBox.innerHTML = "";
});

// ---------- bulk import from parkrun results page ----------
const pkIdInput = document.getElementById("pkId");
const resultsLink = document.getElementById("resultsLink");

function updateResultsLink() {
  const id = pkIdInput.value.replace(/\D/g, "");
  if (id) {
    resultsLink.href = `https://www.parkrun.com.au/parkrunner/${id}/all/`;
    resultsLink.hidden = false;
    localStorage.setItem(STORE_ID, id);
  } else {
    resultsLink.hidden = true;
  }
}
pkIdInput.addEventListener("input", updateResultsLink);
pkIdInput.value = localStorage.getItem(STORE_ID) || "";
updateResultsLink();

// Normalise a name for matching: lowercase, strip diacritics, collapse whitespace
function normName(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();
}

// Lookup table: short name / long name / long name minus "parkrun" -> slug
const NAME_LOOKUP = (() => {
  const m = {};
  for (const ev of PARKRUN_EVENTS) {
    if (ev.sn) m[normName(ev.sn)] = ev.n;
    m[normName(ev.name)] = ev.n;
    m[normName(ev.name.replace(/ parkrun/i, ""))] ??= ev.n;
  }
  return m;
})();

// Parse pasted results-page text. Event names sit in the first tab-separated
// cell of each result row (e.g. "Woden Town\t27/06/2026\t37\t46\t20:38\t…").
function parseResultsPaste(text) {
  const matched = new Set();
  const unmatched = new Set();
  const datePat = /\d{1,2}\/\d{1,2}\/\d{4}/;
  for (const rawLine of text.split(/\r?\n/)) {
    const cells = rawLine.split("\t").map(c => c.trim());
    const name = normName(cells[0] || "");
    if (!name) continue;
    const slug = NAME_LOOKUP[name];
    if (slug) matched.add(slug);
    else if (cells.length >= 3 && datePat.test(cells[1] || "")) unmatched.add(cells[0]);
  }
  return { matched, unmatched };
}

document.getElementById("importBtn").onclick = async () => {
  const text = document.getElementById("pasteBox").value;
  const st = document.getElementById("importStatus");
  if (!text.trim()) { st.textContent = "Paste your results page text above first."; return; }
  const { matched, unmatched } = parseResultsPaste(text);
  if (!matched.size) {
    st.textContent = "No Australian parkrun events recognised in that text. Make sure you copied the whole results page (Ctrl+A, Ctrl+C).";
    return;
  }
  const before = done.size;
  matched.forEach(s => done.add(s));
  saveState();
  renderDone();
  drawEventMarkers();
  let msg = `✓ ${matched.size} Australian events recognised, ${done.size - before} newly added.`;
  if (unmatched.size) {
    msg += ` Not in the AU events list (overseas or closed): ${[...unmatched].slice(0, 5).join(", ")}${unmatched.size > 5 ? "…" : ""}.`;
  }
  st.textContent = msg;
  document.getElementById("pasteBox").value = "";
  if (home) await computeNendy();
  else setStatus("Now set your home base (step 1) to see your top 10 true NENDY.");
};

// ---------- home controls ----------
document.getElementById("geocodeBtn").onclick = geocode;
document.getElementById("addr").addEventListener("keydown", e => { if (e.key === "Enter") geocode(); });

async function geocode() {
  const q = document.getElementById("addr").value.trim();
  if (!q) return;
  setStatus("Searching address…");
  try {
    const url = `${NOMINATIM}?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { "Accept-Language": "en" } });
    const j = await r.json();
    if (!j.length) { setStatus("No match found. Try adding the state, e.g. “Ballarat VIC”."); return; }
    setHome(+j[0].lat, +j[0].lon, j[0].display_name.split(",").slice(0, 3).join(","));
    setStatus("");
  } catch (err) {
    setStatus("Address search failed: " + err.message);
  }
}

document.getElementById("gpsBtn").onclick = () => {
  if (!navigator.geolocation) { setStatus("Geolocation not available in this browser."); return; }
  setStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    p => { setHome(p.coords.latitude, p.coords.longitude, "My location"); setStatus(""); },
    err => setStatus("Could not get location: " + err.message)
  );
};

document.getElementById("pickBtn").onclick = function () {
  pickMode = !pickMode;
  this.classList.toggle("active", pickMode);
  setStatus(pickMode ? "Now click anywhere on the map to set home." : "");
};

function setStatus(msg) { document.getElementById("status").textContent = msg; }

// ---------- NENDY computation ----------
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

document.getElementById("computeBtn").onclick = computeNendy;

async function computeNendy() {
  if (!home) { setStatus("Set your home base first (step 1)."); return; }
  const btn = document.getElementById("computeBtn");
  btn.disabled = true;
  setStatus("Fetching road distances from OSRM…");
  clearRoute();
  rankLayer.clearLayers();

  try {
    const inclJuniors = document.getElementById("inclJuniors").checked;
    const N = +document.getElementById("candN").value;

    // Shortlist nearest undone events by crow-flies from home
    const eligible = PARKRUN_EVENTS
      .filter(e => !done.has(e.n) && (inclJuniors || e.s === 1))
      .map(e => ({ ...e, crow: haversine(home.lat, home.lng, e.lat, e.lng) }));
    const candidates = [...eligible].sort((a, b) => a.crow - b.crow).slice(0, N);

    // Ferry-gateway seeding (see FERRY_GATEWAYS): add the events nearest each
    // applicable mainland terminal so an island home's true road-nearest
    // cluster gets checked by OSRM, deduped against the crow-flies shortlist.
    const picked = new Set(candidates.map(c => c.n));
    for (const g of FERRY_GATEWAYS) {
      if (!g.appliesTo(home)) continue;
      [...eligible]
        .sort((a, b) => haversine(g.lat, g.lng, a.lat, a.lng) - haversine(g.lat, g.lng, b.lat, b.lng))
        .slice(0, SEED_PER_GATEWAY)
        .forEach(e => { if (!picked.has(e.n)) { picked.add(e.n); candidates.push(e); } });
    }

    // OSRM demo server caps a table request at 100 coordinates (home + 99 events)
    if (candidates.length > 99) candidates.length = 99;

    // Crow-flies rank across the final candidate set, measured from home
    [...candidates].sort((a, b) => a.crow - b.crow).forEach((c, i) => c.crowRank = i + 1);

    // One OSRM table call: home + all candidates
    const coords = [`${home.lng},${home.lat}`, ...candidates.map(c => `${c.lng},${c.lat}`)].join(";");
    const url = `${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.code !== "Ok") throw new Error("OSRM: " + (j.message || j.code));

    candidates.forEach((c, i) => {
      c.noRoad = j.distances[0][i + 1] == null || j.durations[0][i + 1] == null;
      c.roadKm = c.noRoad ? Infinity : j.distances[0][i + 1] / 1000;
      c.driveMin = c.noRoad ? Infinity : j.durations[0][i + 1] / 60;
    });

    candidateCache = candidates;
    rankAndRender();
    setStatus("");
  } catch (err) {
    setStatus("Failed: " + err.message + ". The free OSRM server may be busy; try again in a minute.");
  } finally {
    btn.disabled = false;
  }
}

// Re-sort cached candidates by the chosen metric and redraw, no new OSRM call
function rankAndRender() {
  if (!candidateCache) return;
  clearRoute();
  const rankBy = document.getElementById("rankBy").value;
  // (x - y) is NaN for two unreachable events (Infinity - Infinity): fall back to crow order
  results = [...candidateCache].sort((a, b) =>
    (rankBy === "duration" ? a.driveMin - b.driveMin :
     rankBy === "crow" ? a.crow - b.crow : a.roadKm - b.roadKm) || (a.crow - b.crow));
  results.forEach((c, i) => c.roadRank = i + 1);
  renderResults(rankBy);
}

document.getElementById("rankBy").addEventListener("change", rankAndRender);
document.getElementById("sortRoad").onclick = () => {
  document.getElementById("rankBy").value = "distance";
  rankAndRender();
};
document.getElementById("sortDrive").onclick = () => {
  document.getElementById("rankBy").value = "duration";
  rankAndRender();
};
document.getElementById("sortCrow").onclick = () => {
  document.getElementById("rankBy").value = "crow";
  rankAndRender();
};

function fmtDur(min) {
  if (!isFinite(min)) return "n/a";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${m.toString().padStart(2, "0")} min` : `${m} min`;
}
function fmtKm(km) { return isFinite(km) ? km.toFixed(1) + " km" : "n/a"; }

function renderResults(rankBy) {
  const panel = document.getElementById("results");
  panel.hidden = false;
  document.getElementById("sortRoad").classList.toggle("active", rankBy === "distance");
  document.getElementById("sortDrive").classList.toggle("active", rankBy === "duration");
  document.getElementById("sortCrow").classList.toggle("active", rankBy === "crow");

  // Hero card: the true (or official) NENDY
  const top = results[0];
  const crowTop = results.find(c => c.crowRank === 1);
  const hero = document.getElementById("nendyHero");
  const rankLabel = { duration: "by drive time", distance: "by road distance", crow: "as the crow flies" }[rankBy];
  let upset = "";
  if (rankBy === "crow") {
    const roadTop = [...results].sort((a, b) => a.roadKm - b.roadKm)[0];
    if (roadTop !== top) {
      upset = `<div class="upset">🚗 The crow is lying to you: by road your <em>true</em> NENDY is <strong>${roadTop.name}</strong> (${fmtKm(roadTop.roadKm)}, ${fmtDur(roadTop.driveMin)}).</div>`;
    }
  } else if (top.crowRank !== 1) {
    upset = `<div class="upset">⚠️ Crow-flies NENDY is <strong>${crowTop.name}</strong> (${fmtKm(crowTop.crow)} direct, but ${fmtKm(crowTop.roadKm)} / ${fmtDur(crowTop.driveMin)} by road). Your <em>true</em> NENDY is different!</div>`;
  }
  hero.innerHTML = `
    <div class="tag">Your ${rankBy === "crow" ? "official" : "true"} NENDY · ${rankLabel}</div>
    <div class="name">${top.name}</div>
    <div class="stats">${top.noRoad ? "✈️ no road route, fly!" : `🚗 ${fmtKm(top.roadKm)} · ⏱ ${fmtDur(top.driveMin)}`} · 🐦 ${fmtKm(top.crow)} direct (crow rank #${top.crowRank})</div>
    ${upset}`;

  // Table
  const tbody = document.querySelector("#resultTable tbody");
  tbody.innerHTML = "";
  selectedRow = null;
  results.forEach(c => {
    const tr = document.createElement("tr");
    const d = c.crowRank - c.roadRank;
    const delta = d > 0 ? `<span class="delta-up">▲${d}</span>` :
                  d < 0 ? `<span class="delta-down">▼${-d}</span>` :
                          `<span class="delta-same">·</span>`;
    tr.innerHTML = `
      <td>${c.roadRank}</td>
      <td><div class="evt-name">${c.name.replace(" parkrun", "")}${c.s === 2 ? " (jr)" : ""}</div><div class="evt-loc">${c.loc || ""}</div></td>
      <td class="num">${c.noRoad ? "✈️ fly" : fmtKm(c.roadKm)}</td>
      <td class="num">${c.noRoad ? "n/a" : fmtDur(c.driveMin)}</td>
      <td class="num">${fmtKm(c.crow)}</td>
      <td>${delta}</td>`;
    c._tr = tr;                       // remember the row so map clicks can highlight it
    tr.onclick = () => selectEvent(c);
    tbody.appendChild(tr);
  });
  document.getElementById("resultFoot").textContent =
    `All ${results.length} nearby candidates checked by road (top 10 numbered on the map). Click any row or numbered map pin to draw that event's driving route. Δ shows movement versus the official crow-flies ranking.`;

  // Numbered map badges for top 10
  rankLayer.clearLayers();
  results.slice(0, 10).forEach(c => {
    L.marker([c.lat, c.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="rank-badge${c.roadRank === 1 ? " top" : ""}">${c.roadRank}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12]
      }),
      zIndexOffset: 1000 - c.roadRank
    }).addTo(rankLayer).on("click", () => selectEvent(c));
  });

  const b = L.latLngBounds(results.slice(0, 10).map(c => [c.lat, c.lng]));
  b.extend([home.lat, home.lng]);
  map.fitBounds(b.pad(0.15));

  // Draw the #1 route to start; selecting any other event replaces it
  if (results[0]) selectEvent(results[0]);
}

// ---------- route drawing ----------
function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
}

async function selectEvent(c) {
  if (selectedRow) selectedRow.classList.remove("sel");
  const tr = c._tr;
  if (tr) { tr.classList.add("sel"); tr.scrollIntoView({ block: "nearest" }); }
  selectedRow = tr || null;
  clearRoute();
  if (c.noRoad) {
    routeLayer = L.polyline([[home.lat, home.lng], [c.lat, c.lng]],
      { color: "#c0392b", weight: 3, dashArray: "8 8", opacity: 0.8 }).addTo(map);
    map.fitBounds(routeLayer.getBounds().pad(0.15));
    setStatus(`✈️ No road route to ${c.name}. That one's a flight (${fmtKm(c.crow)} as the crow flies).`);
    return;
  }
  setStatus(`Fetching route to ${c.name}…`);
  try {
    const url = `${OSRM}/route/v1/driving/${home.lng},${home.lat};${c.lng},${c.lat}?overview=full&geometries=geojson`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.code !== "Ok") throw new Error(j.message || j.code);
    const line = j.routes[0].geometry;
    routeLayer = L.geoJSON(line, { style: { color: "#ffa300", weight: 5, opacity: 0.85 } }).addTo(map);
    map.fitBounds(routeLayer.getBounds().pad(0.15));
    setStatus(`Route: ${fmtKm(j.routes[0].distance / 1000)}, ${fmtDur(j.routes[0].duration / 60)} to ${c.name}.`);
  } catch (err) {
    setStatus("Route fetch failed: " + err.message);
  }
}

// ---------- start fresh (new person) ----------
document.getElementById("resetAllBtn").onclick = () => {
  if (!confirm("Start fresh for a new person? This clears the home base, all done events and the parkrun ID.")) return;
  // Home + done events
  clearHome();
  done.clear();
  saveState();
  localStorage.removeItem(STORE_ID);

  // Parkrun ID / import fields
  pkIdInput.value = "";
  updateResultsLink();
  document.getElementById("pasteBox").value = "";
  document.getElementById("importStatus").textContent = "";

  // Search fields + results
  document.getElementById("doneSearch").value = "";
  suggestBox.innerHTML = "";
  clearRoute();
  rankLayer.clearLayers();
  candidateCache = null;
  results = [];
  document.getElementById("results").hidden = true;
  setStatus("");

  renderDone();
  drawEventMarkers();
  map.setView([-27.5, 134], 5);
};

// ---------- intro card ----------
(function initIntro() {
  const panel = document.getElementById("introPanel");
  if (!panel) return;
  if (localStorage.getItem(STORE_INTRO)) panel.hidden = true;
  document.getElementById("hideIntroBtn").onclick = () => {
    panel.hidden = true;
    localStorage.setItem(STORE_INTRO, "1");
  };
})();

// ---------- init ----------
drawEventMarkers();
renderDone();
if (home) setHome(home.lat, home.lng, home.label);
