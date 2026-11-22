import { contextBridge, ipcRenderer } from "electron";

const api = {
  version: (): Promise<string> => ipcRenderer.invoke("modsync:version"),
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("modsync:update-check"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("modsync:update-install"),
  openReleases: (): Promise<void> => ipcRenderer.invoke("modsync:releases"),
  quit: (): void => ipcRenderer.send("modsync:quit"),
};

contextBridge.exposeInMainWorld("modsyncDesktop", api);
