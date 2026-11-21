(() => {
  const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el;
  };
  const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
  const app = $("#app");
  const main = $("#main");
  const library = $("#library");
  const overlay = $("#overlay");
  const pc = $("#pc");
  const storageBtn = $("#storage-btn");
  const updateBtn = $("#update-btn");
  const content = $(".content");
  const desktop: ModsyncDesktop | null = typeof window !== "undefined" ? window.modsyncDesktop || null : null;
  const labels: BrowserLabels = window.MODSYNC_LABELS;

  const S: AppState = {
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
    update: null,
    wakeLock: null,
    rate: [],
    polling: false,
    focusKey: null,
    lastRefresh: 0,
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const messageOf = (err: unknown): string => err instanceof Error ? messageOf(err) : String(err);
  const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
  const pct = (a: number, b: number): number => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const gb = (n: number | null | undefined): string => ((n || 0) / 1024 / 1024 / 1024).toFixed(2);
  const fmtBytes = (n: unknown): string => {
    let v = Number(n) || 0;
    const units = labels.bytesUnits as string[];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  };
  const fmtDuration = (sec: number | null | undefined): string => {
    if (sec == null || !Number.isFinite(sec)) return labels.durationDash;
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? labels.durationHours(h, m) : m ? labels.durationMinutes(m) : labels.durationSeconds(s);
  };

  async function api<T extends object = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
    const text = await res.text();
    let data: { error?: string; raw?: string } = {};
    try { data = text ? JSON.parse(text) as typeof data : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data as T;
  }

  async function refresh() {
    try {
      S.data = await api<AgentStateView>("/api/state");
      S.offline = false;
      S.error = null;
      const packs = S.data.packs || [];
      if (!packs.length && S.data.pc && S.data.pc.online === false) {
        S.offline = true;
        S.error = S.data.pc.error || labels.offlineTitle;
      }
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
          ? labels.storageWithFree(gb(S.data.diskFreeBytes))
          : labels.storage;
      }
      if (S.data.job && S.data.job.status === "running") S.job = await api<JobView>(`/api/jobs/${S.data.job.id}`);
      else if (!S.polling && S.job && S.job.status === "running") S.job = S.data.job || null;
    } catch (err) {
      S.error = messageOf(err);
      S.offline = true;
    }
    render();
  }

  function selectedPack(): PackView | null {
    return (S.data?.packs || []).find((p) => p.id === S.selected) || null;
  }

  function groupGames(packs: PackView[]): GameGroup[] {
    const map = new Map<string, GameGroup>();
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
      map.get(id)!.packs.push(p);
    }
    return [...map.values()];
  }

  function games(): GameGroup[] {
    return groupGames(S.data?.packs || []);
  }

  function currentGame(): GameGroup | null {
    return games().find((g) => g.id === S.selectedGame) || games()[0] || null;
  }

  function openGame(gameId: string): void {
    const game = games().find((g) => g.id === gameId);
    if (!game) return;
    S.selectedGame = game.id;
    const pick = game.packs.find((p) => p.installed) || game.packs[0];
    if (pick) S.selected = pick.id;
    S.libraryView = "packs";
    render();
  }

  function selectPack(packId: string): void {
    const p = (S.data?.packs || []).find((x) => x.id === packId);
    if (!p) return;
    S.selected = p.id;
    S.selectedGame = p.game?.id || S.selectedGame;
    S.libraryView = "packs";
    render();
  }

  function packState(p: PackView | null): { title: string; detail: string; primary: { action: string; label: string } | null } {
    if (!p) return { title: labels.noPack, detail: "", primary: null };
    const state = p.status !== "up-to-date" && p.staging ? "staging" : p.status;
    switch (state) {
      case "up-to-date":
        return {
          title: labels.installed(p.installedVersion ?? null),
          detail: labels.upToDate,
          primary: { action: "launch", label: labels.play },
        };
      case "staging":
        return {
          title: p.installed ? labels.installed(p.installedVersion ?? null) : labels.downloadPaused,
          detail: p.installed ? labels.updatePaused(p.mod.version) : "",
          primary: { action: "download", label: labels.resumeInstall },
        };
      case "update-available":
        return {
          title: labels.installed(p.installedVersion ?? null),
          detail: labels.updateAvailable(p.mod.version),
          primary: { action: "download", label: labels.update },
        };
      case "not-installed":
      default:
        return {
          title: labels.readyToInstall,
          detail: "",
          primary: { action: "download", label: labels.install },
        };
    }
  }

  function art(p: PackView, key: string): string {
    return `/api/art/${encodeURIComponent(p.id)}/${key}`;
  }

  function noteList(p: PackView): Array<{ title: string; body: string; tone: string }> {
    return (p.notes || []).map((n) => typeof n === "string" ? { body: n, tone: "info", title: "" } : { body: n.body, tone: n.tone || "info", title: n.title || "" }).filter((n) => n && n.body);
  }

  function preconditionChecks(p: PackView): CheckView[] {
    return (p.preconditions && p.preconditions.checks) || [];
  }

  function firstBlocker(p: PackView): CheckView | null {
    return preconditionChecks(p).find((c) => c.blocked) || null;
  }

  function renderNotes(p: PackView): string {
    const notes = noteList(p);
    if (!notes.length) return "";
    return `<div class="notes">${notes.map((n) => `
      <div class="noteitem ${esc(n.tone || "info")}">
        ${n.title ? `<b>${esc(n.title)}</b>` : ""}
        <div>${esc(n.body)}</div>
      </div>`).join("")}</div>`;
  }

  function renderChecks(p: PackView, allowConfirm: boolean): string {
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
          ? `<button class="btn ghost small" data-action="confirm-check" data-pack="${esc(p.id)}" data-check="${esc(c.id)}" data-focusable>${labels.confirm}</button>`
          : ""}
      </div>`).join("")}</div>`;
  }

  function contentsCount(contents: ContentsView | null | undefined): string {
    if (!contents) return "";
    return contents.kind === "mods" ? labels.modsCount(contents.count) : labels.packagesCount(contents.count);
  }

  function contentsNames(contents: ContentsView | null | undefined): string[] {
    if (!contents) return [];
    if (Array.isArray(contents.mods)) return contents.mods.map((m) => m.name).filter((name): name is string => !!name);
    if (Array.isArray(contents.packages)) return contents.packages.map((p) => p.label || p.path).filter((name): name is string => !!name);
    return [];
  }

  function packContents(p: PackView): string {
    const base = labels.stats(gb(p.totalBytes), p.files);
    const contents = p.contents ? ` · ${contentsCount(p.contents)}` : "";
    const installed = p.install && p.install.label
      ? p.install.label
      : (p.loader && p.loader.type ? labels.loaderIncluded(p.loader.type) : "");
    return installed ? `${base}${contents} · ${installed}` : `${base}${contents}`;
  }

  function renderUpdateButton() {
    if (!updateBtn) return;
    if (S.update && S.update.available) {
      updateBtn.textContent = labels.updateTo(S.update.latest);
      updateBtn.classList.remove("hidden");
    } else {
      updateBtn.classList.add("hidden");
    }
  }

  async function checkDesktopUpdate() {
    if (!desktop || !desktop.checkUpdate) return;
    try {
      S.update = await desktop.checkUpdate();
    } catch {
      S.update = null;
    }
    renderUpdateButton();
  }

  function requestAppUpdate() {
    if (S.confirm && S.confirm.busy) return;
    if (!S.update || !S.update.available) return;
    if (!S.update.canInstall) {
      if (desktop && desktop.openReleases) desktop.openReleases();
      return;
    }
    S.confirm = {
      title: labels.updateTitle(S.update.latest),
      message: labels.updateMessage,
      appUpdate: true,
    };
    render();
  }

  async function installAppUpdate() {
    if (!S.update || !desktop) return;
    const latest = S.update.latest;
    S.confirm = {
      title: labels.updateInstallingTitle,
      message: labels.updateInstallingMessage(latest),
      busy: true,
    };
    render();
    try {
      await desktop.installUpdate();
      // The main process holds the window open briefly so this can be read;
      // Game Mode ends the app's session on quit, so it will not come back.
      S.confirm = {
        title: labels.updateClosingTitle,
        message: labels.updateClosingMessage(latest),
        busy: true,
      };
      render();
    } catch (err) {
      S.confirm = { title: labels.updateFailed, message: messageOf(err), simple: true };
      render();
    }
  }

  function renderLibrary() {
    const list = games();
    if (!list.length) { library.innerHTML = ""; return; }

    if (S.libraryView === "games") {
      const installedCount = list.reduce((n, g) => n + g.packs.filter((p) => p.installed).length, 0);
      const offline = S.data?.pc?.online === false;
      const free = S.data?.diskFreeBytes;
      const side = `
        <div class="sidecard">
          <div class="libtitle">${labels.thisTv}</div>
          <div class="meta">${labels.packsInstalled(installedCount)}${free != null ? ` · ${labels.freeWithGb(gb(free))}` : ""}</div>
          <div class="actions"><button class="btn ghost small" data-action="storage" data-focusable data-key="side-storage">${labels.manageStorage}</button></div>
        </div>
        ${offline ? `<div class="sidecard"><div class="libtitle">${labels.pcOfflineTitle}</div><div class="meta">${labels.pcOfflineBody}</div></div>` : ""}`;
      library.innerHTML = `<div class="libtitle">${labels.games}</div>` + list.map((g) => {
        const sel = g.id === S.selectedGame ? " sel" : "";
        const pack = g.packs[0];
        const installed = g.packs.filter((p) => p.installed).length;
        const thumb = pack && pack.art && pack.art.grid
          ? `<img src="${art(pack, "grid")}" alt="" onerror="this.style.display='none'">`
          : `<div class="ph">${esc(g.title.slice(0, 3).toUpperCase())}</div>`;
        const sub = labels.packLine(g.packs.length, installed);
        return `<button class="tile${sel}" data-game="${esc(g.id)}" data-focusable data-key="game-${esc(g.id)}">
          <div class="art">${thumb}</div>
          <div class="txt"><div class="name">${esc(g.title)}</div><div class="sub">${esc(sub)}</div></div>
        </button>`;
      }).join("") + side;
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
        <div class="txt"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.installed ? labels.installed(p.installedVersion) : labels.notInstalled)}</div></div>
      </button>`;
    }).join("");
    library.innerHTML = `<div class="libhead"><div class="libtitle">${esc(game.title)}</div><button class="linkbtn" data-action="all-games" data-focusable data-key="all-games">${labels.allGames}</button></div>` + packs;
  }

  function renderOffline() {
    main.innerHTML = `
      <section class="empty">
        <div class="kicker">${labels.appName.toUpperCase()}</div>
        <h1>${labels.offlineTitle}</h1>
        <div class="meta">${labels.offlineBody}</div>
        <div class="actions"><button class="btn primary" data-action="retry" data-autofocus data-focusable data-key="retry">${labels.retry}</button></div>
        <div class="hint">${labels.offlineHint}</div>
      </section>`;
    library.innerHTML = "";
  }

  function renderNoPacks() {
    main.innerHTML = `
      <section class="empty">
        <div class="kicker">${labels.appName.toUpperCase()}</div>
        <h1>${labels.noPacksTitle}</h1>
        <div class="meta">${labels.noPacksBody}</div>
        <div class="actions"><button class="btn primary" data-action="retry" data-autofocus data-focusable data-key="retry">${labels.refresh}</button></div>
      </section>`;
    library.innerHTML = "";
  }

  function renderHome() {
    const p = selectedPack();
    if (!p) return renderNoPacks();
    const packStatus = packState(p);
    const blocker = firstBlocker(p);
    const job = S.job && (S.job.status === "running" || S.job.status === "error") ? S.job : null;
    if (job) return renderProgress(job, p);

    const installed = p.installed;
    const offline = S.data?.pc?.online === false;
    const canAct = !blocker;
    const primary = packStatus.primary;
    const stateText = !installed
      ? null
      : offline
        ? labels.pcOfflineCheck
        : packStatus.detail;
    const primaryHtml = primary
      ? `<button class="btn primary" data-action="${primary.action}" data-pack="${esc(p.id)}" ${canAct ? "" : "disabled"} data-autofocus data-focusable data-key="primary">${primary.label}</button>`
      : "";
    const updateHtml = p.status === "update-available" && installed
      ? `<button class="btn" data-action="launch" data-pack="${esc(p.id)}" ${canAct ? "" : "disabled"} data-focusable data-key="play">${labels.playVersion(esc(p.installedVersion))}</button>`
      : "";
    const detailsHtml = `<button class="btn ghost" data-action="details" data-pack="${esc(p.id)}" data-focusable data-key="details">${labels.details}</button>`;
    const refreshHtml = `<button class="btn ghost" data-action="retry" data-focusable data-key="refresh">${labels.refresh}</button>`;
    const rollbackHtml = p.canRollback
      ? `<button class="btn ghost" data-action="rollback" data-pack="${esc(p.id)}" data-focusable data-key="rollback">${labels.rollBack}</button>`
      : "";
    const uninstallHtml = p.local
      ? `<button class="btn ghost" data-action="uninstall" data-pack="${esc(p.id)}" data-focusable data-key="uninstall">${labels.uninstall}</button>`
      : "";

    main.innerHTML = `
      <section class="hero">
        <div class="poster">${p.art && p.art.grid ? `<img src="${art(p, "grid")}" alt="" onerror="this.style.display='none'">` : `<div class="ph">${esc(p.name.slice(0, 3).toUpperCase())}</div>`}</div>
        <div class="info">
          <div class="kicker">${esc(labels.kicker(p.game.title, p.name))}</div>
          <h1>${esc(p.name)}</h1>
          <div class="bigstatus">${esc(packStatus.title)}</div>
          <div class="meta">${stateText ? `${esc(stateText)} · ` : ""}${esc(p.game.title)} ${esc(p.game.version || "")} · ${labels.buildLabel} ${esc(p.game.build || "")}</div>
          ${blocker ? `<div class="callout error"><b>${esc(blocker.title)}</b> — ${esc(blocker.detail)}${blocker.hint ? ` ${esc(blocker.hint)}` : ""}${(p.preconditions?.failedRequired?.length || 0) > 1 ? labels.moreChecks((p.preconditions?.failedRequired?.length || 0) - 1) : ""}</div>` : ""}
          <div class="actions">${primaryHtml}${updateHtml}${detailsHtml}${rollbackHtml}${uninstallHtml}${refreshHtml}</div>
          <div class="hint">${installed ? labels.savesHintVanilla : packContents(p)}</div>
        </div>
      </section>`;
    renderLibrary();
  }

  function rateInfo(job: JobView): { speed: number; eta: number | null } {
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

  function renderProgress(job: JobView, pack?: PackView | null): void {
    const p = pack || selectedPack();
    const failed = job.status === "error";
    const verifying = job.phase === "verify";
    const percent = job.bytesTotal ? pct(job.bytesDone || 0, job.bytesTotal) : pct(job.done || 0, job.total || 0);
    const rate = failed || verifying ? { speed: 0, eta: null } : rateInfo(job);
    const line = verifying
      ? labels.checkingFiles
      : job.phase === "launcher"
        ? labels.launcherPhase
        : job.phase === "apply"
          ? labels.applyPhase
          : (job.log && job.log[job.log.length - 1]) || job.phase || labels.working;
    const status = failed
      ? `${esc(job.error || labels.error)}`
      : labels.progressFiles(job.done || 0, job.total || 0, fmtBytes(job.bytesDone), fmtBytes(job.bytesTotal));
    const speed = !failed && !verifying && job.status === "running"
      ? `<div class="meta">${rate.speed > 0 ? labels.speedEta(fmtBytes(rate.speed), fmtDuration(rate.eta)) : labels.measuringSpeed}</div>`
      : "";
    main.innerHTML = `
      <section class="progresswrap">
        <div class="kicker">${failed ? labels.installFailed : verifying ? labels.checking : labels.installing}</div>
        <h1>${failed ? labels.somethingWrong : `${esc(p ? p.name : labels.packTitle)}`}</h1>
        <div class="progress">
          <div class="big">${failed ? labels.error : percent + "%"}</div>
          <div class="bar"><div class="fill" style="width:${failed ? 100 : percent}%"></div></div>
          <div class="small">${status}</div>
          ${speed}
          <div class="log">${esc(line)}</div>
        </div>
        <div class="actions">
          ${failed
            ? `<button class="btn primary" data-action="start-download" data-pack="${esc(job.packId)}" data-autofocus data-focusable data-key="primary">${labels.retry}</button><button class="btn ghost" data-action="dismiss-job" data-focusable data-key="back">${labels.back}</button>`
            : `<button class="btn" data-action="cancel-download" data-autofocus data-focusable data-key="cancel">${labels.cancelDownload}</button>`}
        </div>
        <div class="hint">${failed ? labels.previousKept : labels.keepTv}</div>
      </section>`;
    library.innerHTML = "";
  }

  function renderDownloadSheet(): void {
    const download = S.download;
    const p = (S.data?.packs || []).find((x) => x.id === download?.packId) || selectedPack();
    if (!p) { S.download = null; return renderHome(); }
    const free = S.data?.diskFreeBytes;
    const resume = !!p.staging;
    const update = !!(p.installed && p.installedVersion && p.installedVersion !== p.mod.version);
    const blocker = firstBlocker(p);
    const notes = noteList(p);
    const kicker = resume ? labels.resumeDownloadKicker : update ? labels.updateKicker : labels.installKicker;
    const title = resume ? labels.resumeDownload : update ? labels.updateTo(p.mod.version) : labels.installPack;
    overlay.classList.remove("hidden");
    overlay.innerHTML = `<div class="panel" style="width:min(66vw,820px)">
      <div class="kicker">${kicker}</div>
      <h2>${esc(p.name)}</h2>
      <p>${esc(p.description || "")}</p>
      <div class="row"><span>${labels.downloadSheet}</span><b>${labels.stats(gb(p.totalBytes), p.files)}</b></div>
      ${p.contents ? `<div class="row"><span>${labels.contentsRow}</span><b>${contentsCount(p.contents)}</b></div>` : ""}
      <div class="row"><span>${labels.version}</span><b>${esc(p.mod.version)}</b></div>
      ${update ? `<div class="row"><span>${labels.current}</span><b>${esc(p.installedVersion)}</b></div>` : ""}
      <div class="row"><span>${labels.freeOnTv}</span><b>${free == null ? labels.unknown : gb(free) + " GB"}</b></div>
      <div class="row"><span>${labels.kept}</span><b>${labels.keptValue}</b></div>
      ${blocker ? `<div class="callout error"><b>${esc(blocker.title)}</b> — ${esc(blocker.detail)}${blocker.hint ? ` ${esc(blocker.hint)}` : ""}</div>` : ""}
      ${notes.length ? `<p style="margin-top:2vh"><b>${labels.beforeInstall}</b></p>${renderNotes(p)}` : ""}
      ${preconditionChecks(p).length ? `<p style="margin-top:2vh"><b>${labels.checks}</b></p>${renderChecks(p, true)}` : ""}
      <div class="actions">
        <button class="btn primary" data-action="start-download" data-pack="${esc(p.id)}" ${blocker ? "disabled" : ""} data-autofocus data-focusable data-key="start">${resume ? labels.resumeDownload : update ? labels.downloadUpdate : labels.startDownload}</button>
        ${update ? `<button class="btn" data-action="launch" data-pack="${esc(p.id)}" data-focusable data-key="play">${labels.playVersion(esc(p.installedVersion))}</button>` : ""}
        <button class="btn ghost" data-action="close-download" data-focusable data-key="cancel">${labels.notNow}</button>
      </div>
      <div class="hint">${labels.startDownloadHint}</div>
    </div>`;
  }

  function storagePack(packId: string): StoragePackView | null {
    return (S.storage?.packs || []).find((p) => p.id === packId) || null;
  }

  function renderStorage() {
    overlay.classList.add("hidden");
    library.innerHTML = "";
    const s = S.storage;
    if (!s || s.loading) {
      main.innerHTML = `<section class="storagewrap">
        <div class="kicker">${labels.steamMachine}</div>
        <h1>${labels.storageTitle}</h1>
        <div class="meta">${labels.calculating}</div>
        <div class="actions"><button class="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back">${labels.back}</button></div>
      </section>`;
      return;
    }
    if (s.error) {
      main.innerHTML = `<section class="storagewrap">
        <div class="kicker">${labels.steamMachine}</div>
        <h1>${labels.storageTitle}</h1>
        <div class="callout error">${esc(s.error)}</div>
        <div class="actions"><button class="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back">${labels.back}</button></div>
      </section>`;
      return;
    }

    const packs = s.packs || [];
    const cards = packs.map((p) => {
      const rows = p.versions.map((v) => `<div class="srow"><span>${esc(v.version)}${v.current ? ` · ${labels.currentVersion}` : ""}</span><b>${fmtBytes(v.bytes)}</b></div>`).join("");
      const staging = p.stagingBytes
        ? `<div class="srow amber"><span>${labels.partialDownload}</span><b>${fmtBytes(p.stagingBytes)}</b></div>`
        : "";
      const other = p.otherBytes
        ? `<div class="srow muted"><span>${labels.profilesToolsArt}</span><b>${fmtBytes(p.otherBytes)}</b></div>`
        : "";
      const actions = [
        p.stagingBytes ? `<button class="btn" data-action="storage-clear" data-scope="staging" data-pack="${esc(p.id)}" data-bytes="${p.stagingBytes}" data-focusable>${labels.clearPartial(fmtBytes(p.stagingBytes))}</button>` : "",
        p.oldBytes ? `<button class="btn" data-action="storage-clear" data-scope="old-versions" data-pack="${esc(p.id)}" data-bytes="${p.oldBytes}" data-focusable>${labels.removeOldVersions(fmtBytes(p.oldBytes))}</button>` : "",
        `<button class="btn ghost" data-action="storage-clear" data-scope="pack" data-pack="${esc(p.id)}" data-bytes="${p.totalBytes}" data-focusable>${labels.removePack(fmtBytes(p.totalBytes))}</button>`,
      ].filter(Boolean).join("");
      return `<div class="storagecard">
        <div class="shead">
          <div>
            <div class="sname">${esc(p.name)}</div>
            <div class="ssub">${p.installed ? labels.installed(esc(p.currentVersion)) : labels.noInstalledVersion}</div>
          </div>
          <div class="ssize">${fmtBytes(p.totalBytes)}</div>
        </div>
        <div class="srows">${rows}${staging}${other}</div>
        <div class="actions">${actions}</div>
      </div>`;
    }).join("");

    main.innerHTML = `<section class="storagewrap">
      <div class="kicker">${labels.steamMachine}</div>
      <h1>${labels.storageTitle}</h1>
      <div class="meta">${s.freeBytes == null ? labels.freeUnknown : labels.freeOnTvValue(fmtBytes(s.freeBytes))} · ${labels.modSyncUses(fmtBytes(s.rootBytes))}</div>
      <div class="storagegrid">
        <div class="stat"><span>${labels.modPacks}</span><b>${fmtBytes(s.packsBytes)}</b></div>
        <div class="stat"><span>${labels.logs}</span><b>${fmtBytes(s.logsBytes)}</b></div>
        <div class="stat"><span>${labels.appData}</span><b>${fmtBytes(s.otherBytes)}</b></div>
      </div>
      <div class="storagepacks">${cards || `<div class="callout">${labels.noPacksInstalled}</div>`}</div>
      <div class="actions">
        <button class="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back">${labels.back}</button>
        ${s.logsBytes ? `<button class="btn ghost" data-action="storage-clear" data-scope="logs" data-bytes="${s.logsBytes}" data-focusable>${labels.clearLogs(fmtBytes(s.logsBytes))}</button>` : ""}
      </div>
      <div class="hint">${labels.storageHint}</div>
    </section>`;
  }

  async function requestStorageClear(packId: string, scope: string, bytes: number | string): Promise<void> {
    const p = storagePack(packId) || selectedPack();
    const amount = fmtBytes(Number(bytes) || 0);
    let title;
    let message;
    if (scope === "pack") {
      title = labels.removePackTitle(p ? p.name : labels.packTitle);
      message = labels.removePackMessage(amount);
    } else if (scope === "old-versions") {
      title = labels.removeOldVersionsTitle;
      message = labels.removeOldVersionsMessage(amount);
    } else if (scope === "staging") {
      title = labels.clearPartialTitle;
      message = labels.clearPartialMessage(amount);
    } else {
      title = labels.clearLogsTitle;
      message = labels.clearLogsMessage(amount);
    }

    if (scope === "pack") {
      showConfirm({ title: labels.checkingUninstallTitle, message: labels.checkingUninstallMessage, busy: true });
      try {
        const plan = await api<{ ok: boolean; errors: string[]; actions: string[]; warnings: string[] }>("/api/storage/clear", {
          method: "POST",
          body: JSON.stringify({ packId, scope, dryRun: true }),
        });
        if (!plan.ok) {
          showConfirm({
            title: labels.uninstallBlocked,
            message: "",
            detailsTitle: labels.uninstallBlockedMessage,
            details: plan.errors,
            simple: true,
          });
          return;
        }
        showConfirm({
          title,
          message,
          detailsTitle: labels.uninstallPlan,
          details: plan.actions && plan.actions.length ? plan.actions : ["Remove the pack"],
          warnings: plan.warnings,
          storage: { packId, scope },
        });
      } catch (err) {
        showConfirm({ title: labels.uninstallBlocked, message: messageOf(err), simple: true });
      }
      return;
    }

    showConfirm({ title, message, storage: { packId, scope } });
  }

  async function clearStorageData({ packId, scope }: { packId?: string; scope: string }): Promise<void> {
    const fromDetails = S.view === "details";
    showConfirm({
      title: scope === "pack" ? labels.uninstallingTitle : labels.clearingTitle,
      message: scope === "pack" ? labels.uninstallingMessage : labels.clearingMessage,
      busy: true,
    });
    try {
      const out = await api<{ storage?: StorageView; freedBytes?: number }>("/api/storage/clear", {
        method: "POST",
        body: JSON.stringify({ packId, scope }),
      });
      if (out.storage) S.storage = out.storage;
      if (scope === "pack" && fromDetails) {
        S.view = "home";
        S.selected = null;
      }
      await refresh();
      showConfirm({ title: labels.clearedTitle, message: labels.freedMessage(fmtBytes(out.freedBytes)), simple: true }, 3000);
    } catch (err) {
      showConfirm({ title: labels.couldNotClear, message: messageOf(err), simple: true });
    }
  }

  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  function showConfirm(confirm: ConfirmView, timeout = 0): void {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    S.confirm = confirm;
    render();
    if (timeout > 0) {
      confirmTimer = setTimeout(() => {
        confirmTimer = null;
        S.confirm = null;
        render();
      }, timeout);
    }
  }

  function dismissConfirm() {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    S.confirm = null;
    render();
  }

  async function openStorage() {
    S.view = "storage";
    S.storage = { loading: true };
    S.focusKey = "storage-back";
    render();
    try {
      S.storage = await api("/api/storage");
    } catch (err) {
      S.storage = { error: messageOf(err) };
    }
    render();
  }

  function launchLabel(p: PackView): string {
    const launch = p.launch || {};
    if (launch.mode === "default") return labels.launchDefault;
    if (launch.mode === "alternate-exe") return labels.launchAlternate(launch.exe || labels.unknown);
    if (launch.mode === "loader") return labels.launchLoader((p.loader && p.loader.type) || launch.type || "loader");
    return launch.exe || labels.unknown;
  }

  function renderDetails(): void {
    const p = selectedPack();
    if (!p) return;
    const d = S.details || {};
    library.innerHTML = "";
    const versions = (p.versions || []).join(", ") || labels.noVersions;
    const logs = (d.logs || "").split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
    main.innerHTML = "";
    overlay.classList.remove("hidden");
    overlay.innerHTML = `<div class="panel">
      <div class="kicker">${esc(p.game.title)}</div>
      <h2>${esc(p.name)}</h2>
      <p>${esc(p.description || "")}</p>
      <div class="row"><span>${labels.installedRow}</span><b>${p.installed ? esc(p.installedVersion) : labels.noVersion}</b></div>
      <div class="row"><span>${labels.availableRow}</span><b>${esc(p.mod.version)}</b></div>
      <div class="row"><span>${labels.versionsKept}</span><b>${esc(versions)}</b></div>
      <div class="row"><span>${labels.gameRow}</span><b>${esc(p.game.title)} ${esc(p.game.version || "")} · ${labels.buildLabel} ${esc(p.game.build || "")}</b></div>
      ${p.platform ? `<div class="row"><span>${labels.platformRow}</span><b>${labels.platformName(p.platform.variant)}${p.platform.supported ? "" : ` · ${labels.platformUnsupported}`}</b></div>` : ""}
      <div class="row"><span>${labels.launchRow}</span><b>${esc(launchLabel(p))}</b></div>
      <div class="row"><span>${labels.packRow}</span><b>${labels.stats(gb(p.totalBytes), p.files)}</b></div>
      ${p.contents ? `<div class="row"><span>${labels.contentsRow}</span><b>${contentsCount(p.contents)} ${labels.contentsSource(p.contents.source)}</b></div>` : ""}
      <div class="row"><span>${labels.launcherRow}</span><b>${esc(p.launcher || labels.notInstalled)}</b></div>
      <div class="row"><span>${labels.shortcutRow}</span><b>${p.launch && p.launch.mode === "default" ? labels.steamGameLink : esc(p.desktopFile || labels.addDesktop)}</b></div>
      <div class="row"><span>${labels.savesRow}</span><b>${labels.savesValue}</b></div>
      ${noteList(p).length ? `<p style="margin-top:2vh"><b>${labels.beforeInstall}</b></p>${renderNotes(p)}` : ""}
      ${p.contents ? `<p style="margin-top:2vh"><b>${p.contents.kind === "mods" ? labels.includedMods : labels.includedPackages}</b> <span class="meta">${labels.contentsSource(p.contents.source)}${p.contents.inactivePaks && p.contents.inactivePaks.length ? ` · ${labels.inactivePaks(p.contents.inactivePaks.length)}` : ""}</span></p><div class="modlist">${contentsNames(p.contents).map((name) => esc(name)).join(" · ")}</div>` : ""}
      ${preconditionChecks(p).length ? `<p style="margin-top:2vh"><b>${labels.checks}</b></p>${renderChecks(p, true)}` : ""}
      <p style="margin-top:2vh"><b>${labels.recentLog}</b></p>
      <pre class="log" style="white-space:pre-wrap;font-size:.9vw;color:#8b96a8;max-height:18vh;overflow:auto">${esc(logs || labels.noLogYet)}</pre>
      <div class="actions">
        <button class="btn primary" data-action="close-details" data-autofocus data-focusable data-key="back">${labels.back}</button>
        ${p.canRollback ? `<button class="btn" data-action="rollback" data-pack="${esc(p.id)}" data-focusable data-key="rollback">${labels.rollBack}</button>` : ""}
        ${p.local ? `<button class="btn ghost" data-action="uninstall" data-pack="${esc(p.id)}" data-focusable data-key="uninstall">${labels.uninstall}</button>` : ""}
        <button class="btn ghost" data-action="open-logs" data-focusable data-key="logs">${labels.refreshLog}</button>
      </div>
    </div>`;
  }

  function renderConfirm(): void {
    const confirm = S.confirm;
    if (!confirm) return;
    overlay.classList.remove("hidden");
    if (confirm.busy) {
      overlay.innerHTML = `<div class="panel" style="width:min(60vw,680px)" aria-busy="true">
        <h2>${esc(confirm.title)}</h2>
        <p class="busy" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(confirm.message)}</span></p>
      </div>`;
      return;
    }
    const buttons = confirm.simple
      ? `<button class="btn primary" data-action="confirm-no" data-autofocus data-focusable data-key="ok">${labels.ok}</button>`
      : `<button class="btn primary" data-action="confirm-yes" data-autofocus data-focusable data-key="yes">${labels.confirm}</button><button class="btn ghost" data-action="confirm-no" data-focusable data-key="no">${labels.cancel}</button>`;
    const details = Array.isArray(confirm.details) && confirm.details.length
      ? `<p class="plantitle">${esc(confirm.detailsTitle || labels.uninstallPlan)}</p><ul class="plan">${confirm.details.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
      : "";
    const warnings = Array.isArray(confirm.warnings) && confirm.warnings.length
      ? `<p class="plantitle">${labels.uninstallWarnings}</p><ul class="plan warning">${confirm.warnings.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
      : "";
    overlay.innerHTML = `<div class="panel" style="width:min(60vw,680px)">
      <h2>${esc(confirm.title)}</h2>
      <p>${esc(confirm.message)}</p>
      ${details}
      ${warnings}
      <div class="actions">${buttons}</div>
    </div>`;
  }

  function focusView(): void {
    const scope = overlay.classList.contains("hidden") ? main : overlay;
    const target = scope.querySelector<HTMLElement>("[data-autofocus]") || scope.querySelector<HTMLElement>("[data-focusable]");
    if (target) target.focus();
  }

  function render(): void {
    const active = document.activeElement;
    const activeKey = active && active.closest("#main, #overlay") ? active.getAttribute("data-key") : null;
    if (activeKey) S.focusKey = activeKey;
    pc.classList.toggle("online", !!S.data?.pc?.online);
    const pcLabel = pc.querySelector("span:last-child");
    if (pcLabel) pcLabel.textContent = S.data?.pc?.online ? labels.pcOnline : labels.pcOffline;
    content.classList.toggle("wide", S.view === "storage");
    renderUpdateButton();
    if (S.confirm) { renderConfirm(); return focusView(); }
    if (S.download) { renderDownloadSheet(); return focusView(); }
    if (S.view === "storage") { renderStorage(); return focusView(); }
    if (S.view === "details") { renderDetails(); return focusView(); }
    overlay.classList.add("hidden");
    if (S.offline || S.error) return renderOffline();
    const packs = S.data?.packs || [];
    if (!packs.length) return renderNoPacks();
    renderHome();
    const key = S.focusKey;
    const target = key ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
    if (target) target.focus();
    else document.querySelector<HTMLElement>("[data-autofocus]")?.focus() || document.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }

  function requestDownload(packId: string): void {
    S.download = { packId };
    S.view = "home";
    render();
  }

  async function startInstall(packId: string): Promise<void> {
    S.download = null;
    S.rate = [];
    try {
      const out = await api<{ jobId: string }>("/api/install", { method: "POST", body: JSON.stringify({ packId }) });
      S.job = { id: out.jobId, packId, status: "running", phase: "preparing", done: 0, total: 0, bytesDone: 0, bytesTotal: 0, log: [] };
      S.view = "home";
      await acquireWakeLock();
      render();
      await pollJob(out.jobId);
    } catch (err) {
      S.job = { packId, status: "error", error: messageOf(err), done: 0, total: 0, bytesDone: 0, bytesTotal: 0, log: [messageOf(err)] };
      render();
    }
  }

  async function cancelDownload(): Promise<void> {
    if (!S.job || S.job.status !== "running" || !S.job.id) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(S.job.id)}/cancel`, { method: "POST", body: "{}" });
    } catch (err) {
      S.confirm = { title: labels.couldNotCancel, message: messageOf(err), simple: true };
      render();
    }
  }

  async function pollJob(id: string): Promise<void> {
    const pack = selectedPack();
    const packName = pack?.name || labels.packTitle;
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
            S.confirm = { title: labels.installedTitle, message: labels.installedMessage(packName, packVersion), simple: true };
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
            S.confirm = { title: labels.downloadPausedTitle, message: labels.downloadPausedMessage, simple: true };
            render();
            setTimeout(() => { S.confirm = null; render(); }, 4000);
            return;
          }
          render();
        } catch (err) {
          S.error = messageOf(err);
          render();
          return;
        }
        await sleep(1000);
      }
    } finally {
      S.polling = false;
    }
  }

  async function launch(packId: string): Promise<void> {
    S.download = null;
    S.view = "home";
    try {
      await api("/api/launch", { method: "POST", body: JSON.stringify({ packId }) });
      S.confirm = { title: labels.launchingTitle, message: labels.launchingMessage(selectedPack()?.name || labels.packTitle), simple: true };
      render();
      setTimeout(() => { S.confirm = null; refresh(); }, 4000);
    } catch (err) {
      S.confirm = { title: labels.couldNotLaunch, message: messageOf(err), simple: true };
      render();
    }
  }

  async function openDetails(packId: string): Promise<void> {
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

  async function rollback(packId: string): Promise<void> {
    showConfirm({ title: labels.rollingBackTitle, message: labels.rollingBackMessage, busy: true });
    try {
      const out = await api<{ previous: string }>("/api/rollback", { method: "POST", body: JSON.stringify({ packId }) });
      S.view = "home";
      await refresh();
      showConfirm({ title: labels.rolledBackTitle, message: labels.rolledBackMessage(out.previous), simple: true }, 3000);
    } catch (err) {
      showConfirm({ title: labels.rollbackFailed, message: messageOf(err), simple: true });
    }
  }

  async function confirmCheck(packId: string, checkId: string): Promise<void> {
    try {
      await api("/api/preconditions/confirm", {
        method: "POST",
        body: JSON.stringify({ packId, checkId, confirmed: true }),
      });
      await refresh();
    } catch (err) {
      S.confirm = { title: labels.couldNotConfirm, message: messageOf(err), simple: true };
      render();
    }
  }

  app.addEventListener("click", (event: MouseEvent) => {
    const target = event.target as Element | null;
    const gameTile = target?.closest("[data-game]");
    if (gameTile) { openGame(gameTile.getAttribute("data-game") || ""); return; }
    const tile = target?.closest("[data-select]");
    if (tile) { selectPack(tile.getAttribute("data-select") || ""); return; }
    const el = target?.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    const packId = el.getAttribute("data-pack") || S.selected || "";
    if (action === "all-games") { S.libraryView = "games"; render(); }
    else if (action === "download") requestDownload(packId);
    else if (action === "start-download") startInstall(packId);
    else if (action === "cancel-download") cancelDownload();
    else if (action === "dismiss-job") { S.job = null; S.view = "home"; render(); }
    else if (action === "close-download") { S.download = null; S.view = "home"; render(); }
    else if (action === "storage") openStorage();
    else if (action === "update-app") requestAppUpdate();
    else if (action === "close-storage") { S.view = "home"; render(); }
    else if (action === "storage-clear") requestStorageClear(packId, el.getAttribute("data-scope") || "", Number(el.getAttribute("data-bytes") || 0));
    else if (action === "launch") launch(packId);
    else if (action === "details") openDetails(packId);
    else if (action === "retry" || action === "refresh") refresh();
    else if (action === "close-details") { S.view = "home"; render(); }
    else if (action === "open-logs") openDetails(packId);
    else if (action === "rollback") {
      const p = selectedPack();
      const prev = p?.versions?.[(p.versions.length || 0) - 2];
      showConfirm({ title: "Roll back?", message: `Switch to ${prev || "the previous version"}? The current version stays on disk.`, packId });
    }
    else if (action === "uninstall") {
      const p = selectedPack();
      if (p) requestStorageClear(p.id, "pack", p.totalBytes || 0);
    }
    else if (action === "confirm-check") confirmCheck(packId, el.getAttribute("data-check") || "");
    else if (action === "confirm-yes") {
      const confirm = S.confirm;
      if (!confirm) return;
      if (confirm.appUpdate) { installAppUpdate(); return; }
      dismissConfirm();
      if (confirm.storage) clearStorageData(confirm.storage);
      else if (confirm.packId) rollback(confirm.packId);
    }
    else if (action === "confirm-no") { if (S.confirm?.busy) return; dismissConfirm(); }
  });

  function focusables(): HTMLElement[] {
    return $$<HTMLElement>("[data-focusable]").filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  }

  function moveFocus(direction: number): void {
    const list = focusables();
    if (!list.length) return;
    const active = document.activeElement;
    let i = list.indexOf(active as HTMLElement);
    if (i < 0) i = 0;
    else i = (i + direction + list.length) % list.length;
    list[i].focus();
    list[i].scrollIntoView({ block: "nearest" });
  }

  function activate(): void {
    const active = document.activeElement as HTMLElement | null;
    if (active && active.matches("[data-focusable]")) active.click();
  }

  function back() {
    if (S.confirm) { dismissConfirm(); return; }
    if (S.download) { S.download = null; render(); return; }
    if (S.view === "storage") { S.view = "home"; render(); return; }
    if (S.view === "details") { S.view = "home"; render(); return; }
    if (S.libraryView === "packs") { S.libraryView = "games"; render(); return; }
  }

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    // Installing and closing are not cancellable: nothing behind or on the
    // overlay may take a press while the download runs or the app quits.
    if (S.confirm && S.confirm.busy) { event.preventDefault(); return; }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    else if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); back(); }
    else if (event.key.toLowerCase() === "b") { back(); }
    else if (event.key.toLowerCase() === "d") { if (S.selected) openDetails(S.selected); }
    else if (event.key.toLowerCase() === "r") refresh();
  });

  // Controller-first: D-pad/left stick moves focus, A activates, B backs, X details, Y refreshes.
  const pad: { held: Record<string, boolean>; lastMove: number } = { held: {}, lastMove: 0 };
  function pollPad(): void {
    if (S.confirm && S.confirm.busy) return;
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gps && gps[0];
    if (!gp) return;
    const now = Date.now();
    const btn = (i: number) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const pressed: Record<string, boolean> = { up: btn(12), down: btn(13), left: btn(14), right: btn(15), a: btn(0), b: btn(1), x: btn(2), y: btn(3), start: btn(9) };
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

  document.title = labels.appName;
  $(".brand .word").textContent = labels.appName;
  $(".brand .chip").textContent = labels.livingRoom;
  $("#storage-btn").textContent = labels.storage;
  $("#pc span:last-child").textContent = labels.pc;
  $(".footer .note").textContent = labels.footer;

  refresh();
  if (desktop) setTimeout(checkDesktopUpdate, 1200);
})();
