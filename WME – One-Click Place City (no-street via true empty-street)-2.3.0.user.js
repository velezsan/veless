// ==UserScript==
// @name         WME – One-Click Place City (no-street via true empty-street)
// @namespace    you.wme.tools
// @version      2.3.0
// @description  Change ONLY the City of selected Place(s). With street: re-link to same-name street in target city. No-street: link to the target city's EMPTY street (blank name). No auto-save.
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  const LOG = "[Place City]";
  const LS_RECENTS = "pc_city_recents";
  const MAX_RECENTS = 8;

  // -------------------- bootstrap --------------------
  function onceReady(cb) {
    const tick = () => {
      if (window.getWmeSdk && window.SDK_INITIALIZED) {
        window.SDK_INITIALIZED.then(cb).catch(console.error);
      } else setTimeout(tick, 150);
    };
    tick();
  }

  // -------------------- helpers ----------------------
  const getRecents = () => { try { return JSON.parse(localStorage.getItem(LS_RECENTS) || "[]"); } catch { return []; } };
  const pushRecent = (c) => {
    const r = getRecents().filter(x => x.city !== c.city || x.state !== c.state);
    r.unshift(c);
    localStorage.setItem(LS_RECENTS, JSON.stringify(r.slice(0, MAX_RECENTS)));
  };

  function idsFromSelection(sel){
    if(!sel) return [];
    const t = String(sel.objectType || "").toLowerCase();
    if (t === "venue" && Array.isArray(sel.ids) && sel.ids.length) return sel.ids.slice();
    if (Array.isArray(sel.venues) && sel.venues.length) {
      return sel.venues.map(v => (typeof v === "object" ? v.id : v)).filter(Boolean);
    }
    return [];
  }
  function getSelectedVenueIds(sdk){
    try { const ids = idsFromSelection(sdk.Editing.getSelection?.()); if (ids.length) return ids; } catch {}
    try { if (typeof sdk.Editing?.getSelectedVenues === "function") { const arr = sdk.Editing.getSelectedVenues(); if (Array.isArray(arr) && arr.length) return arr.map(v => v.id).filter(Boolean); } } catch {}
    try { if (typeof sdk.DataModel?.Venues?.getSelectedIds === "function") { const arr = sdk.DataModel.Venues.getSelectedIds(); if (Array.isArray(arr) && arr.length) return arr.slice(); } } catch {}
    return [];
  }

  // -------- empty-street resolver (tries multiple known signatures) ----------
  function findEmptyStreetInCity(sdk, cityId) {
    // 1) Direct getters if present
    try {
      if (sdk.DataModel.Streets.getEmptyStreet) {
        const s = sdk.DataModel.Streets.getEmptyStreet({ cityId });
        if (s) return { street: s, via: "getEmptyStreet" };
      }
    } catch {}
    try {
      const s = sdk.DataModel.Streets.getStreet?.({ cityId, isEmpty: true });
      if (s) return { street: s, via: "getStreet(isEmpty:true)" };
    } catch {}
    try {
      const s = sdk.DataModel.Streets.getStreet?.({ cityId, streetName: "" });
      if (s && (s.isEmpty || s.name === "" || s.displayName === "")) {
        return { street: s, via: 'getStreet("")' };
      }
    } catch {}
    // 2) Scan cache
    try {
      const all = sdk.DataModel.Streets.getAll?.() || [];
      const s = all.find(st => st.cityId === cityId && (st.isEmpty || st.name === "" || st.displayName === ""));
      if (s) return { street: s, via: "scan(getAll)" };
    } catch {}
    return null;
  }

  function createEmptyStreetInCity(sdk, cityId) {
    // Try several creation signatures; first one that returns an object wins
    const tries = [
      () => sdk.DataModel.Streets.addEmptyStreet?.({ cityId }),
      () => sdk.DataModel.Streets.addStreet?.({ cityId, isEmpty: true }),
      () => sdk.DataModel.Streets.addStreet?.({ cityId, streetName: "", isEmpty: true }),
      () => sdk.DataModel.Streets.addStreet?.({ cityId, streetName: "" }),
      () => sdk.DataModel.Streets.addStreet?.({ cityId, streetName: null }),
    ];
    for (const fn of tries) {
      try {
        const s = fn();
        if (s && (s.isEmpty || s.name === "" || s.displayName === "")) {
          return { street: s };
        }
      } catch {}
    }
    return null;
  }

  async function resolveEmptyStreet(sdk, city) {
    return (
      findEmptyStreetInCity(sdk, city.id) ||
      createEmptyStreetInCity(sdk, city.id) ||
      null
    );
  }

  // -------------------- main -------------------------
  onceReady(async () => {
    const sdk = getWmeSdk({ scriptId: "wme-place-city", scriptName: "One-Click Place City" });

    // UI
    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = "Place City";

    const style = document.createElement("style");
    style.textContent = `
      #pcity { padding:12px; }
      #pcity input { width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:6px; }
      #pcity .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      #pcity button { padding:6px 10px; border-radius:8px; border:1px solid #ccc; background:#f7f7f7; cursor:pointer; }
      #pcity button:hover { background:#eee; }
      #pcity .muted { color:#555; font-size:12px; margin:6px 0; }
      #pcity .chip { display:inline-block; margin:6px 6px 0 0; padding:3px 8px; border:1px solid #ddd; border-radius:999px; font-size:12px; cursor:pointer; }
      #pcity .log { font-size:12px; white-space:pre-wrap; margin-top:8px; max-height:240px; overflow:auto; background:#fafafa; padding:8px; border:1px solid #eee; border-radius:6px; }
    `;
    tabPane.appendChild(style);

    const root = document.createElement("div");
    root.id = "pcity";
    root.innerHTML = `
      <div class="muted">Target City</div>
      <input id="pc-city" type="text" placeholder="e.g., Ciudad de México" />
      <div class="muted">Optional State (helps disambiguate)</div>
      <input id="pc-state" type="text" placeholder="e.g., CDMX / Estado de México (optional)" />
      <div id="pc-recents" class="muted"></div>

      <div class="row" style="margin-top:10px">
        <button id="pc-apply">Apply to selected Place(s)</button>
        <button id="pc-refresh">Refresh selection</button>
      </div>

      <div class="log" id="pc-log"></div>
      <div class="muted">No-street Places: I’ll use the target city’s <i>empty street</i> (blank name) if your shard supports it.</div>
    `;
    tabPane.appendChild(root);

    const $ = (id) => root.querySelector(id);
    const cityInput = $("#pc-city");
    const stateInput = $("#pc-state");
    const logBox = $("#pc-log");
    const recentsBox = $("#pc-recents");
    const applyBtn = $("#pc-apply");

    function log(t){ logBox.textContent += (logBox.textContent ? "\n" : "") + t; logBox.scrollTop = logBox.scrollHeight; console.log(LOG, t); }

    function renderRecents(){
      const rec = getRecents();
      if (!rec.length) { recentsBox.textContent = ""; return; }
      recentsBox.innerHTML = "Recent: " + rec.map(r => `<span class="chip" data-city="${r.city}" data-state="${r.state || ""}">${r.city}${r.state ? " ("+r.state+")" : ""}</span>`).join("");
      recentsBox.querySelectorAll(".chip").forEach(ch => ch.addEventListener("click", () => {
        cityInput.value = ch.getAttribute("data-city") || "";
        stateInput.value = ch.getAttribute("data-state") || "";
      }));
    }
    renderRecents();

    async function findStateByName(name){
      if (!name) return null;
      try {
        const all = sdk.DataModel.States.getAllWithoutDefault?.() || sdk.DataModel.States.getAll?.() || [];
        const n = name.trim().toLowerCase();
        return all.find(s => (s.name || "").trim().toLowerCase() === n) || null;
      } catch { return null; }
    }

    async function getOrAddCity(cityName, maybeState){
      const topCountry = sdk.DataModel.Countries.getTopCountry?.();
      let city = sdk.DataModel.Cities.getCity?.({ cityName, countryId: topCountry?.id, stateId: maybeState?.id });
      if (!city) {
        city = sdk.DataModel.Cities.addCity?.({ cityName, countryId: topCountry?.id, stateId: maybeState?.id });
        log(`  + Created city: ${cityName}${maybeState ? " / " + maybeState.name : ""}`);
      }
      return city;
    }

    function refreshSelection(){
      const ids = getSelectedVenueIds(sdk);
      applyBtn.disabled = ids.length === 0;
      logBox.textContent = ids.length ? `Selected ${ids.length} Place(s).` : "No Places selected.";
    }

    async function apply(){
      logBox.textContent = "";
      const cityName = (cityInput.value || "").trim();
      const stateName = (stateInput.value || "").trim();
      if (!cityName) { log("Please enter a target city."); return; }

      const ids = getSelectedVenueIds(sdk);
      if (!ids.length) { log("Select at least one Place."); return; }

      const stateObj = await findStateByName(stateName);
      const tgtCity  = await getOrAddCity(cityName, stateObj);
      if (!tgtCity) { log("Could not resolve or create target city."); return; }

      pushRecent({ city: cityName, state: stateObj?.name || "" });
      renderRecents();

      // Resolve empty-street once per apply (reused for all no-street venues)
      let emptyStreetInfo = await resolveEmptyStreet(sdk, tgtCity);
      if (emptyStreetInfo) {
        log(`  · Empty street available via: ${emptyStreetInfo.via || "addStreet(...)"}`);
      } else {
        log(`  · Could not resolve/create an empty street in ${tgtCity.name}. No-street Places may be skipped on this shard.`);
      }

      let changed=0, skipped=0, errors=0;

      for (const vid of ids) {
        try {
          const addr = sdk.DataModel.Venues.getAddress?.({ venueId: vid });
          const hn   = addr?.houseNumber || null;
          const streetName = addr?.street?.name ?? null;
          const currentCity = (addr?.city?.name || addr?.city || "").trim().toLowerCase();
          const targetCity  = (tgtCity?.name || "").trim().toLowerCase();

          if (currentCity && currentCity === targetCity) {
            log(`• Venue ${vid}: already in ${tgtCity.name} — skipped`);
            continue;
          }

          if (streetName) {
            // keep same street name, just switch city
            let street = sdk.DataModel.Streets.getStreet?.({ cityId: tgtCity.id, streetName });
            if (!street) {
              street = sdk.DataModel.Streets.addStreet?.({ cityId: tgtCity.id, streetName });
              log(`  + Created street "${streetName}" in ${tgtCity.name}`);
            }
            if (!street) { errors++; log(`• Venue ${vid}: failed to resolve target street "${streetName}"`); continue; }

            sdk.DataModel.Venues.updateAddress?.({ venueId: vid, houseNumber: hn || undefined, streetId: street.id });
            changed++;
            log(`• Venue ${vid}: city → ${tgtCity.name} (street kept: "${streetName}")`);
          } else {
            // no-street: require an empty-street in the target city (blank name)
            if (!emptyStreetInfo) {
              skipped++;
              log(`• Venue ${vid}: no-street skipped (no empty street available on this shard).`);
              continue;
            }
            const streetId = emptyStreetInfo.street.id;
            sdk.DataModel.Venues.updateAddress?.({ venueId: vid, houseNumber: hn || undefined, streetId });
            changed++;
            log(`• Venue ${vid}: city → ${tgtCity.name} (no street, kept blank)`);
          }
        } catch (e) {
          errors++;
          log(`• Venue ${vid}: error → ${e?.message || e}`);
        }
      }

      log(`\nDone. Changed: ${changed} • Skipped: ${skipped} • Errors: ${errors}`);
      log(`Review your edits, then click Save.`);
    }

    // wire up
    $("#pc-apply").addEventListener("click", apply);
    $("#pc-refresh").addEventListener("click", refreshSelection);
    try { sdk.Events?.on?.({ eventName: "wme-selection-changed", eventHandler: refreshSelection }); } catch {}
    refreshSelection();

    // Shortcut
    document.addEventListener("keydown",(e)=>{ if(e.shiftKey && (e.key==="c"||e.key==="C")){ const b=document.querySelector("#pc-apply"); if(b && !b.disabled) b.click(); }});
  });
})();
