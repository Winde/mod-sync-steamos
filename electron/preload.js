const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("modsyncDesktop", {
  version: () => ipcRenderer.invoke("modsync:version"),
  checkUpdate: () => ipcRenderer.invoke("modsync:update-check"),
  installUpdate: () => ipcRenderer.invoke("modsync:update-install"),
  openReleases: () => ipcRenderer.invoke("modsync:releases"),
});
