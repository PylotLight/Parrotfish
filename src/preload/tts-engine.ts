// Preload for the hidden Phonon engine window: a two-way message bridge, nothing else.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("parrotfishEngine", {
  onCommand(callback: (command: unknown) => void): void {
    ipcRenderer.on("tts-engine:command", (_event, command: unknown) =>
      callback(command),
    );
  },
  send(event: unknown): void {
    ipcRenderer.send("tts-engine:event", event);
  },
});
