import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import labels from "./labels";
import { api, fmtBytes, groupGames, messageOf, rateInfo, sleep } from "./api";
import {
  ConfirmPanel,
  DetailsPanel,
  DownloadSheet,
  Hero,
  Library,
  NoPacksView,
  OfflineView,
  ProgressView,
  StorageView,
} from "./parts";
import type {
  AgentStateView,
  ConfirmView,
  JobView,
  PackView,
  StorageView as StorageReport,
  UpdateInfo,
  WakeLockLike,
} from "./types";

type ViewName = "home" | "details" | "storage";
type LibraryMode = "games" | "packs";

export default function App() {
  const [data, setData] = useState<AgentStateView | null>(null);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [selectedGameState, setSelectedGameState] = useState<string | null>(null);
  const [libraryViewState, setLibraryViewState] = useState<LibraryMode>("games");
  const [viewState, setViewState] = useState<ViewName>("home");
  const [jobState, setJobState] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmView | null>(null);
  const [details, setDetails] = useState<{ logs?: string } | null>(null);
  const [downloadState, setDownloadState] = useState<{ packId: string } | null>(null);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [rate, setRate] = useState<{ speed: number; eta: number | null }>({ speed: 0, eta: null });

  const selectedRef = useRef<string | null>(null);
  const selectedGameRef = useRef<string | null>(null);
  const libraryViewRef = useRef<LibraryMode>("games");
  const viewRef = useRef<ViewName>("home");
  const jobRef = useRef<JobView | null>(null);
  const confirmRef = useRef<ConfirmView | null>(null);
  const downloadRef = useRef<{ packId: string } | null>(null);
  const selectedPackRef = useRef<PackView | null>(null);
  const pollingRef = useRef(false);
  const rateRef = useRef<Array<{ t: number; b: number }>>([]);
  const wakeLockRef = useRef<WakeLockLike | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const focusKeyRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const canRefreshRef = useRef(true);
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});

  const setSelected = (id: string | null) => {
    selectedRef.current = id;
    setSelectedState(id);
  };
  const setSelectedGame = (id: string | null) => {
    selectedGameRef.current = id;
    setSelectedGameState(id);
  };
  const setLibraryView = (mode: LibraryMode) => {
    libraryViewRef.current = mode;
    setLibraryViewState(mode);
  };
  const setView = (next: ViewName) => {
    viewRef.current = next;
    setViewState(next);
  };
  const setJob = (next: JobView | null) => {
    jobRef.current = next;
    setJobState(next);
  };
  const setConfirm = (next: ConfirmView | null) => {
    confirmRef.current = next;
    setConfirmState(next);
  };
  const setDownload = (next: { packId: string } | null) => {
    downloadRef.current = next;
    setDownloadState(next);
  };

  const showConfirm = useCallback((next: ConfirmView, timeout = 0) => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirm(next);
    if (timeout > 0) {
      confirmTimer.current = window.setTimeout(() => {
        confirmTimer.current = null;
        setConfirm(null);
      }, timeout);
    }
  }, []);

  const dismissConfirm = useCallback(() => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirm(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api<AgentStateView>("/api/state");
      const packs = next.packs || [];
      const groups = groupGames(packs);
      const remoteOffline = next.pc?.online === false && packs.length === 0;
      setData(next);
      setOffline(remoteOffline);
      setError(remoteOffline ? next.pc?.error || labels.offlineTitle : null);

      let gameId = selectedGameRef.current;
      if (!gameId || !groups.some((group) => group.id === gameId)) gameId = groups[0]?.id ?? null;
      if (gameId !== selectedGameRef.current) setSelectedGame(gameId);

      if (!selectedRef.current || !packs.some((pack) => pack.id === selectedRef.current)) {
        const group = groups.find((entry) => entry.id === gameId);
        const pick = group?.packs.find((pack) => pack.installed) || group?.packs[0] || packs[0];
        setSelected(pick?.id ?? null);
        if (pick) setSelectedGame(pick.game.id);
      }
      if (libraryViewRef.current === "packs" && !groups.some((group) => group.id === selectedGameRef.current)) {
        setLibraryView("games");
      }

      if (next.job && next.job.status === "running" && !pollingRef.current) {
        try {
          const running = await api<JobView>(`/api/jobs/${encodeURIComponent(next.job.id || "")}`);
          setJob(running);
        } catch {
          setJob(next.job);
        }
      } else if (!pollingRef.current && jobRef.current && jobRef.current.status === "running") {
        setJob(next.job || null);
      }
    } catch (err) {
      setError(messageOf(err));
      setOffline(true);
    }
  }, []);

  const packs = data?.packs || [];
  const groups = useMemo(() => groupGames(packs), [packs]);
  const selectedPack = packs.find((pack) => pack.id === selectedState) || null;

  useEffect(() => {
    selectedPackRef.current = selectedPack;
  }, [selectedPack]);

  const hasOverlay = !!(confirmState || downloadState || (viewState === "details" && selectedPack));
  canRefreshRef.current = !confirmState && !downloadState && viewState !== "details" && viewState !== "storage" && !pollingRef.current;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (canRefreshRef.current) void refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (jobState && jobState.status === "running" && jobState.phase !== "verify") {
      setRate(rateInfo(jobState, rateRef.current));
    }
  }, [jobState]);

  useEffect(() => {
    document.title = labels.appName;
  }, []);

  // Preserve focus within the main/overlay surface as React replaces nodes.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      const keyed = target?.closest?.("[data-key]");
      if (keyed) focusKeyRef.current = keyed.getAttribute("data-key");
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    const scope = hasOverlay ? overlayRef.current : mainRef.current;
    if (!scope) return;
    const key = focusKeyRef.current;
    let target: HTMLElement | null = null;
    if (key) {
      const quoted = key.replace(/["\\]/g, "\\$&");
      target = (hasOverlay ? scope : document).querySelector<HTMLElement>(`[data-key="${quoted}"]`);
    }
    if (!target) target = scope.querySelector<HTMLElement>("[data-autofocus]");
    if (!target) target = scope.querySelector<HTMLElement>("[data-focusable]");
    target?.focus();
  });

  const acquireWakeLock = useCallback(async () => {
    try {
      if (!("wakeLock" in navigator) || wakeLockRef.current) return;
      const lock = await navigator.wakeLock.request("screen");
      wakeLockRef.current = lock;
      lock.addEventListener("release", () => { wakeLockRef.current = null; });
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try { await wakeLockRef.current?.release(); } catch { /* ignore */ }
    wakeLockRef.current = null;
  }, []);

  const pollJob = async (id: string): Promise<void> => {
    const pack = selectedPackRef.current;
    const packName = pack?.name || labels.packTitle;
    const packVersion = pack?.mod?.version || "";
    pollingRef.current = true;
    rateRef.current = [];
    try {
      while (true) {
        try {
          const next = await api<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
          setJob(next);
          if (next.status === "done") {
            await releaseWakeLock();
            await refresh();
            showConfirm({ title: labels.installedTitle, message: labels.installedMessage(packName, packVersion), simple: true }, 3500);
            return;
          }
          if (next.status === "error") {
            await releaseWakeLock();
            return;
          }
          if (next.status === "canceled") {
            await releaseWakeLock();
            setJob(null);
            await refresh();
            showConfirm({ title: labels.downloadPausedTitle, message: labels.downloadPausedMessage, simple: true }, 4000);
            return;
          }
        } catch (err) {
          setError(messageOf(err));
          return;
        }
        await sleep(1000);
      }
    } finally {
      pollingRef.current = false;
    }
  };

  const requestDownload = (packId: string) => {
    setDownload({ packId });
    setView("home");
  };

  const startInstall = async (packId: string) => {
    setDownload(null);
    rateRef.current = [];
    try {
      const out = await api<{ jobId: string }>("/api/install", { method: "POST", body: JSON.stringify({ packId }) });
      setJob({ id: out.jobId, packId, status: "running", phase: "preparing", done: 0, total: 0, bytesDone: 0, bytesTotal: 0, log: [] });
      setView("home");
      await acquireWakeLock();
      await pollJob(out.jobId);
    } catch (err) {
      setJob({ packId, status: "error", error: messageOf(err), done: 0, total: 0, bytesDone: 0, bytesTotal: 0, log: [messageOf(err)] });
    }
  };

  const cancelDownload = async () => {
    if (!jobRef.current || jobRef.current.status !== "running" || !jobRef.current.id) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(jobRef.current.id)}/cancel`, { method: "POST", body: "{}" });
    } catch (err) {
      showConfirm({ title: labels.couldNotCancel, message: messageOf(err), simple: true });
    }
  };

  const launch = async (packId: string) => {
    setDownload(null);
    setView("home");
    try {
      await api("/api/launch", { method: "POST", body: JSON.stringify({ packId }) });
      showConfirm({ title: labels.launchingTitle, message: labels.launchingMessage(selectedPackRef.current?.name || labels.packTitle), simple: true });
      window.setTimeout(() => { setConfirm(null); void refresh(); }, 4000);
    } catch (err) {
      showConfirm({ title: labels.couldNotLaunch, message: messageOf(err), simple: true });
    }
  };

  const openDetails = async (packId: string) => {
    const pack = packs.find((entry) => entry.id === packId);
    if (pack) {
      setSelected(pack.id);
      setSelectedGame(pack.game?.id || selectedGameRef.current);
    }
    setView("details");
    setDetails({ logs: "" });
    try {
      const logs = await fetch("/api/logs").then((res) => res.text());
      setDetails({ logs });
    } catch { /* logs are best-effort */ }
  };

  const rollback = async (packId: string) => {
    showConfirm({ title: labels.rollingBackTitle, message: labels.rollingBackMessage, busy: true });
    try {
      const out = await api<{ previous: string }>("/api/rollback", { method: "POST", body: JSON.stringify({ packId }) });
      setView("home");
      await refresh();
      showConfirm({ title: labels.rolledBackTitle, message: labels.rolledBackMessage(out.previous), simple: true }, 3000);
    } catch (err) {
      showConfirm({ title: labels.rollbackFailed, message: messageOf(err), simple: true });
    }
  };

  const confirmCheck = async (packId: string, checkId: string) => {
    try {
      await api("/api/preconditions/confirm", { method: "POST", body: JSON.stringify({ packId, checkId, confirmed: true }) });
      await refresh();
    } catch (err) {
      showConfirm({ title: labels.couldNotConfirm, message: messageOf(err), simple: true });
    }
  };

  const openStorage = async () => {
    setView("storage");
    setStorage({ loading: true });
    focusKeyRef.current = "storage-back";
    try {
      setStorage(await api<StorageReport>("/api/storage"));
    } catch (err) {
      setStorage({ error: messageOf(err) });
    }
  };

  const requestStorageClear = async (packId: string, scope: string, bytes: number) => {
    const pack = (storage?.packs || []).find((entry) => entry.id === packId) || selectedPackRef.current;
    const amount = fmtBytes(bytes);
    let title: string;
    let message: string;
    if (scope === "pack") {
      title = labels.removePackTitle(pack ? pack.name : labels.packTitle);
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
          showConfirm({ title: labels.uninstallBlocked, message: "", detailsTitle: labels.uninstallBlockedMessage, details: plan.errors, simple: true });
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
  };

  const clearStorageData = async ({ packId, scope }: { packId?: string; scope: string }) => {
    const fromDetails = viewRef.current === "details";
    showConfirm({
      title: scope === "pack" ? labels.uninstallingTitle : labels.clearingTitle,
      message: scope === "pack" ? labels.uninstallingMessage : labels.clearingMessage,
      busy: true,
    });
    try {
      const out = await api<{ storage?: StorageReport; freedBytes?: number }>("/api/storage/clear", {
        method: "POST",
        body: JSON.stringify({ packId, scope }),
      });
      if (out.storage) setStorage(out.storage);
      if (scope === "pack" && fromDetails) {
        setView("home");
        setSelected(null);
      }
      await refresh();
      showConfirm({ title: labels.clearedTitle, message: labels.freedMessage(fmtBytes(out.freedBytes)), simple: true }, 3000);
    } catch (err) {
      showConfirm({ title: labels.couldNotClear, message: messageOf(err), simple: true });
    }
  };

  const requestAppUpdate = () => {
    const desktop = window.modsyncDesktop;
    if (!update || !update.available || !update.latest) return;
    if (!update.canInstall) {
      void desktop?.openReleases?.();
      return;
    }
    showConfirm({ title: labels.updateTitle(update.latest), message: labels.updateMessage, appUpdate: true });
  };

  const checkForUpdates = async () => {
    const desktop = window.modsyncDesktop;
    if (!desktop?.checkUpdate || checkingUpdate) return;
    setCheckingUpdate(true);
    showConfirm({ title: labels.checkingUpdatesTitle, message: labels.checkingUpdatesMessage, busy: true });
    try {
      const info = await desktop.checkUpdate();
      if (!info) throw new Error(labels.updateCheckFailedMessage);
      if (info.error) {
        showConfirm({ title: labels.updateCheckFailed, message: info.error, simple: true });
        return;
      }
      setUpdate(info);
      if (!info.available || !info.latest) {
        showConfirm({ title: labels.updateUpToDateTitle, message: labels.updateUpToDateMessage(info.current), simple: true }, 3000);
        return;
      }
      if (!info.canInstall) {
        showConfirm({ title: labels.updateAvailableTitle(info.latest), message: labels.updateAvailableMessage, simple: true });
        void desktop.openReleases?.();
        return;
      }
      showConfirm({ title: labels.updateTitle(info.latest), message: labels.updateMessage, appUpdate: true });
    } catch (err) {
      showConfirm({ title: labels.updateCheckFailed, message: messageOf(err), simple: true });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const installAppUpdate = async () => {
    const desktop = window.modsyncDesktop;
    const latest = update?.latest;
    if (!update || !desktop || !latest) return;
    showConfirm({ title: labels.updateInstallingTitle, message: labels.updateInstallingMessage(latest), busy: true });
    try {
      await desktop.installUpdate();
      showConfirm({ title: labels.updateClosingTitle, message: labels.updateClosingMessage(latest), busy: true });
    } catch (err) {
      showConfirm({ title: labels.updateFailed, message: messageOf(err), simple: true });
    }
  };

  const openGame = (gameId: string) => {
    const game = groups.find((entry) => entry.id === gameId);
    if (!game) return;
    setSelectedGame(game.id);
    const pick = game.packs.find((pack) => pack.installed) || game.packs[0];
    if (pick) setSelected(pick.id);
    setLibraryView("packs");
  };

  const selectPack = (packId: string) => {
    const pack = packs.find((entry) => entry.id === packId);
    if (!pack) return;
    setSelected(pack.id);
    setSelectedGame(pack.game?.id || selectedGameRef.current);
    setLibraryView("packs");
  };

  const uninstall = () => {
    const pack = selectedPackRef.current;
    if (pack) void requestStorageClear(pack.id, "pack", pack.totalBytes || 0);
  };

  const handleConfirmYes = () => {
    const confirm = confirmRef.current;
    if (!confirm) return;
    if (confirm.appUpdate) {
      void installAppUpdate();
      return;
    }
    dismissConfirm();
    if (confirm.storage) void clearStorageData(confirm.storage);
    else if (confirm.packId) void rollback(confirm.packId);
  };

  const moveFocus = (direction: number) => {
    const scope = hasOverlay ? overlayRef.current : document;
    if (!scope) return;
    const list = [...scope.querySelectorAll<HTMLElement>("[data-focusable]")]
      .filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
    if (!list.length) return;
    const active = document.activeElement;
    let index = list.indexOf(active as HTMLElement);
    if (index < 0) index = 0;
    else index = (index + direction + list.length) % list.length;
    list[index].focus();
    list[index].scrollIntoView({ block: "nearest" });
  };

  const activate = () => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active.matches("[data-focusable]")) active.click();
  };

  const back = () => {
    if (confirmRef.current) { dismissConfirm(); return; }
    if (downloadRef.current) { setDownload(null); return; }
    if (viewRef.current === "storage" || viewRef.current === "details") { setView("home"); return; }
    if (libraryViewRef.current === "packs") setLibraryView("games");
  };

  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (confirmRef.current?.busy) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    else if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); back(); }
    else if (event.key.toLowerCase() === "b") back();
    else if (event.key.toLowerCase() === "d") { if (selectedRef.current) void openDetails(selectedRef.current); }
    else if (event.key.toLowerCase() === "r") void refresh();
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const pad = useRef<{ held: Record<string, boolean>; lastMove: number }>({ held: {}, lastMove: 0 });
  const padHandlerRef = useRef<() => void>(() => {});
  padHandlerRef.current = () => {
    if (confirmRef.current?.busy) return;
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads && gamepads[0];
    if (!gp) return;
    const now = Date.now();
    const button = (index: number) => !!(gp.buttons[index] && gp.buttons[index].pressed);
    const pressed: Record<string, boolean> = {
      up: button(12), down: button(13), left: button(14), right: button(15),
      a: button(0), b: button(1), x: button(2), y: button(3), start: button(9),
    };
    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    if (!pressed.up && ay < -0.65) pressed.up = true;
    if (!pressed.down && ay > 0.65) pressed.down = true;
    if (!pressed.left && ax < -0.65) pressed.left = true;
    if (!pressed.right && ax > 0.65) pressed.right = true;
    for (const [key, value] of Object.entries(pressed)) {
      if (value && !pad.current.held[key]) {
        if (key === "up" || key === "left") {
          if (now - pad.current.lastMove > 140) { moveFocus(-1); pad.current.lastMove = now; }
        } else if (key === "down" || key === "right") {
          if (now - pad.current.lastMove > 140) { moveFocus(1); pad.current.lastMove = now; }
        } else if (key === "a") activate();
        else if (key === "b") back();
        else if (key === "x") { if (selectedRef.current) void openDetails(selectedRef.current); }
        else if (key === "y" || key === "start") void refresh();
      }
      pad.current.held[key] = value;
    }
  };
  useEffect(() => {
    const timer = window.setInterval(() => padHandlerRef.current(), 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && jobRef.current?.status === "running") void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  const free = data?.diskFreeBytes;
  const storageBtnText = free != null ? labels.storageWithFree(`${(free / 1024 / 1024 / 1024).toFixed(2)}`) : labels.storage;
  const detailsPack = viewState === "details" ? selectedPack : null;
  const downloadPack = downloadState ? packs.find((pack) => pack.id === downloadState.packId) || selectedPack : null;

  let mainContent: ReactNode;
  let libraryContent: ReactNode = null;
  if (viewState === "storage") {
    mainContent = <StorageView storage={storage} onClose={() => setView("home")} onClear={(packId, scope, bytes) => { void requestStorageClear(packId, scope, bytes); }} />;
  } else if (offline || error) {
    mainContent = <OfflineView detail={error} onRetry={() => { void refresh(); }} />;
  } else if (!packs.length) {
    mainContent = <NoPacksView onRetry={() => { void refresh(); }} />;
  } else if (!selectedPack) {
    mainContent = <NoPacksView onRetry={() => { void refresh(); }} />;
  } else if (jobState && (jobState.status === "running" || jobState.status === "error")) {
    mainContent = (
      <ProgressView
        job={jobState}
        pack={selectedPack}
        rate={rate}
        onRetry={() => { const packId = jobState.packId; if (packId) void startInstall(packId); }}
        onDismiss={() => { setJob(null); setView("home"); }}
        onCancel={() => { void cancelDownload(); }}
      />
    );
  } else {
    mainContent = (
      <Hero
        pack={selectedPack}
        offline={data?.pc?.online === false}
        onAction={(action, packId) => {
          if (action === "download") requestDownload(packId);
          else if (action === "launch") void launch(packId);
        }}
        onDetails={() => { void openDetails(selectedPack.id); }}
        onLaunch={() => { void launch(selectedPack.id); }}
        onRollback={() => {
          const previous = selectedPack.versions?.[(selectedPack.versions.length || 0) - 2];
          showConfirm({ title: labels.rollBackTitle, message: labels.rollBackMessage(previous || labels.noPreviousVersion), packId: selectedPack.id });
        }}
        onUninstall={uninstall}
        onRefresh={() => { void refresh(); }}
      />
    );
    libraryContent = (
      <Library
        data={data}
        groups={groups}
        selectedGame={selectedGameState}
        selected={selectedState}
        libraryView={libraryViewState}
        onOpenGame={openGame}
        onSelectPack={selectPack}
        onAllGames={() => setLibraryView("games")}
        onStorage={() => { void openStorage(); }}
      />
    );
  }

  if (viewState === "details") libraryContent = null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img className="appicon" src="/icon.png" alt="" />
          <div className="word">{labels.appName}</div>
          <span className="chip">{labels.livingRoom}</span>
        </div>
        <div className="topright">
          <button
            id="update-btn"
            className={`chip chipbtn${window.modsyncDesktop?.checkUpdate ? "" : " hidden"}`}
            data-action="update-app"
            data-focusable
            data-key="update"
            disabled={checkingUpdate}
            onClick={() => {
              if (update?.available) requestAppUpdate();
              else void checkForUpdates();
            }}
          >
            {checkingUpdate
              ? labels.checkingUpdates
              : update?.available && update.latest
                ? labels.updateTo(update.latest)
                : labels.checkForUpdates}
          </button>
          <button id="storage-btn" className="chip chipbtn" data-action="storage" data-focusable data-key="storage" onClick={() => { void openStorage(); }}>
            {storageBtnText}
          </button>
          <div id="pc" className={`pc${data?.pc?.online ? " online" : ""}`}>
            <span className="dot" />
            <span>{data?.pc?.online ? labels.pcOnline : labels.pcOffline}</span>
          </div>
        </div>
      </header>
      <div className={`content${viewState === "storage" ? " wide" : ""}`}>
        <main id="main" className="main" ref={mainRef}>{mainContent}</main>
        <aside id="library" className="library">{libraryContent}</aside>
      </div>
      <footer className="footer">
        <div className="note">{labels.footer}</div>
      </footer>
      <div id="overlay" ref={overlayRef} className={`overlay${hasOverlay ? "" : " hidden"}`}>
        {confirmState ? (
          <ConfirmPanel confirm={confirmState} onYes={handleConfirmYes} onNo={() => { if (!confirmState.busy) dismissConfirm(); }} />
        ) : downloadState && downloadPack ? (
          <DownloadSheet
            pack={downloadPack}
            data={data}
            onStart={() => { void startInstall(downloadPack.id); }}
            onLaunch={() => { void launch(downloadPack.id); }}
            onClose={() => { setDownload(null); setView("home"); }}
            onConfirm={(packId, checkId) => { void confirmCheck(packId, checkId); }}
          />
        ) : detailsPack ? (
          <DetailsPanel
            pack={detailsPack}
            logs={details?.logs || ""}
            onClose={() => setView("home")}
            onRollback={() => {
              const previous = detailsPack.versions?.[(detailsPack.versions.length || 0) - 2];
              showConfirm({ title: labels.rollBackTitle, message: labels.rollBackMessage(previous || labels.noPreviousVersion), packId: detailsPack.id });
            }}
            onUninstall={() => { void requestStorageClear(detailsPack.id, "pack", detailsPack.totalBytes || 0); }}
            onRefreshLogs={() => { void openDetails(detailsPack.id); }}
            onConfirm={(packId, checkId) => { void confirmCheck(packId, checkId); }}
          />
        ) : null}
      </div>
    </div>
  );
}
