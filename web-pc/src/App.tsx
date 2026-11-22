import { useCallback, useEffect, useRef, useState } from "react";
import { api, chooseImageFile, copyText, desktopBridge, fileToDataUrl, messageOf, randomToken } from "./api";
import {
  BuildModal,
  DevicesPanel,
  EditPackModal,
  GuidePanel,
  Header,
  PackLibrary,
  RemoveModal,
  ServerPanel,
  SettingsPanel,
  Toasts,
  UpdateModal,
} from "./components";
import type {
  BuildFormState,
  BuildJobState,
  BuildStartOptions,
  ConsoleState,
  DeviceState,
  ModalState,
  PackState,
  SettingsDraft,
  SettingsState,
  ToastItem,
  UpdateInfo,
  UpdateProgress,
} from "./types";

function toDraft(settings: SettingsState): SettingsDraft {
  return {
    packsDir: settings.packsDir,
    bind: settings.bind === "loopback" || settings.bind === "host" ? settings.bind : "lan",
    host: settings.host,
    port: String(settings.port),
    token: settings.token,
    autoStart: settings.autoStart,
    launchAtLogin: settings.launchAtLogin,
    minimizeToTray: settings.minimizeToTray,
  };
}

function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return a.packsDir === b.packsDir
    && a.bind === b.bind
    && a.host === b.host
    && a.port === b.port
    && a.token === b.token
    && a.autoStart === b.autoStart
    && a.launchAtLogin === b.launchAtLogin
    && a.minimizeToTray === b.minimizeToTray;
}

