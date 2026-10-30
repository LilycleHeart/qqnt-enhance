// QQ 增强 · preload：给界面开主进程接口
// preload 每页可能跑两次，重复 expose 会报错，先查一下
const { contextBridge, ipcRenderer } = require("electron");
const P = "LiteLoader.qq_enhance.";

const api = {
    getConfig: () => ipcRenderer.invoke(P + "getConfig"),
    setConfig: patch => ipcRenderer.invoke(P + "setConfig", patch),
    onConfigChanged: cb => { ipcRenderer.on(P + "configChanged", (_e, cfg) => cb(cfg)); },
    recalledList: () => ipcRenderer.invoke(P + "recalledList"),
    onRecalled: cb => { ipcRenderer.on(P + "recalled", (_e, id, nick) => cb(id, nick)); },
    stats: () => ipcRenderer.invoke(P + "stats"),
    clearSaved: () => ipcRenderer.invoke(P + "clearSaved"),
    repeat: msg => ipcRenderer.invoke(P + "repeat", msg),
    stickerList: () => ipcRenderer.invoke(P + "stickerList"),
    stickerFav: (file, on) => ipcRenderer.invoke(P + "stickerFav", file, on),
    stickerSend: (peer, file, hint) => ipcRenderer.invoke(P + "stickerSend", peer, file, hint),
    stickerOpenDir: () => ipcRenderer.invoke(P + "stickerOpenDir"),
    stickerPickDir: () => ipcRenderer.invoke(P + "stickerPickDir"),
};

const exists = contextBridge.executeInMainWorld({ func: key => key in globalThis, args: ["qq_enhance"] });
if (!exists) contextBridge.exposeInMainWorld("qq_enhance", api);
