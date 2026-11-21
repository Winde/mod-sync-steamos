import { contextBridge, ipcRenderer } from "electron";

const api = {
  version: (): Promise<string> => ipcRenderer.invoke("modsync:version"),
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("modsync:update-check"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("modsync:update-install"),
  openReleases: (): Promise<void> => ipcRenderer.invoke("modsync:releases"),
  pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke("modsync:pick-folder", title),
};

contextBridge.exposeInMainWorld("modsyncDesktop", api);
