(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $("#app");
  const main = $("#main");
  const library = $("#library");
  const overlay = $("#overlay");
  const pc = $("#pc");

  const S = {
    data: null,
    selected: null,
    view: "home",
    job: null,
    error: null,
    offline: false,
    confirm: null,
    details: null,
    focusKey: null,
    lastRefresh: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2);

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
      if (!S.selected || !packs.some((p) => p.id === S.selected)) S.selected = packs[0] ? packs[0].id : null;
      if (S.data.job && S.data.job.status === "running") S.job = await api(`/api/jobs/${S.data.job.id}`);
      S.lastRefresh = Date.now();
    } catch (err) {
      S.error = err.message;
      S.offline = true;
    }
    render();
  }

  function selectedPack() {
    return (S.data?.packs || []).find((p) => p.id === S.selected) || null;
  }

  function gameWarning() {
    const g = S.data?.game;
    if (!g) return null;
    if (!g.path) return "ELDEN RING was not found on this TV. Install it in Steam, then refresh.";
    if (g.expectedBuild && g.build && String(g.build) !== String(g.expectedBuild)) {
      return `ELDEN RING is on build ${g.build}; this pack needs ${g.expectedBuild} (1.17).`;
    }
    if (g.prefixReady === false) return "Launch ELDEN RING once from Steam so its Proton prefix exists, then refresh.";
    return null;
  }

  function packState(p) {
    if (!p) return { label: "No pack", primary: null };
    if (p.status === "up-to-date") return { label: `Installed ${p.installedVersion} · up to date`, primary: { action: "launch", label: "Play" } };
    if (p.status === "update-available") return { label: `Installed ${p.installedVersion} · update ${p.mod.version} available`, primary: { action: "install", label: "Update" } };
    return { label: "Ready to install", primary: { action: "install", label: "Install" } };
  }

  function art(p, key) {
    return `/api/art/${encodeURIComponent(p.id)}/${key}`;
  }

  function renderLibrary() {
    const packs = S.data?.packs || [];
    if (!packs.length) { library.innerHTML = ""; return; }
    library.innerHTML = `<div class="libtitle">Library</div>` + packs.map((p) => {
      const sel = p.id === S.selected ? " sel" : "";
      const thumb = p.art && p.art.grid
        ? `<img src="${art(p, "grid")}" alt="" onerror="this.style.display='none'">`
        : `<div class="ph">${esc(p.name.slice(0, 3).toUpperCase())}</div>`;
      return `<button class="tile${sel}" data-select="${esc(p.id)}" data-focusable data-key="tile-${esc(p.id)}">
        <div class="art">${thumb}</div>
        <div class="txt"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.installed ? `Installed ${p.installedVersion}` : "Not installed")}</div></div>
      </button>`;
    }).join("");
    const extra = ["The Convergence", "Skyrim SE", "Baldur’s Gate 3", "Baldur’s Gate II"];
    // Only show placeholders when there is a single real pack, as a hint of what the driver system supports.
    if (packs.length === 1) {
      library.insertAdjacentHTML("beforeend", extra.map((name) => {
        const code = name === "The Convergence" ? "CNV" : name === "Skyrim SE" ? "SE" : name === "Baldur’s Gate 3" ? "BG3" : "BG2";
        return `<div class="tile locked"><div class="art"><div class="ph">${code}</div></div><div class="txt"><div class="name">${name}</div><div class="sub">No pack yet</div></div></div>`;
      }).join(""));
    }
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
    const warn = gameWarning();
    const job = S.job && S.job.status === "running" ? S.job : null;
    if (job) return renderProgress(job, p);

    const installed = p.installed;
    const canAct = !warn;
    const primary = st.primary;
    const primaryHtml = primary
      ? `<button class="btn primary" data-action="${primary.action}" data-pack="${esc(p.id)}" ${canAct ? "" : "disabled"} data-autofocus data-focusable data-key="primary">${primary.label}</button>`
      : "";
    const updateHtml = p.status === "update-available" && installed
      ? `<button class="btn" data-action="launch" data-pack="${esc(p.id)}" ${canAct ? "" : "disabled"} data-focusable data-key="play">Play ${esc(p.installedVersion)}</button>`
      : "";
    const detailsHtml = `<button class="btn ghost" data-action="details" data-pack="${esc(p.id)}" data-focusable data-key="details">Details</button>`;
    const refreshHtml = `<button class="btn ghost" data-action="retry" data-focusable data-key="refresh">Refresh</button>`;
    const rollbackHtml = p.versions && p.versions.length > 1
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
          ${warn ? `<div class="callout error">${esc(warn)}</div>` : ""}
          <div class="actions">${primaryHtml}${updateHtml}${detailsHtml}${rollbackHtml}${refreshHtml}</div>
          <div class="hint">${installed ? "Saves stay on this TV · Steam Cloud handles the vanilla save" : `${gb(p.totalBytes)} · ${p.files} files · me3 profile included`}</div>
        </div>
      </section>`;
    renderLibrary();
  }

  function renderProgress(job, pack) {
    const p = pack || selectedPack();
    const percent = job.bytesTotal ? pct(job.bytesDone, job.bytesTotal) : pct(job.done, job.total);
    const line = (job.log && job.log[job.log.length - 1]) || job.phase || "Working";
    main.innerHTML = `
      <section class="progresswrap">
        <div class="kicker">${job.status === "error" ? "INSTALL FAILED" : "INSTALLING"}</div>
        <h1>${job.status === "error" ? "Something went wrong" : `${esc(p ? p.name : "Pack")}`}</h1>
        <div class="progress">
          <div class="big">${job.status === "error" ? "ERROR" : percent + "%"}</div>
          <div class="bar"><div class="fill" style="width:${job.status === "error" ? 100 : percent}%"></div></div>
          <div class="small">${job.status === "error" ? esc(job.error || "Unknown error") : `${gb(job.bytesDone || 0)} GB of ${gb(job.bytesTotal || 0)} GB · ${job.done || 0}/${job.total || 0} files`}</div>
          <div class="log">${esc(line)}</div>
        </div>
        <div class="actions">
          ${job.status === "error" ? `<button class="btn primary" data-action="install" data-pack="${esc(job.packId)}" data-autofocus data-focusable data-key="primary">Retry</button><button class="btn ghost" data-action="cancel-job" data-focusable data-key="back">Back</button>` : `<button class="btn ghost" data-action="refresh" data-focusable data-key="refresh">Refresh</button>`}
        </div>
        <div class="hint">${job.status === "error" ? "The TV save was not touched. The previous version is still installed." : "Keep the TV on. The dashboard will show Play when it is done."}</div>
      </section>`;
    library.innerHTML = "";
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
      <p style="margin-top:2vh"><b>Recent log</b></p>
      <pre class="log" style="white-space:pre-wrap;font-size:.9vw;color:#8b96a8;max-height:18vh;overflow:auto">${esc(logs || "No log yet.")}</pre>
      <div class="actions">
        <button class="btn primary" data-action="close-details" data-autofocus data-focusable data-key="back">Back</button>
        ${p.versions && p.versions.length > 1 ? `<button class="btn" data-action="rollback" data-pack="${esc(p.id)}" data-focusable data-key="rollback">Roll back</button>` : ""}
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
    if (S.confirm) return renderConfirm();
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

  async function startInstall(packId) {
    try {
      const out = await api("/api/install", { method: "POST", body: JSON.stringify({ packId }) });
      S.job = { id: out.jobId, status: "running", phase: "preparing", done: 0, total: 0, bytesDone: 0, bytesTotal: 0, log: [] };
      S.view = "home";
      render();
      await pollJob(out.jobId);
    } catch (err) {
      S.job = { packId, status: "error", error: err.message, log: [err.message] };
      render();
    }
  }

  async function pollJob(id) {
    while (true) {
      try {
        const job = await api(`/api/jobs/${id}`);
        S.job = job;
        if (job.status !== "running") break;
        render();
      } catch (err) { S.error = err.message; break; }
      await sleep(1000);
    }
    await refresh();
  }

  async function launch(packId) {
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

  app.addEventListener("click", (event) => {
    const tile = event.target.closest("[data-select]");
    if (tile) { S.selected = tile.getAttribute("data-select"); render(); return; }
    const el = event.target.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    const packId = el.getAttribute("data-pack") || S.selected;
    if (action === "install") startInstall(packId);
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
    else if (action === "confirm-yes") { const c = S.confirm; S.confirm = null; if (c.packId) rollback(c.packId); else render(); }
    else if (action === "confirm-no") { S.confirm = null; render(); }
    else if (action === "cancel-job") { S.job = null; S.view = "home"; render(); }
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
    if (S.view === "details") { S.view = "home"; render(); return; }
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    else if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); back(); }
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
  setInterval(() => { if (!S.confirm && S.view !== "details") refresh(); }, 3000);
  refresh();
})();
