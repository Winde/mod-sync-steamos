import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

const api = {
  version: (): Promise<string> => ipcRenderer.invoke("modsync:version"),
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("modsync:update-check"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("modsync:update-install"),
  onUpdateProgress: (callback: (progress: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: unknown): void => callback(progress);
    ipcRenderer.on("modsync:update-progress", listener);
    return () => { ipcRenderer.removeListener("modsync:update-progress", listener); };
  },
  openReleases: (): Promise<void> => ipcRenderer.invoke("modsync:releases"),
  pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke("modsync:pick-folder", title),
  pickImage: (title?: string): Promise<string | null> => ipcRenderer.invoke("modsync:pick-image", title),
};

contextBridge.exposeInMainWorld("modsyncDesktop", api);
