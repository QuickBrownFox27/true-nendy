/* True NENDY — parkrun road-distance planner (unofficial) */
"use strict";

const OSRM = "https://router.project-osrm.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const STORE_HOME = "nendy.home";
const STORE_DONE = "nendy.done";
const STORE_ID = "nendy.pkid";

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
  map.setView([lat, lng], Math.max(map.getZoom(), 10));
}

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
    st.textContent = "No Australian parkrun events recognised in that text — make sure you copied the whole results page (Ctrl+A, Ctrl+C).";
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
    if (!j.length) { setStatus("No match found — try adding the state, e.g. “Ballarat VIC”."); return; }
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

    // Shortlist nearest undone events by crow-flies
    const candidates = PARKRUN_EVENTS
      .filter(e => !done.has(e.n) && (inclJuniors || e.s === 1))
      .map(e => ({ ...e, crow: haversine(home.lat, home.lng, e.lat, e.lng) }))
      .sort((a, b) => a.crow - b.crow)
      .slice(0, N);
    candidates.forEach((c, i) => c.crowRank = i + 1);

    // One OSRM table call: home + all candidates
    const coords = [`${home.lng},${home.lat}`, ...candidates.map(c => `${c.lng},${c.lat}`)].join(";");
    const url = `${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.code !== "Ok") throw new Error("OSRM: " + (j.message || j.code));

    candidates.forEach((c, i) => {
      c.roadKm = j.distances[0][i + 1] != null ? j.distances[0][i + 1] / 1000 : Infinity;
      c.driveMin = j.durations[0][i + 1] != null ? j.durations[0][i + 1] / 60 : Infinity;
    });

    candidateCache = candidates;
    rankAndRender();
    setStatus("");
  } catch (err) {
    setStatus("Failed: " + err.message + " — the free OSRM server may be busy; try again in a minute.");
  } finally {
    btn.disabled = false;
  }
}

// Re-sort cached candidates by the chosen metric and redraw — no new OSRM call
function rankAndRender() {
  if (!candidateCache) return;
  clearRoute();
  const rankBy = document.getElementById("rankBy").value;
  results = [...candidateCache].sort((a, b) =>
    rankBy === "duration" ? a.driveMin - b.driveMin : a.roadKm - b.roadKm);
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

function fmtDur(min) {
  if (!isFinite(min)) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${m.toString().padStart(2, "0")} min` : `${m} min`;
}
function fmtKm(km) { return isFinite(km) ? km.toFixed(1) + " km" : "—"; }

function renderResults(rankBy) {
  const panel = document.getElementById("results");
  panel.hidden = false;
  document.getElementById("sortRoad").classList.toggle("active", rankBy === "distance");
  document.getElementById("sortDrive").classList.toggle("active", rankBy === "duration");

  // Hero card — the true NENDY
  const top = results[0];
  const crowTop = results.find(c => c.crowRank === 1);
  const hero = document.getElementById("nendyHero");
  let upset = "";
  if (top.crowRank !== 1) {
    upset = `<div class="upset">⚠️ Crow-flies NENDY is <strong>${crowTop.name}</strong> (${fmtKm(crowTop.crow)} direct, but ${fmtKm(crowTop.roadKm)} / ${fmtDur(crowTop.driveMin)} by road). Your <em>true</em> NENDY is different!</div>`;
  }
  hero.innerHTML = `
    <div class="tag">Your true NENDY · by ${rankBy === "duration" ? "drive time" : "road distance"}</div>
    <div class="name">${top.name}</div>
    <div class="stats">🚗 ${fmtKm(top.roadKm)} · ⏱ ${fmtDur(top.driveMin)} · 🐦 ${fmtKm(top.crow)} direct (crow rank #${top.crowRank})</div>
    ${upset}`;

  // Table
  const tbody = document.querySelector("#resultTable tbody");
  tbody.innerHTML = "";
  selectedRow = null;
  results.slice(0, 10).forEach(c => {
    const tr = document.createElement("tr");
    const d = c.crowRank - c.roadRank;
    const delta = d > 0 ? `<span class="delta-up">▲${d}</span>` :
                  d < 0 ? `<span class="delta-down">▼${-d}</span>` :
                          `<span class="delta-same">·</span>`;
    tr.innerHTML = `
      <td>${c.roadRank}</td>
      <td><div class="evt-name">${c.name.replace(" parkrun", "")}${c.s === 2 ? " (jr)" : ""}</div><div class="evt-loc">${c.loc || ""}</div></td>
      <td class="num">${fmtKm(c.roadKm)}</td>
      <td class="num">${fmtDur(c.driveMin)}</td>
      <td class="num">${fmtKm(c.crow)}</td>
      <td>${delta}</td>`;
    tr.onclick = () => selectResult(c, tr);
    tbody.appendChild(tr);
  });
  document.getElementById("resultFoot").textContent =
    `Top 10 of ${results.length} nearby candidates checked by road. Click a row to draw the driving route; Δ shows movement versus the official crow-flies ranking.`;

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
    }).bindPopup(popupHtml(c)).addTo(rankLayer);
  });

  const b = L.latLngBounds(results.slice(0, 10).map(c => [c.lat, c.lng]));
  b.extend([home.lat, home.lng]);
  map.fitBounds(b.pad(0.15));
}

// ---------- route drawing ----------
function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
}

async function selectResult(c, tr) {
  if (selectedRow) selectedRow.classList.remove("sel");
  tr.classList.add("sel");
  selectedRow = tr;
  clearRoute();
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

// ---------- init ----------
drawEventMarkers();
renderDone();
if (home) setHome(home.lat, home.lng, home.label);
