(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $("#app");
  const main = $("#main");
  const library = $("#library");
  const overlay = $("#overlay");
  const pc = $("#pc");
  const storageBtn = $("#storage-btn");
  const content = $(".content");

  const S = {
    data: null,
    selected: null,
    selectedGame: null,
    libraryView: "games",
    view: "home",
    job: null,
    error: null,
    offline: false,
    confirm: null,
    details: null,
    download: null,
    storage: null,
    wakeLock: null,
    rate: [],
    polling: false,
    focusKey: null,
    lastRefresh: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2);
  const fmtBytes = (n) => {
    let v = Number(n) || 0;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  };
  const fmtDuration = (sec) => {
    if (sec == null || !Number.isFinite(sec)) return "—";
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
  };

  async function api(path, options = {}) {
    const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function refresh() {
    try {
      S.data = await api("/api/state");
      S.offline = false;
      S.error = null;
      const packs = S.data.packs || [];
      const list = groupGames(packs);
      if (!S.selectedGame || !list.some((g) => g.id === S.selectedGame)) {
        S.selectedGame = list[0] ? list[0].id : null;
      }
      if (!S.selected || !packs.some((p) => p.id === S.selected)) {
        const game = list.find((g) => g.id === S.selectedGame);
        const pick = (game && (game.packs.find((p) => p.installed) || game.packs[0])) || packs[0];
        S.selected = pick ? pick.id : null;
        if (pick) S.selectedGame = pick.game.id;
      }
      if (S.libraryView === "packs" && !list.some((g) => g.id === S.selectedGame)) S.libraryView = "games";
      if (storageBtn) {
        storageBtn.textContent = S.data.diskFreeBytes != null
          ? `Storage · ${gb(S.data.diskFreeBytes)} GB free`
          : "Storage";
      }
      if (S.data.job && S.data.job.status === "running") S.job = await api(`/api/jobs/${S.data.job.id}`);
      else if (!S.polling && S.job && S.job.status === "running") S.job = S.data.job || null;
    } catch (err) {
      S.error = err.message;
      S.offline = true;
    }
    render();
  }

  function selectedPack() {
    return (S.data?.packs || []).find((p) => p.id === S.selected) || null;
  }

  function groupGames(packs) {
    const map = new Map();
    for (const p of packs) {
      const id = p.game?.id || p.id;
      if (!map.has(id)) {
        map.set(id, {
          id,
          title: p.game?.title || id,
          version: p.game?.version || "",
          build: p.game?.build || "",
          packs: [],
        });
      }
      map.get(id).packs.push(p);
    }
    return [...map.values()];
  }

  function games() {
    return groupGames(S.data?.packs || []);
  }

  function currentGame() {
    return games().find((g) => g.id === S.selectedGame) || games()[0] || null;
  }

  function openGame(gameId) {
    const game = games().find((g) => g.id === gameId);
    if (!game) return;
    S.selectedGame = game.id;
    const pick = game.packs.find((p) => p.installed) || game.packs[0];
    if (pick) S.selected = pick.id;
    S.libraryView = "packs";
    render();
  }

  function selectPack(packId) {
    const p = (S.data?.packs || []).find((x) => x.id === packId);
    if (!p) return;
    S.selected = p.id;
    S.selectedGame = p.game?.id || S.selectedGame;
    S.libraryView = "packs";
    render();
  }

  function packState(p) {
    if (!p) return { label: "No pack", primary: null };
    if (p.status === "up-to-date") return { label: `Installed ${p.installedVersion} · up to date`, primary: { action: "launch", label: "Play" } };
    if (p.staging) return { label: p.installed ? `Update ${p.mod.version} paused` : "Download paused", primary: { action: "download", label: "Resume install" } };
    if (p.status === "update-available") return { label: `Installed ${p.installedVersion} · update ${p.mod.version} available`, primary: { action: "download", label: "Update" } };
    return { label: "Ready to install", primary: { action: "download", label: "Install" } };
  }

  function art(p, key) {
    return `/api/art/${encodeURIComponent(p.id)}/${key}`;
  }

  function noteList(p) {
    return (p.notes || []).map((n) => typeof n === "string" ? { body: n, tone: "info", title: "" } : n).filter((n) => n && n.body);
  }

  function preconditionChecks(p) {
    return (p.preconditions && p.preconditions.checks) || [];
  }

  function firstBlocker(p) {
    return preconditionChecks(p).find((c) => c.blocked) || null;
  }

  function renderNotes(p) {
    const notes = noteList(p);
    if (!notes.length) return "";
    return `<div class="notes">${notes.map((n) => `
      <div class="noteitem ${esc(n.tone || "info")}">
        ${n.title ? `<b>${esc(n.title)}</b>` : ""}
        <div>${esc(n.body)}</div>
      </div>`).join("")}</div>`;
  }

  function renderChecks(p, allowConfirm) {
    const checks = preconditionChecks(p);
    if (!checks.length) return "";
    return `<div class="checks">${checks.map((c) => `
      <div class="check ${esc(c.status)}">
        <span class="dot"></span>
        <div class="ctext">
          <b>${esc(c.title)}</b>
          <div class="cdetail">${esc(c.detail || "")}</div>
          ${c.hint ? `<div class="chint">${esc(c.hint)}</div>` : ""}
        </div>
        ${allowConfirm && c.confirmable && c.status !== "pass"
          ? `<button class="btn ghost small" data-action="confirm-check" data-pack="${esc(p.id)}" data-check="${esc(c.id)}" data-focusable>Confirm</button>`
          : ""}
      </div>`).join("")}</div>`;
  }

  function renderLibrary() {
    const list = games();
    if (!list.length) { library.innerHTML = ""; return; }

    if (S.libraryView === "games") {
      library.innerHTML = `<div class="libtitle">Games</div>` + list.map((g) => {
        const sel = g.id === S.selectedGame ? " sel" : "";
        const pack = g.packs[0];
        const installed = g.packs.filter((p) => p.installed).length;
        const thumb = pack && pack.art && pack.art.grid
          ? `<img src="${art(pack, "grid")}" alt="" onerror="this.style.display='none'">`
          : `<div class="ph">${esc(g.title.slice(0, 3).toUpperCase())}</div>`;
        const sub = `${g.packs.length} pack${g.packs.length === 1 ? "" : "s"}${installed ? ` · ${installed} installed` : ""}`;
        return `<button class="tile${sel}" data-game="${esc(g.id)}" data-focusable data-key="game-${esc(g.id)}">
          <div class="art">${thumb}</div>
          <div class="txt"><div class="name">${esc(g.title)}</div><div class="sub">${esc(sub)}</div></div>
        </button>`;
      }).join("");
      return;
    }

    const game = currentGame();
    if (!game) { S.libraryView = "games"; return renderLibrary(); }
    const packs = game.packs.map((p) => {
      const sel = p.id === S.selected ? " sel" : "";
      const thumb = p.art && p.art.grid
        ? `<img src="${art(p, "grid")}" alt="" onerror="this.style.display='none'">`
        : `<div class="ph">${esc(p.name.slice(0, 3).toUpperCase())}</div>`;
      return `<button class="tile${sel}" data-select="${esc(p.id)}" data-focusable data-key="tile-${esc(p.id)}">
        <div class="art">${thumb}</div>
        <div class="txt"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.installed ? `Installed ${p.installedVersion}` : "Not installed")}</div></div>
      </button>`;
    }).join("");
    library.innerHTML = `<div class="libhead"><div class="libtitle">${esc(game.title)}</div><button class="linkbtn" data-action="all-games" data-focusable data-key="all-games">All games</button></div>` + packs;
  }

  function renderOffline() {
    main.innerHTML = `
      <section class="empty">
        <div class="kicker">MODSYNC</div>
        <h1>PC offline</h1>
        <div class="meta">Start <b>modsync serve</b> on the PC, keep both devices on the same LAN, then retry.</div>
        <div class="actions"><button class="btn primary" data-action="retry" data-autofocus data-focusable data-key="retry">Retry</button></div>
        <div class="hint">The TV only pulls over HTTP. No SSH, no USB.</div>
      </section>`;
    library.innerHTML = "";
  }

  function renderNoPacks() {
    main.innerHTML = `
      <section class="empty">
        <div class="kicker">MODSYNC</div>
        <h1>No packs yet</h1>
        <div class="meta">Build a pack on the PC, keep the server running, then refresh.</div>
        <div class="actions"><button class="btn primary" data-action="retry" data-autofocus data-focusable data-key="retry">Refresh</button></div>
      </section>`;
    library.innerHTML = "";
  }

  function renderHome() {
    const p = selectedPack();
    if (!p) return renderNoPacks();
    const st = packState(p);
    const blocker = firstBlocker(p);
    const job = S.job && (S.job.status === "running" || S.job.status === "error") ? S.job : null;
    if (job) return renderProgress(job, p);

    const installed = p.installed;
    const canAct = !blocker;
    const primary = st.primary;
    const primaryHtml = primary
      ? `<button class="btn primary" data-action="${primary.action}" data-pack="${esc(p.id)}" ${canAct ? "" : "disabled"} data-autofocus data-focusable data-key="primary">${primary.label}</button>`
      : "";
    const updateHtml = p.status === "update-available" && installed
      ? `<button class="btn" data-action="launch" data-pack="${esc(p.id)}" ${canAct ? "" : "disabled"} data-focusable data-key="play">Play ${esc(p.installedVersion)}</button>`
      : "";
    const detailsHtml = `<button class="btn ghost" data-action="details" data-pack="${esc(p.id)}" data-focusable data-key="details">Details</button>`;
    const refreshHtml = `<button class="btn ghost" data-action="retry" data-focusable data-key="refresh">Refresh</button>`;
    const rollbackHtml = p.canRollback
      ? `<button class="btn ghost" data-action="rollback" data-pack="${esc(p.id)}" data-focusable data-key="rollback">Roll back</button>`
      : "";

    main.innerHTML = `
      <section class="hero">
        <div class="poster">${p.art && p.art.grid ? `<img src="${art(p, "grid")}" alt="" onerror="this.style.display='none'">` : `<div class="ph">${esc(p.name.slice(0, 3).toUpperCase())}</div>`}</div>
        <div class="info">
          <div class="kicker">${esc(p.game.title)} · ${esc(p.name)}</div>
          <h1>${esc(p.name)}</h1>
          <div class="bigstatus">${installed ? `Installed ${esc(p.installedVersion)}` : "Ready to install"}</div>
          <div class="meta">${esc(st.label)} · ${esc(p.game.title)} ${esc(p.game.version || "")} · build ${esc(p.game.build || "")}</div>
          ${blocker ? `<div class="callout error"><b>${esc(blocker.title)}</b> — ${esc(blocker.detail)}${blocker.hint ? ` ${esc(blocker.hint)}` : ""}${p.preconditions?.failedRequired?.length > 1 ? ` (+${p.preconditions.failedRequired.length - 1} more)` : ""}</div>` : ""}
          <div class="actions">${primaryHtml}${updateHtml}${detailsHtml}${rollbackHtml}${refreshHtml}</div>
          <div class="hint">${installed ? "Saves stay on this TV · Steam Cloud handles the vanilla save" : `${gb(p.totalBytes)} · ${p.files} files · me3 profile included`}</div>
        </div>
      </section>`;
    renderLibrary();
  }

  function rateInfo(job) {
    const now = Date.now();
    const bytes = job.bytesDone || 0;
    S.rate.push({ t: now, b: bytes });
    while (S.rate.length > 2 && now - S.rate[0].t > 6000) S.rate.shift();
    const first = S.rate[0];
    const dt = (now - first.t) / 1000;
    const speed = dt > 0.5 ? (bytes - first.b) / dt : 0;
    const remain = (job.bytesTotal || 0) - bytes;
    return { speed, eta: speed > 0 && remain > 0 ? remain / speed : null };
  }

  async function acquireWakeLock() {
    try {
      if (!("wakeLock" in navigator) || S.wakeLock) return;
      S.wakeLock = await navigator.wakeLock.request("screen");
      S.wakeLock.addEventListener("release", () => { S.wakeLock = null; });
    } catch { S.wakeLock = null; }
  }

  async function releaseWakeLock() {
    try { await S.wakeLock?.release(); } catch { }
    S.wakeLock = null;
  }

  function renderProgress(job, pack) {
    const p = pack || selectedPack();
    const failed = job.status === "error";
    const verifying = job.phase === "verify";
    const percent = job.bytesTotal ? pct(job.bytesDone, job.bytesTotal) : pct(job.done, job.total);
    const rate = failed || verifying ? { speed: 0, eta: null } : rateInfo(job);
    const line = verifying
      ? "Checking files already on the TV..."
      : job.phase === "launcher"
        ? "Writing launcher, shortcut, and Steam art..."
        : (job.log && job.log[job.log.length - 1]) || job.phase || "Working";
    const status = failed
      ? `${esc(job.error || "Unknown error")}`
      : `${fmtBytes(job.bytesDone)} of ${fmtBytes(job.bytesTotal)} · ${job.done || 0}/${job.total || 0} files`;
    const speed = !failed && !verifying && job.status === "running"
      ? `<div class="meta">${rate.speed > 0 ? `${fmtBytes(rate.speed)}/s · ${fmtDuration(rate.eta)} left` : "Measuring speed..."}</div>`
      : "";
    main.innerHTML = `
      <section class="progresswrap">
        <div class="kicker">${failed ? "INSTALL FAILED" : verifying ? "CHECKING" : "INSTALLING"}</div>
        <h1>${failed ? "Something went wrong" : `${esc(p ? p.name : "Pack")}`}</h1>
        <div class="progress">
          <div class="big">${failed ? "ERROR" : percent + "%"}</div>
          <div class="bar"><div class="fill" style="width:${failed ? 100 : percent}%"></div></div>
          <div class="small">${status}</div>
          ${speed}
          <div class="log">${esc(line)}</div>
        </div>
        <div class="actions">
          ${failed
            ? `<button class="btn primary" data-action="start-download" data-pack="${esc(job.packId)}" data-autofocus data-focusable data-key="primary">Retry</button><button class="btn ghost" data-action="dismiss-job" data-focusable data-key="back">Back</button>`
            : `<button class="btn" data-action="cancel-download" data-autofocus data-focusable data-key="cancel">Cancel download</button>`}
        </div>
        <div class="hint">${failed ? "The TV save was not touched. The previous version is still installed." : "You can cancel and resume later. Completed files stay on the TV."}</div>
      </section>`;
    library.innerHTML = "";
  }

  function renderDownloadSheet() {
    const p = (S.data?.packs || []).find((x) => x.id === S.download.packId) || selectedPack();
    if (!p) { S.download = null; return renderHome(); }
    const free = S.data?.diskFreeBytes;
    const need = (p.totalBytes || 0) + 1024 * 1024 * 1024;
    const low = free != null && free < need;
    const resume = !!p.staging;
    const update = !!(p.installed && p.installedVersion && p.installedVersion !== p.mod.version);
    const blocker = firstBlocker(p);
    const notes = noteList(p);
    const kicker = resume ? "RESUME DOWNLOAD" : update ? "UPDATE" : "INSTALL";
    const title = resume ? "Resume install" : update ? `Update to ${p.mod.version}` : "Install pack";
    overlay.classList.remove("hidden");
    overlay.innerHTML = `<div class="panel" style="width:min(66vw,820px)">
      <div class="kicker">${kicker}</div>
      <h2>${esc(p.name)}</h2>
      <p>${esc(p.description || "")}</p>
      <div class="row"><span>Download</span><b>${gb(p.totalBytes)} GB · ${p.files} files</b></div>
      <div class="row"><span>Version</span><b>${esc(p.mod.version)}</b></div>
      ${update ? `<div class="row"><span>Current</span><b>${esc(p.installedVersion)}</b></div>` : ""}
      <div class="row"><span>Free on TV</span><b>${free == null ? "unknown" : gb(free) + " GB"}</b></div>
      <div class="row"><span>Kept</span><b>Previous version and saves stay on this TV</b></div>
      ${blocker ? `<div class="callout error"><b>${esc(blocker.title)}</b> — ${esc(blocker.detail)}${blocker.hint ? ` ${esc(blocker.hint)}` : ""}</div>` : low ? `<div class="callout error">Not enough space: this pack needs about ${gb(need)} GB free.</div>` : ""}
      ${notes.length ? `<p style="margin-top:2vh"><b>Before you install</b></p>${renderNotes(p)}` : ""}
      ${preconditionChecks(p).length ? `<p style="margin-top:2vh"><b>Checks</b></p>${renderChecks(p, true)}` : ""}
      <div class="actions">
        <button class="btn primary" data-action="start-download" data-pack="${esc(p.id)}" ${low || blocker ? "disabled" : ""} data-autofocus data-focusable data-key="start">${resume ? "Resume download" : update ? "Download update" : "Start download"}</button>
        ${update ? `<button class="btn" data-action="launch" data-pack="${esc(p.id)}" data-focusable data-key="play">Play ${esc(p.installedVersion)}</button>` : ""}
        <button class="btn ghost" data-action="close-download" data-focusable data-key="cancel">Not now</button>
      </div>
      <div class="hint">Large pack: you can cancel anytime and resume later. The TV stays awake during the download.</div>
    </div>`;
  }

  function storagePack(packId) {
    return (S.storage?.packs || []).find((p) => p.id === packId) || null;
  }

  function renderStorage() {
    library.innerHTML = "";
    const s = S.storage;
    if (!s || s.loading) {
      main.innerHTML = `<section class="storagewrap">
        <div class="kicker">STEAM MACHINE</div>
        <h1>Storage</h1>
        <div class="meta">Calculating ModSync usage...</div>
        <div class="actions"><button class="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back">Back</button></div>
      </section>`;
      return;
    }
    if (s.error) {
      main.innerHTML = `<section class="storagewrap">
        <div class="kicker">STEAM MACHINE</div>
        <h1>Storage</h1>
        <div class="callout error">${esc(s.error)}</div>
        <div class="actions"><button class="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back">Back</button></div>
      </section>`;
      return;
    }

    const packs = s.packs || [];
    const cards = packs.map((p) => {
      const rows = p.versions.map((v) => `<div class="srow"><span>${esc(v.version)}${v.current ? " · current" : ""}</span><b>${fmtBytes(v.bytes)}</b></div>`).join("");
      const staging = p.stagingBytes
        ? `<div class="srow amber"><span>Partial download</span><b>${fmtBytes(p.stagingBytes)}</b></div>`
        : "";
      const other = p.otherBytes
        ? `<div class="srow muted"><span>Profiles, tools, art</span><b>${fmtBytes(p.otherBytes)}</b></div>`
        : "";
      const actions = [
        p.stagingBytes ? `<button class="btn" data-action="storage-clear" data-scope="staging" data-pack="${esc(p.id)}" data-bytes="${p.stagingBytes}" data-focusable>Clear partial (${fmtBytes(p.stagingBytes)})</button>` : "",
        p.oldBytes ? `<button class="btn" data-action="storage-clear" data-scope="old-versions" data-pack="${esc(p.id)}" data-bytes="${p.oldBytes}" data-focusable>Remove old versions (${fmtBytes(p.oldBytes)})</button>` : "",
        `<button class="btn ghost" data-action="storage-clear" data-scope="pack" data-pack="${esc(p.id)}" data-bytes="${p.totalBytes}" data-focusable>Remove pack (${fmtBytes(p.totalBytes)})</button>`,
      ].filter(Boolean).join("");
      return `<div class="storagecard">
        <div class="shead">
          <div>
            <div class="sname">${esc(p.name)}</div>
            <div class="ssub">${p.installed ? `Installed ${esc(p.currentVersion)}` : "No installed version"}</div>
          </div>
          <div class="ssize">${fmtBytes(p.totalBytes)}</div>
        </div>
        <div class="srows">${rows}${staging}${other}</div>
        <div class="actions">${actions}</div>
      </div>`;
    }).join("");

    main.innerHTML = `<section class="storagewrap">
      <div class="kicker">STEAM MACHINE</div>
      <h1>Storage</h1>
      <div class="meta">${s.freeBytes == null ? "Free space unknown" : `${fmtBytes(s.freeBytes)} free on this TV`} · ModSync uses ${fmtBytes(s.rootBytes)}</div>
      <div class="storagegrid">
        <div class="stat"><span>Mod packs</span><b>${fmtBytes(s.packsBytes)}</b></div>
        <div class="stat"><span>Logs</span><b>${fmtBytes(s.logsBytes)}</b></div>
        <div class="stat"><span>App data</span><b>${fmtBytes(s.otherBytes)}</b></div>
      </div>
      <div class="storagepacks">${cards || `<div class="callout">No packs installed on this TV.</div>`}</div>
      <div class="actions">
        <button class="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back">Back</button>
        ${s.logsBytes ? `<button class="btn ghost" data-action="storage-clear" data-scope="logs" data-bytes="${s.logsBytes}" data-focusable>Clear logs (${fmtBytes(s.logsBytes)})</button>` : ""}
      </div>
      <div class="hint">Removing packs or versions never touches the base game or saves.</div>
    </section>`;
  }

  function requestStorageClear(packId, scope, bytes) {
    const p = storagePack(packId);
    const amount = fmtBytes(Number(bytes) || 0);
    let title;
    let message;
    if (scope === "pack") {
      title = `Remove ${p ? p.name : "pack"}?`;
      message = `This frees ${amount} and removes the pack from this TV. The base game and saves are not touched.`;
    } else if (scope === "old-versions") {
      title = "Remove old versions?";
      message = `This frees ${amount} and removes rollback targets. The current version stays installed.`;
    } else if (scope === "staging") {
      title = "Clear partial download?";
      message = `This frees ${amount} of incomplete download data. The installed version stays.`;
    } else {
      title = "Clear logs?";
      message = `This frees ${amount} of install and agent logs.`;
    }
    S.confirm = { title, message, storage: { packId, scope } };
    render();
  }

  async function clearStorageData({ packId, scope }) {
    S.confirm = null;
    try {
      const out = await api("/api/storage/clear", {
        method: "POST",
        body: JSON.stringify({ packId, scope }),
      });
      if (out.storage) S.storage = out.storage;
      await refresh();
      S.confirm = { title: "Cleared", message: `Freed ${fmtBytes(out.freedBytes)}.`, simple: true };
      render();
      setTimeout(() => { S.confirm = null; render(); }, 3000);
    } catch (err) {
      S.confirm = { title: "Could not clear", message: err.message, simple: true };
      render();
    }
  }

  async function openStorage() {
    S.view = "storage";
    S.storage = { loading: true };
    S.focusKey = "storage-back";
    render();
    try {
      S.storage = await api("/api/storage");
    } catch (err) {
      S.storage = { error: err.message };
    }
    render();
  }

  function renderDetails() {
    const p = selectedPack();
    if (!p) return;
    const d = S.details || {};
    library.innerHTML = "";
    const versions = (p.versions || []).join(", ") || "—";
    const logs = (d.logs || "").split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
    main.innerHTML = "";
    overlay.classList.remove("hidden");
    overlay.innerHTML = `<div class="panel">
      <div class="kicker">${esc(p.game.title)}</div>
      <h2>${esc(p.name)}</h2>
      <p>${esc(p.description || "")}</p>
      <div class="row"><span>Installed</span><b>${p.installed ? esc(p.installedVersion) : "No"}</b></div>
      <div class="row"><span>Available</span><b>${esc(p.mod.version)}</b></div>
      <div class="row"><span>Versions kept</span><b>${esc(versions)}</b></div>
      <div class="row"><span>Game</span><b>${esc(p.game.title)} ${esc(p.game.version || "")} · build ${esc(p.game.build || "")}</b></div>
      <div class="row"><span>Pack</span><b>${p.files} files · ${gb(p.totalBytes)} GB</b></div>
      <div class="row"><span>Launcher</span><b>${esc(p.launcher || "not installed")}</b></div>
      <div class="row"><span>Shortcut</span><b>${esc(p.desktopFile || "add the .desktop to Steam")}</b></div>
      <div class="row"><span>Saves</span><b>Stay on this TV. Steam Cloud handles the vanilla save.</b></div>
      ${noteList(p).length ? `<p style="margin-top:2vh"><b>Before you install</b></p>${renderNotes(p)}` : ""}
      ${preconditionChecks(p).length ? `<p style="margin-top:2vh"><b>Checks</b></p>${renderChecks(p, true)}` : ""}
      <p style="margin-top:2vh"><b>Recent log</b></p>
      <pre class="log" style="white-space:pre-wrap;font-size:.9vw;color:#8b96a8;max-height:18vh;overflow:auto">${esc(logs || "No log yet.")}</pre>
      <div class="actions">
        <button class="btn primary" data-action="close-details" data-autofocus data-focusable data-key="back">Back</button>
        ${p.canRollback ? `<button class="btn" data-action="rollback" data-pack="${esc(p.id)}" data-focusable data-key="rollback">Roll back</button>` : ""}
        <button class="btn ghost" data-action="open-logs" data-focusable data-key="logs">Refresh log</button>
      </div>
    </div>`;
  }

  function renderConfirm() {
    overlay.classList.remove("hidden");
    const buttons = S.confirm.simple
      ? `<button class="btn primary" data-action="confirm-no" data-autofocus data-focusable data-key="ok">OK</button>`
      : `<button class="btn primary" data-action="confirm-yes" data-autofocus data-focusable data-key="yes">Confirm</button><button class="btn ghost" data-action="confirm-no" data-focusable data-key="no">Cancel</button>`;
    overlay.innerHTML = `<div class="panel" style="width:min(60vw,680px)">
      <h2>${esc(S.confirm.title)}</h2>
      <p>${esc(S.confirm.message)}</p>
      <div class="actions">${buttons}</div>
    </div>`;
  }

  function render() {
    S.focusKey = document.activeElement?.getAttribute("data-key") || S.focusKey;
    pc.classList.toggle("online", !!S.data?.pc?.online);
    pc.querySelector("span:last-child").textContent = S.data?.pc?.online ? "PC online" : "PC offline";
    content.classList.toggle("wide", S.view === "storage");
    if (S.confirm) return renderConfirm();
    if (S.download) return renderDownloadSheet();
    if (S.view === "storage") return renderStorage();
    if (S.view === "details") return renderDetails();
    overlay.classList.add("hidden");
    if (S.offline || S.error) return renderOffline();
    const packs = S.data?.packs || [];
    if (!packs.length) return renderNoPacks();
    renderHome();
    const key = S.focusKey;
    const target = key ? document.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
    if (target) target.focus();
    else document.querySelector("[data-autofocus]")?.focus() || document.querySelector("[data-focusable]")?.focus();
  }

  function requestDownload(packId) {
    S.download = { packId };
    S.view = "home";
    render();
  }

  async function startInstall(packId) {
    S.download = null;
    S.rate = [];
    try {
      const out = await api("/api/install", { method: "POST", body: JSON.stringify({ packId }) });
      S.job = { id: out.jobId, packId, status: "running", phase: "preparing", done: 0, total: 0, bytesDone: 0, bytesTotal: 0, log: [] };
      S.view = "home";
      await acquireWakeLock();
      render();
      await pollJob(out.jobId);
    } catch (err) {
      S.job = { packId, status: "error", error: err.message, done: 0, total: 0, bytesDone: 0, bytesTotal: 0, log: [err.message] };
      render();
    }
  }

  async function cancelDownload() {
    if (!S.job || S.job.status !== "running") return;
    try {
      await api(`/api/jobs/${encodeURIComponent(S.job.id)}/cancel`, { method: "POST", body: "{}" });
    } catch (err) {
      S.confirm = { title: "Could not cancel", message: err.message, simple: true };
      render();
    }
  }

  async function pollJob(id) {
    const pack = selectedPack();
    const packName = pack?.name || "Pack";
    const packVersion = pack?.mod?.version || "";
    S.polling = true;
    S.rate = [];
    try {
      while (true) {
        try {
          const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
          S.job = job;
          if (job.status === "done") {
            await releaseWakeLock();
            await refresh();
            S.confirm = { title: "Installed", message: `${packName} ${packVersion} is ready.`, simple: true };
            render();
            setTimeout(() => { S.confirm = null; render(); }, 3500);
            return;
          }
          if (job.status === "error") {
            await releaseWakeLock();
            render();
            return;
          }
          if (job.status === "canceled") {
            await releaseWakeLock();
            S.job = null;
            await refresh();
            S.confirm = { title: "Download paused", message: "Completed files stay on the TV. Use Resume install to continue.", simple: true };
            render();
            setTimeout(() => { S.confirm = null; render(); }, 4000);
            return;
          }
          render();
        } catch (err) {
          S.error = err.message;
          render();
          return;
        }
        await sleep(1000);
      }
    } finally {
      S.polling = false;
    }
  }

  async function launch(packId) {
    S.download = null;
    S.view = "home";
    try {
      await api("/api/launch", { method: "POST", body: JSON.stringify({ packId }) });
      S.confirm = { title: "Launching", message: `${selectedPack()?.name || "Game"} is starting on this TV. Use the Guide button to return to Steam.`, simple: true };
      render();
      setTimeout(() => { S.confirm = null; refresh(); }, 4000);
    } catch (err) {
      S.confirm = { title: "Could not launch", message: err.message, simple: true };
      render();
    }
  }

  async function openDetails(packId) {
    const p = (S.data?.packs || []).find((x) => x.id === packId);
    if (p) {
      S.selected = p.id;
      S.selectedGame = p.game?.id || S.selectedGame;
    }
    S.view = "details";
    S.details = { logs: "" };
    render();
    try {
      const logs = await fetch("/api/logs").then((r) => r.text());
      S.details = { logs };
      render();
    } catch { }
  }

  async function rollback(packId) {
    S.confirm = null;
    try {
      const out = await api("/api/rollback", { method: "POST", body: JSON.stringify({ packId }) });
      S.view = "home";
      await refresh();
      S.confirm = { title: "Rolled back", message: `Now on ${out.previous}.`, simple: true };
      render();
      setTimeout(() => { S.confirm = null; render(); }, 3000);
    } catch (err) {
      S.confirm = { title: "Rollback failed", message: err.message, simple: true };
      render();
    }
  }

  async function confirmCheck(packId, checkId) {
    try {
      await api("/api/preconditions/confirm", {
        method: "POST",
        body: JSON.stringify({ packId, checkId, confirmed: true }),
      });
      await refresh();
    } catch (err) {
      S.confirm = { title: "Could not confirm", message: err.message, simple: true };
      render();
    }
  }

  app.addEventListener("click", (event) => {
    const gameTile = event.target.closest("[data-game]");
    if (gameTile) { openGame(gameTile.getAttribute("data-game")); return; }
    const tile = event.target.closest("[data-select]");
    if (tile) { selectPack(tile.getAttribute("data-select")); return; }
    const el = event.target.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    const packId = el.getAttribute("data-pack") || S.selected;
    if (action === "all-games") { S.libraryView = "games"; render(); }
    else if (action === "download") requestDownload(packId);
    else if (action === "start-download") startInstall(packId);
    else if (action === "cancel-download") cancelDownload();
    else if (action === "dismiss-job") { S.job = null; S.view = "home"; render(); }
    else if (action === "close-download") { S.download = null; S.view = "home"; render(); }
    else if (action === "storage") openStorage();
    else if (action === "close-storage") { S.view = "home"; render(); }
    else if (action === "storage-clear") requestStorageClear(packId, el.getAttribute("data-scope"), Number(el.getAttribute("data-bytes") || 0));
    else if (action === "launch") launch(packId);
    else if (action === "details") openDetails(packId);
    else if (action === "retry" || action === "refresh") refresh();
    else if (action === "close-details") { S.view = "home"; render(); }
    else if (action === "open-logs") openDetails(packId);
    else if (action === "rollback") {
      const p = selectedPack();
      const prev = p?.versions?.[p.versions.length - 2];
      S.confirm = { title: "Roll back?", message: `Switch to ${prev || "the previous version"}? The current version stays on disk.`, packId };
      render();
    }
    else if (action === "confirm-check") confirmCheck(packId, el.getAttribute("data-check"));
    else if (action === "confirm-yes") {
      const c = S.confirm;
      S.confirm = null;
      if (c.storage) clearStorageData(c.storage);
      else if (c.packId) rollback(c.packId);
      else render();
    }
    else if (action === "confirm-no") { S.confirm = null; render(); }
  });

  function focusables() {
    return $$("[data-focusable]").filter((el) => !el.disabled && el.offsetParent !== null);
  }

  function moveFocus(direction) {
    const list = focusables();
    if (!list.length) return;
    const active = document.activeElement;
    let i = list.indexOf(active);
    if (i < 0) i = 0;
    else i = (i + direction + list.length) % list.length;
    list[i].focus();
    list[i].scrollIntoView({ block: "nearest" });
  }

  function activate() {
    const active = document.activeElement;
    if (active && active.matches("[data-focusable]")) active.click();
  }

  function back() {
    if (S.confirm) { S.confirm = null; render(); return; }
    if (S.download) { S.download = null; render(); return; }
    if (S.view === "storage") { S.view = "home"; render(); return; }
    if (S.view === "details") { S.view = "home"; render(); return; }
    if (S.libraryView === "packs") { S.libraryView = "games"; render(); return; }
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    else if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); back(); }
    else if (event.key.toLowerCase() === "b") { back(); }
    else if (event.key.toLowerCase() === "d") { if (S.selected) openDetails(S.selected); }
    else if (event.key.toLowerCase() === "r") refresh();
  });

  // Controller-first: D-pad/left stick moves focus, A activates, B backs, X details, Y refreshes.
  const pad = { held: {}, lastMove: 0 };
  function pollPad() {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gps && gps[0];
    if (!gp) return;
    const now = Date.now();
    const btn = (i) => gp.buttons[i] && gp.buttons[i].pressed;
    const pressed = { up: btn(12), down: btn(13), left: btn(14), right: btn(15), a: btn(0), b: btn(1), x: btn(2), y: btn(3), start: btn(9) };
    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    if (!pressed.up && ay < -0.65) pressed.up = true;
    if (!pressed.down && ay > 0.65) pressed.down = true;
    if (!pressed.left && ax < -0.65) pressed.left = true;
    if (!pressed.right && ax > 0.65) pressed.right = true;

    for (const [k, v] of Object.entries(pressed)) {
      if (v && !pad.held[k]) {
        if (k === "up" || k === "left") { if (now - pad.lastMove > 140) { moveFocus(-1); pad.lastMove = now; } }
        else if (k === "down" || k === "right") { if (now - pad.lastMove > 140) { moveFocus(1); pad.lastMove = now; } }
        else if (k === "a") activate();
        else if (k === "b") back();
        else if (k === "x") { if (S.selected) openDetails(S.selected); }
        else if (k === "y" || k === "start") refresh();
      }
      pad.held[k] = v;
    }
  }

  setInterval(pollPad, 100);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.job?.status === "running") acquireWakeLock();
  });
  setInterval(() => {
    if (!S.confirm && !S.download && !S.polling && S.view !== "details" && S.view !== "storage") refresh();
  }, 3000);
  refresh();
})();