export default function App() {
  const [data, setData] = useState<ConsoleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [buildView, setBuildView] = useState(false);
  const [buildRecipeId, setBuildRecipeId] = useState<string | undefined>(undefined);
  const [buildPackId, setBuildPackId] = useState<string | undefined>(undefined);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updatePrompt, setUpdatePrompt] = useState<UpdateInfo | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const lastBuildStatus = useRef<string | null>(null);
  const settingsBase = useRef<SettingsDraft | null>(null);
  const toastId = useRef(0);

  const toast = useCallback((message: string, tone: ToastItem["tone"] = "neutral") => {
    const id = ++toastId.current;
    setToasts((items) => [...items, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, tone === "error" ? 6500 : 4000);
  }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onUpdateProgress) return;
    return bridge.onUpdateProgress((progress) => setUpdateProgress(progress));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api<ConsoleState>("/api/state");
      const previous = lastBuildStatus.current;
      const incoming = toDraft(next.settings);
      setData(next);
      setError(null);
      setSettingsDraft((draft) => {
        if (!draft) return incoming;
        // Follow changes made elsewhere only while the form has no unsaved edits.
        return settingsBase.current && sameDraft(draft, settingsBase.current) ? incoming : draft;
      });
      settingsBase.current = incoming;
      lastBuildStatus.current = next.build?.status || null;
      if (previous === "running" && next.build?.status === "done") toast("Build finished. The server sees the new pack now.", "success");
      if (previous === "running" && next.build?.status === "error") toast(next.build.error || "Build failed.", "error");
    } catch (err) {
      setError(messageOf(err));
    }
  }, [toast]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const tick = async () => {
      await refresh();
      if (!active) return;
      timer = window.setTimeout(() => { void tick(); }, lastBuildStatus.current === "running" ? 900 : 3500);
    };
    void tick();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const copy = async (text: string, label: string) => {
    const ok = await copyText(text);
    toast(ok ? `${label} copied` : `Could not copy ${label.toLowerCase()}`, ok ? "success" : "error");
  };

  const toggleServer = async () => {
    if (!data) return;
    const running = data.server.running;
    setBusy(true);
    try {
      await api(running ? "/api/server/stop" : "/api/server/start", { method: "POST" });
      toast(running ? "Server stopped." : "Server started.", "success");
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const saveSettings = async () => {
    if (!settingsDraft) return;
    const port = Number(settingsDraft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast("Port must be a number from 1 to 65535.", "error");
      return;
    }
    if (!settingsDraft.token.trim()) {
      toast("Token cannot be empty.", "error");
      return;
    }
    setSaving(true);
    setSaved("");
    try {
      const next = await api<ConsoleState>("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          packsDir: settingsDraft.packsDir.trim(),
          bind: settingsDraft.bind,
          host: settingsDraft.host.trim(),
          port,
          token: settingsDraft.token.trim(),
          autoStart: settingsDraft.autoStart,
          launchAtLogin: settingsDraft.launchAtLogin,
          minimizeToTray: settingsDraft.minimizeToTray,
        }),
      });
      const nextDraft = toDraft(next.settings);
      setData(next);
      setSettingsDraft(nextDraft);
      settingsBase.current = nextDraft;
      setSaved("Saved.");
      toast("Settings saved.", "success");
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = (patch: Partial<SettingsDraft>) => {
    setSaved("");
    setSettingsDraft((draft) => {
      if (!draft) return draft;
      const next = { ...draft, ...patch };
      if (patch.bind === "host" && !next.host) next.host = data?.lan.detected || "";
      return next;
    });
  };

  const openBuild = (recipeId?: string, packId?: string) => {
    setBuildRecipeId(recipeId);
    setBuildPackId(packId);
    setBuildView(data?.build?.status === "running");
    setModal({ kind: "build" });
  };

  const openRemove = (pack: PackState) => {
    setBuildView(false);
    setModal({ kind: "remove", pack });
  };

  const openEdit = (pack: PackState) => {
    setBuildView(false);
    setModal({ kind: "edit", pack });
  };

  const savePackEdits = async (input: { name: string; notes: string; rating: number; review: string }) => {
    if (!modal || modal.kind !== "edit") return;
    const pack = modal.pack;
    const builtInName = pack.baseName || pack.name;
    const name = input.name.trim() === builtInName ? "" : input.name.trim();
    const notes = input.notes.trim();
    const previousName = pack.baseName && pack.name !== pack.baseName ? pack.name : "";
    const previousNotes = (pack.notes || "").trim();
    const previousRating = pack.review?.rating || 0;
    const previousReview = (pack.review?.body || "").trim();
    const libraryChanged = name !== previousName || notes !== previousNotes;
    const reviewChanged = input.rating !== previousRating || input.review.trim() !== previousReview;
    if (!libraryChanged && !reviewChanged) {
      setModal(null);
      return;
    }
    setBusy(true);
    try {
      if (libraryChanged) {
        await api(`/api/packs/${encodeURIComponent(pack.id)}/library`, {
          method: "POST",
          body: JSON.stringify({ name, notes: input.notes }),
        });
      }
      if (reviewChanged) {
        await api("/api/reviews", {
          method: "POST",
          body: JSON.stringify({ gameId: pack.game.id, modId: pack.mod.id, rating: input.rating, body: input.review }),
        });
      }
      setModal(null);
      toast("Pack details saved.", "success");
      await refresh();
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const updatePacks = (packs: PackState[]) => {
    setData((current) => current ? { ...current, packs } : current);
  };

  const pickPackImage = async (pack: PackState): Promise<string | null> => {
    setBusy(true);
    try {
      const bridge = desktopBridge();
      let body: { path?: string; data?: string };
      if (bridge?.pickImage) {
        const picked = await bridge.pickImage("Choose a pack image");
        if (!picked) return null;
        body = { path: picked };
      } else {
        const file = await chooseImageFile();
        if (!file) return null;
        body = { data: await fileToDataUrl(file) };
      }
      const result = await api<{ packs: PackState[] }>(`/api/packs/${encodeURIComponent(pack.id)}/image`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      updatePacks(result.packs);
      toast("Pack image updated.", "success");
      return result.packs.find((entry) => entry.id === pack.id)?.artUrl || null;
    } catch (err) {
      toast(messageOf(err), "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const clearPackImage = async (pack: PackState): Promise<string | null> => {
    setBusy(true);
    try {
      const result = await api<{ packs: PackState[] }>(`/api/packs/${encodeURIComponent(pack.id)}/image/clear`, {
        method: "POST",
      });
      updatePacks(result.packs);
      toast("Custom pack image removed.", "success");
      return result.packs.find((entry) => entry.id === pack.id)?.artUrl || null;
    } catch (err) {
      toast(messageOf(err), "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const startBuild = async (form: BuildFormState, options: BuildStartOptions = {}) => {
    if (!form.source.trim()) {
      toast("Choose the working install folder.", "error");
      return;
    }
    setBusy(true);
    try {
      const driverOptions: Record<string, string> = {};
      for (const [key, value] of Object.entries(form.driverOptions)) {
        const trimmed = value.trim();
        if (trimmed) driverOptions[key] = trimmed;
      }
      const job = await api<BuildJobState>("/api/build", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          packId: options.packId ?? form.packId,
          createNew: options.createNew === true,
          packName: options.packName,
          source: form.source.trim(),
          version: form.version.trim(),
          driverOptions,
        }),
      });
      setData((current) => current ? { ...current, build: job } : current);
      lastBuildStatus.current = job.status;
      setBuildView(true);
      toast("Build started.", "success");
      void refresh();
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const answerPair = async (id: string, action: "approve" | "deny") => {
    setPairBusy(true);
    try {
      await api(`/api/pair/${action}`, { method: "POST", body: JSON.stringify({ id }) });
      await refresh();
      toast(action === "approve" ? "TV approved." : "Pairing request denied.", action === "approve" ? "success" : "neutral");
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setPairBusy(false);
    }
  };

  const revokeDevice = async (device: DeviceState) => {
    setDeviceBusy(true);
    try {
      const result = await api<{ devices: DeviceState[] }>("/api/devices/revoke", {
        method: "POST",
        body: JSON.stringify({ id: device.id }),
      });
      setData((current) => current ? { ...current, devices: result.devices } : current);
      toast(`Revoked ${device.name}.`, "success");
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setDeviceBusy(false);
    }
  };

  const revokeAllDevices = async () => {
    if (!window.confirm("Revoke every paired device? Each TV will need to pair again.")) return;
    setDeviceBusy(true);
    try {
      const result = await api<{ devices: DeviceState[] }>("/api/devices/revoke-all", { method: "POST" });
      setData((current) => current ? { ...current, devices: result.devices } : current);
      toast("Revoked all paired devices.", "success");
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setDeviceBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!modal || modal.kind !== "remove") return;
    setBusy(true);
    try {
      await api("/api/packs/remove", { method: "POST", body: JSON.stringify({ id: modal.pack.id, confirm: true }) });
      setModal(null);
      toast("Pack removed.", "success");
      await refresh();
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const revealPack = async (id: string) => {
    try {
      await api(`/api/packs/${encodeURIComponent(id)}/reveal`, { method: "POST" });
    } catch (err) {
      toast(messageOf(err), "error");
    }
  };

  const revealPacksDir = async () => {
    try {
      await api("/api/reveal/packs", { method: "POST" });
    } catch (err) {
      toast(messageOf(err), "error");
    }
  };

  const applyPacksFolder = async (dir: string) => {
    setSaving(true);
    try {
      const next = await api<ConsoleState>("/api/settings", {
        method: "POST",
        body: JSON.stringify({ packsDir: dir }),
      });
      const serverDraft = toDraft(next.settings);
      setData(next);
      // Keep any other unsaved edits in the form; only adopt the saved folder.
      setSettingsDraft((draft) => draft ? { ...draft, packsDir: serverDraft.packsDir } : serverDraft);
      settingsBase.current = serverDraft;
      setSaved("");
      toast("Packs folder changed.", "success");
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const browsePacks = async () => {
    const picked = await desktopBridge()?.pickFolder?.("Choose packs folder");
    if (!picked) return;
    updateDraft({ packsDir: picked });
    await applyPacksFolder(picked);
  };

  const changePacksFolder = async () => {
    const pickFolder = desktopBridge()?.pickFolder;
    if (!pickFolder) {
      // In a browser (or without the desktop bridge) the settings field is the
      // only way to type a path, so take the user straight to it.
      const input = document.getElementById("packs-dir") as HTMLInputElement | null;
      input?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      input?.focus();
      input?.select();
      return;
    }
    const picked = await pickFolder("Choose packs folder");
    if (picked) await applyPacksFolder(picked);
  };

  const checkForUpdates = async () => {
    const bridge = desktopBridge();
    if (!bridge?.checkUpdate || checkingUpdate) return;
    setCheckingUpdate(true);
    setUpdateProgress(null);
    try {
      const info = await bridge.checkUpdate();
      if (!info) {
        toast("Could not check for updates.", "error");
        return;
      }
      if (info.error) {
        toast(info.error, "error");
        return;
      }
      setUpdateInfo(info);
      if (info.available && info.latest) {
        toast(`Update ${info.latest} is available.`, "neutral");
      } else {
        toast(`ModSync Server ${info.current} is up to date.`, "success");
      }
    } catch (err) {
      toast(messageOf(err), "error");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const requestUpdate = () => {
    const bridge = desktopBridge();
    if (!updateInfo) return;
    if (updateInfo.canInstall && bridge?.installUpdate) {
      setUpdateProgress(null);
      setUpdatePrompt(updateInfo);
      return;
    }
    void bridge?.openReleases?.();
  };

  const installUpdate = async () => {
    const bridge = desktopBridge();
    if (!bridge?.installUpdate || !updatePrompt) return;
    setUpdateProgress({ phase: "download", received: 0, total: null });
    setInstallingUpdate(true);
    try {
      await bridge.installUpdate();
    } catch (err) {
      setInstallingUpdate(false);
      setUpdateProgress(null);
      toast(messageOf(err), "error");
    }
  };

  const closeModal = () => {
    setModal(null);
    setBuildView(false);
  };

  return (
    <>
      <div className="app">
        <Header data={data} busy={busy} onToggleServer={() => { void toggleServer(); }} />
        <main className="layout">
          <PackLibrary
            data={data}
            error={error}
            job={data?.build || null}
            pairBusy={pairBusy}
            busy={busy}
            onRefresh={() => { void refresh(); }}
            onBuildNew={() => openBuild()}
            onRebuild={(pack) => openBuild(pack.recipeId || undefined, pack.id)}
            onReveal={(id) => { void revealPack(id); }}
            onRemove={openRemove}
            onEdit={openEdit}
            onPickImage={(pack) => { void pickPackImage(pack); }}
            onShowBuild={() => openBuild(data?.build?.recipeId, data?.build?.packId)}
            onChangeFolder={() => { void changePacksFolder(); }}
            onApprovePair={(id) => { void answerPair(id, "approve"); }}
            onDenyPair={(id) => { void answerPair(id, "deny"); }}
          />
          <aside className="side">
            <ServerPanel
              data={data}
              onCopyUrl={() => { void copy(data?.server.url || "", "Server URL"); }}
              onOpenUrl={() => {
                const url = data?.server.url;
                if (url) window.open(url, "_blank", "noopener");
              }}
              onGoToSettings={() => {
                document.querySelector(".settingsform")?.scrollIntoView({ behavior: "smooth", block: "start" });
                document.getElementById("server-token")?.focus();
              }}
            />
            <DevicesPanel
              data={data}
              busy={deviceBusy}
              onRevoke={(device) => { void revokeDevice(device); }}
              onRevokeAll={() => { void revokeAllDevices(); }}
            />
            {settingsDraft && data ? (
              <SettingsPanel
                draft={settingsDraft}
                data={data}
                saving={saving}
                saved={saved}
                onChange={updateDraft}
                onBrowsePacks={() => { void browsePacks(); }}
                onRevealPacks={() => { void revealPacksDir(); }}
                onGenerateToken={() => updateDraft({ token: randomToken() })}
                onSave={() => { void saveSettings(); }}
              />
            ) : (
              <section className="panel"><p className="muted">Loading settings…</p></section>
            )}
            <GuidePanel
              data={data}
              onCopyInstall={() => { void copy(data?.guide.installCommand || "", "Install command"); }}
              onCopyManualInstall={() => { void copy(data?.guide.manualInstallCommand || "", "Manual install command"); }}
              onCopyFirewall={() => { void copy(data?.guide.firewallCommand || "", "Firewall command"); }}
            />
          </aside>
        </main>
        <footer className="footer">
          <span>Mods only · LAN only · no port forwarding</span>
          <span className="footerend">
            {updateInfo?.available && updateInfo.latest ? (
              <button
                id="open-releases"
                className="btn small"
                type="button"
                title={updateInfo.canInstall && desktopBridge()?.installUpdate ? "Download and install the update" : "Open the releases page"}
                onClick={requestUpdate}
              >{updateInfo.canInstall && desktopBridge()?.installUpdate ? `Install ${updateInfo.latest}` : `Update ${updateInfo.latest}`}</button>
            ) : null}
            {desktopBridge()?.checkUpdate ? (
              <button
                id="check-updates"
                className="btn small"
                type="button"
                disabled={checkingUpdate}
                onClick={() => { void checkForUpdates(); }}
              >{checkingUpdate ? "Checking…" : "Check for updates"}</button>
            ) : null}
            <span id="build-footer">{data ? `ModSync Server ${data.app.version}` : ""}</span>
          </span>
        </footer>
      </div>
      {modal?.kind === "build" && data ? (
        <BuildModal
          data={data}
          job={data.build}
          viewJob={buildView}
          initialRecipeId={buildRecipeId}
          initialPackId={buildPackId}
          busy={busy}
          onStart={(form, options) => { void startBuild(form, options); }}
          onClose={closeModal}
          onReveal={(id) => { void revealPack(id); }}
          onBuildAnother={() => setBuildView(false)}
        />
      ) : null}
      {modal?.kind === "remove" ? (
        <RemoveModal
          pack={modal.pack}
          busy={busy}
          onConfirm={() => { void confirmRemove(); }}
          onClose={closeModal}
        />
      ) : null}
      {modal?.kind === "edit" ? (
        <EditPackModal
          pack={modal.pack}
          busy={busy}
          onSave={(input) => { void savePackEdits(input); }}
          onPickImage={pickPackImage}
          onClearImage={clearPackImage}
          onClose={closeModal}
        />
      ) : null}
      {updatePrompt ? (
        <UpdateModal
          info={updatePrompt}
          installing={installingUpdate}
          progress={updateProgress}
          onInstall={() => { void installUpdate(); }}
          onClose={() => { setUpdatePrompt(null); setUpdateProgress(null); }}
        />
      ) : null}
      <Toasts items={toasts} />
    </>
  );
}
