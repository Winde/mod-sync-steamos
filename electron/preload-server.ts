import { contextBridge, ipcRenderer } from "electron";

const api = {
  version: (): Promise<string> => ipcRenderer.invoke("modsync:version"),
  openReleases: (): Promise<void> => ipcRenderer.invoke("modsync:releases"),
  pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke("modsync:pick-folder", title),
};

contextBridge.exposeInMainWorld("modsyncDesktop", api);
