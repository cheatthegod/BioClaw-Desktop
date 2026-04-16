/**
 * Electron preload script — exposes a safe IPC bridge to the renderer.
 *
 * The renderer (setup-wizard.html) can call:
 *   window.electronAPI.invoke('channel', ...args)
 *   window.electronAPI.on('channel', callback)
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const sub = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
