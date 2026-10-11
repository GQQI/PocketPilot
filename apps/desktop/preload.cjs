"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const INVOKE = new Set(["state:get", "service:toggle", "pairing:new", "clipboard:write", "device:revoke", "settings:set", "config:get", "config:set", "dialog:folder", "shell:open"]);
const EVENTS = new Set(["state", "paired", "goto", "theme"]);

contextBridge.exposeInMainWorld("pp", {
  invoke: (channel, ...args) => (INVOKE.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error("blocked channel"))),
  on: (channel, callback) => {
    if (!EVENTS.has(channel)) return () => undefined;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
