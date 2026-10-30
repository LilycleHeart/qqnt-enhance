// QQ 增强 · 主进程
//   设置：存在 LiteLoader 配置里（data\qq-enhance\config.json），界面改了就广播给所有窗口
//   防撤回：思路照搬 BetterQQNT 的 AntiRecallPlugin
//     1. 拦截主进程发给界面的内核消息（webContents.send，频道含 RM_IPCFROM_）
//     2. 普通消息记在内存（最近 5000 条）
//     3. 遇到被撤回的灰条消息，用记下的原内容换掉灰条，并把原文落盘
//     4. 撤回更新事件（onMsgInfoListUpdate 等）整条拦掉，界面上的原消息不动
//     5. 通知界面给这条消息打「已撤回」标记
//   复读：调内核 forwardMsgWithComment，把消息原样转发回当前会话（同 BetterQQNT「复读 +1」）
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ipcMain, BrowserWindow, shell, dialog } = require("electron");

const SLUG = "qq-enhance";
const DATA = path.join(LiteLoader.path.data, SLUG);
const AR_DIR = path.join(DATA, "anti-recall");
const MSG_DIR = path.join(AR_DIR, "messages");
const RECALLED_FILE = path.join(AR_DIR, "recalled.json");
const LOG = path.join(DATA, "plugin.log");

const CH = {
    getConfig: "LiteLoader.qq_enhance.getConfig",
    setConfig: "LiteLoader.qq_enhance.setConfig",
    configChanged: "LiteLoader.qq_enhance.configChanged",
    recalledList: "LiteLoader.qq_enhance.recalledList",
    recalled: "LiteLoader.qq_enhance.recalled",
    stats: "LiteLoader.qq_enhance.stats",
    clearSaved: "LiteLoader.qq_enhance.clearSaved",
    repeat: "LiteLoader.qq_enhance.repeat",
    stickerList: "LiteLoader.qq_enhance.stickerList",
    stickerFav: "LiteLoader.qq_enhance.stickerFav",
    stickerSend: "LiteLoader.qq_enhance.stickerSend",
    stickerOpenDir: "LiteLoader.qq_enhance.stickerOpenDir",
    stickerPickDir: "LiteLoader.qq_enhance.stickerPickDir",
};

const DEFAULTS = { antiRecall: true, chatPos: true, repeat: true, quoteNoAt: true, stickers: true, stickerDir: "" };

fs.mkdirSync(MSG_DIR, { recursive: true });

function log(message) {
    try { fs.appendFileSync(LOG, new Date().toISOString() + " " + message + "\n"); } catch (e) {}
}

/* ---------- 从旧的独立「防撤回」插件搬数据（只搬一次） ---------- */
(function migrate() {
    const old = path.join(LiteLoader.path.data, "anti-recall");
    try {
        if (!fs.existsSync(old) || fs.existsSync(path.join(AR_DIR, ".migrated"))) return;
        const oldMsgs = path.join(old, "messages");
        if (fs.existsSync(oldMsgs)) {
            for (const f of fs.readdirSync(oldMsgs)) {
                const dst = path.join(MSG_DIR, f);
                if (!fs.existsSync(dst)) fs.copyFileSync(path.join(oldMsgs, f), dst);
            }
        }
        const oldList = path.join(old, "recalled.json");
        if (fs.existsSync(oldList) && !fs.existsSync(RECALLED_FILE)) fs.copyFileSync(oldList, RECALLED_FILE);
        fs.writeFileSync(path.join(AR_DIR, ".migrated"), new Date().toISOString());
        log("migrated data from anti-recall");
    } catch (e) { log("migrate failed: " + e.message); }
})();

/* ---------- 设置 ---------- */
let config = Object.assign({}, DEFAULTS);
try { config = Object.assign({}, DEFAULTS, LiteLoader.api.config.get(SLUG, DEFAULTS) || {}); } catch (e) {}

function broadcast(channel, ...args) {
    for (const w of BrowserWindow.getAllWindows()) {
        try { if (!w.isDestroyed()) w.webContents.send(channel, ...args); } catch (e) {}
    }
}

ipcMain.handle(CH.getConfig, () => config);
ipcMain.handle(CH.setConfig, (_e, patch) => {
    const next = Object.assign({}, config);
    for (const k of Object.keys(DEFAULTS)) if (patch && typeof patch[k] === typeof DEFAULTS[k]) next[k] = patch[k];
    config = next;
    try { LiteLoader.api.config.set(SLUG, config); } catch (e) { log("save config failed: " + e.message); }
    broadcast(CH.configChanged, config);
    log("config " + JSON.stringify(config));
    return config;
});

/* ---------- 防撤回：存储 ---------- */
const MAX_CACHE = 5000;
const MAX_RECALLED = 3000;
const UPDATE_CMDS = new Set([
    "nodeIKernelMsgListener/onMsgInfoListUpdate",
    "nodeIKernelMsgListener/onActiveMsgInfoUpdate",
]);

const cache = new Map();          // msgId -> 消息副本
const recalled = new Map();       // msgId -> 撤回人
try {
    const saved = JSON.parse(fs.readFileSync(RECALLED_FILE, "utf8"));
    for (const [id, nick] of Object.entries(saved)) recalled.set(id, nick);
} catch (e) {}

let saveTimer = null;
function saveRecalled() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        while (recalled.size > MAX_RECALLED) recalled.delete(recalled.keys().next().value);
        try { fs.writeFileSync(RECALLED_FILE, JSON.stringify(Object.fromEntries(recalled))); } catch (e) { log("save recalled failed: " + e.message); }
    }, 500);
}

const safeId = id => String(id).replace(/[^0-9A-Za-z_-]/g, "");
const clone = v => JSON.parse(JSON.stringify(v));

function remember(msg) {
    const id = String(msg.msgId);
    if (cache.has(id)) cache.delete(id);
    cache.set(id, clone(msg));
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

function lookup(id) {
    id = String(id);
    if (cache.has(id)) return cache.get(id);
    const file = path.join(MSG_DIR, safeId(id) + ".json");
    try {
        if (fs.existsSync(file)) {
            const msg = JSON.parse(fs.readFileSync(file, "utf8"));
            cache.set(id, msg);
            return msg;
        }
    } catch (e) {}
    return null;
}

function persist(msg) {
    const file = path.join(MSG_DIR, safeId(msg.msgId) + ".json");
    if (fs.existsSync(file)) return;
    fs.writeFile(file, JSON.stringify(msg), () => {});
}

ipcMain.handle(CH.recalledList, () => Object.fromEntries(recalled));
ipcMain.handle(CH.stats, () => {
    let files = 0, bytes = 0;
    try { for (const f of fs.readdirSync(MSG_DIR)) { files++; bytes += fs.statSync(path.join(MSG_DIR, f)).size; } } catch (e) {}
    return { saved: files, bytes, recalled: recalled.size, cached: cache.size };
});
ipcMain.handle(CH.clearSaved, () => {
    let n = 0;
    try { for (const f of fs.readdirSync(MSG_DIR)) { fs.unlinkSync(path.join(MSG_DIR, f)); n++; } } catch (e) {}
    recalled.clear();
    saveRecalled();
    log("cleared " + n + " saved messages");
    broadcast(CH.configChanged, config);
    return n;
});

/* ---------- 防撤回：消息处理 ---------- */
function revokeOf(msg) {
    const els = msg && msg.elements;
    if (!Array.isArray(els)) return null;
    for (const el of els) {
        const rv = el && el.grayTipElement && el.grayTipElement.revokeElement;
        if (rv) return rv;
    }
    return null;
}

// 只放过「自己撤回自己的消息」（保留 QQ 的「重新编辑」）；自己用管理员身份撤回别人的照样还原。
function isOwnRecall(rv) {
    if (!rv.isSelfOperate) return false;
    const op = rv.operatorUid, orig = rv.origMsgSenderUid;
    if (!orig || !op) return true;
    return String(op) === String(orig);
}

// 在参数里找所有 msgList 数组（事件和接口返回的结构不同，统一按字段找）
function findMsgLists(value, depth, out) {
    if (!value || typeof value !== "object" || depth > 4) return out;
    if (Array.isArray(value)) {
        for (const v of value) findMsgLists(v, depth + 1, out);
        return out;
    }
    if (Array.isArray(value.msgList)) out.push(value.msgList);
    for (const k of ["payload", "result", "data"]) {
        if (value[k] && typeof value[k] === "object") findMsgLists(value[k], depth + 1, out);
    }
    return out;
}

// 返回 true 表示整条发送要拦掉
function handle(args) {
    if (!config.antiRecall) return false;
    const cmd = args && args[1] && args[1].cmdName;
    const lists = findMsgLists(args, 0, []);
    if (!lists.length) return false;

    let restoredAll = true, touched = 0;
    for (const list of lists) {
        for (const msg of list) {
            if (!msg || msg.msgId === undefined) continue;
            touched++;
            const rv = revokeOf(msg);
            if (!rv) { remember(msg); restoredAll = false; continue; }
            if (isOwnRecall(rv)) { restoredAll = false; continue; }

            const id = String(msg.msgId);
            const old = lookup(id);
            if (!old || !Array.isArray(old.elements) || revokeOf(old)) { restoredAll = false; continue; }

            const nick = rv.isSelfOperate ? "你" : (rv.operatorMemRemark || rv.operatorRemark || rv.operatorNick || "对方");
            const copy = clone(old);                      // 副本：QQ 之后原地改对象也不影响缓存
            for (const k of Object.keys(copy)) msg[k] = copy[k];
            persist(old);
            if (!recalled.has(id)) {
                recalled.set(id, nick);
                saveRecalled();
                log("recalled " + id + " by " + nick + " via " + (cmd || "response"));
            }
            setTimeout(() => broadcast(CH.recalled, id, nick), 100);
        }
    }
    return touched > 0 && restoredAll && UPDATE_CMDS.has(cmd);
}

function hookWindow(window) {
    const wc = window.webContents;
    if (wc.__qqEnhanceHooked) return;
    wc.__qqEnhanceHooked = true;
    const send = wc.send;
    wc.send = function (channel, ...args) {
        if (typeof channel === "string" && channel.includes("RM_IPCFROM_")) {
            // 自己发起的内核调用（invokeNT），回包走的是真窗口：认出来就收下，不转给界面
            const meta = args[0];
            if (meta && meta.callbackId && pendingNT.has(meta.callbackId)) {
                const done = pendingNT.get(meta.callbackId);
                pendingNT.delete(meta.callbackId);
                done(args[1]);
                return;
            }
            try { if (handle(args)) return; }
            catch (e) { log("handle error: " + (e && e.stack || e)); }
        }
        return send.call(this, channel, ...args);
    };
}

/* ---------- 调内核接口（复读用） ----------
 * 模仿渲染进程的请求：频道 RM_IPCFROM_RENDERER<id>，
 * {type:"request", callbackId, eventName:"ntApi", peerId} + {cmdName, cmdType:"invoke", payload}。
 * 格式参照 BetterQQNT 的 invokeNTApi 与本机实测（QQ 9.9.36）。
 * 回包不一定走假 sender，超时不算失败。 */
const pendingNT = new Map();      // callbackId -> resolve
function invokeNT(webContentsId, cmdName, args) {
    return new Promise(resolve => {
        const callbackId = crypto.randomUUID();
        const finish = v => { clearTimeout(timer); pendingNT.delete(callbackId); resolve(v); };
        const timer = setTimeout(() => { pendingNT.delete(callbackId); resolve({ pending: true }); }, 5000);
        pendingNT.set(callbackId, finish);
        const fakeEvent = {
            sender: {
                id: webContentsId,
                isDestroyed: () => false,
                send: (_channel, meta, result) => {
                    if (meta && meta.callbackId === callbackId) finish(result);
                },
            },
        };
        ipcMain.emit("RM_IPCFROM_RENDERER" + webContentsId, fakeEvent,
            { type: "request", callbackId, eventName: "ntApi", peerId: webContentsId },
            { cmdName, cmdType: "invoke", payload: args });
    });
}

ipcMain.handle(CH.repeat, async (event, msg) => {
    if (!config.repeat) return { error: "复读已关闭" };
    try {
        if (!msg || !msg.msgId) return { error: "no msg" };
        const contact = { chatType: msg.chatType, peerUid: msg.peerUid, guildId: msg.guildId || "" };
        const res = await invokeNT(event.sender.id, "nodeIKernelMsgService/forwardMsgWithComment", [{
            msgIds: [String(msg.msgId)],
            srcContact: contact,
            dstContacts: [contact],
            commentElements: [],
            msgAttributeInfos: new Map(),
        }, null]);
        log("repeat " + msg.msgId + " -> " + JSON.stringify(res).slice(0, 200));
        return res;
    } catch (e) {
        log("repeat failed: " + e.message);
        return { error: e.message };
    }
});

/* ---------- 本地表情包 ----------
 * 表情文件夹：根目录下的每个子文件夹是一组（子文件夹里再往下的图也算这一组），
 * 根目录里直接放的图归「未分组」。收藏单独存一份路径表，和文件夹无关。
 * 发送照 BetterQQNT 的本地表情：问内核要富媒体路径 → 把图拷过去 → sendMsg 一个 picElement。 */
const DEFAULT_STICKER_DIR = path.join(DATA, "stickers");
const FAV_FILE = path.join(DATA, "sticker-favs.json");
const STICKER_CACHE = path.join(DATA, "sticker-cache");
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const MAX_PER_GROUP = 2000;

function stickerRoot() {
    const dir = (config.stickerDir || "").trim();
    return dir ? path.resolve(dir) : DEFAULT_STICKER_DIR;
}
try { fs.mkdirSync(DEFAULT_STICKER_DIR, { recursive: true }); } catch (e) {}

let favs = [];
try { favs = JSON.parse(fs.readFileSync(FAV_FILE, "utf8")).filter(x => typeof x === "string"); } catch (e) { favs = []; }
function saveFavs() {
    try { fs.writeFileSync(FAV_FILE, JSON.stringify(favs)); } catch (e) { log("save favs failed: " + e.message); }
}

const extOf = p => path.extname(p).slice(1).toLowerCase();
const byName = (a, b) => a.localeCompare(b, "zh-CN", { numeric: true });

function collectImages(dir, out, depth) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    ents.sort((a, b) => byName(a.name, b.name));
    for (const e of ents) {
        if (out.length >= MAX_PER_GROUP) break;
        const full = path.join(dir, e.name);
        if (e.isFile() && IMG_EXT.has(extOf(e.name))) out.push(full);
        else if (e.isDirectory() && depth > 0 && !e.name.startsWith(".")) collectImages(full, out, depth - 1);
    }
    return out;
}

function listStickers() {
    const root = stickerRoot();
    const groups = [];
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {}
    const loose = ents.filter(e => e.isFile() && IMG_EXT.has(extOf(e.name))).map(e => path.join(root, e.name)).sort(byName);
    for (const e of ents.filter(e => e.isDirectory() && !e.name.startsWith(".")).sort((a, b) => byName(a.name, b.name))) {
        const files = collectImages(path.join(root, e.name), [], 4);
        if (files.length) groups.push({ name: e.name, files });
    }
    if (loose.length) groups.push({ name: "未分组", files: loose.slice(0, MAX_PER_GROUP) });
    const existing = favs.filter(f => fs.existsSync(f));
    return { root, groups, favs: existing, isDefault: !config.stickerDir };
}

function insideRoot(p) {
    try {
        const root = fs.realpathSync(stickerRoot());
        const real = fs.realpathSync(p);
        const rel = path.relative(root, real);
        return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    } catch (e) { return false; }
}

// 读图片头拿宽高（png / gif / jpg / webp / bmp），读不出就用界面传来的
function imageSize(buf) {
    try {
        if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
        if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
        if (buf.length > 26 && buf.toString("ascii", 0, 2) === "BM") return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
        if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
            const kind = buf.toString("ascii", 12, 16);
            if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
            if (kind === "VP8L") { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
            if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
        }
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let i = 2;
            while (i + 9 < buf.length) {
                if (buf[i] !== 0xff) { i++; continue; }
                const m = buf[i + 1];
                if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
                i += 2 + buf.readUInt16BE(i + 2);
            }
        }
    } catch (e) {}
    return null;
}

ipcMain.handle(CH.stickerList, () => listStickers());

ipcMain.handle(CH.stickerFav, (_e, p, on) => {
    if (typeof p !== "string") return favs;
    favs = favs.filter(x => x !== p);
    if (on && insideRoot(p)) favs.unshift(p);
    saveFavs();
    broadcast(CH.configChanged, config);
    return favs;
});

ipcMain.handle(CH.stickerOpenDir, () => {
    const root = stickerRoot();
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
    return shell.openPath(root);
});

ipcMain.handle(CH.stickerPickDir, async event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, { title: "选择表情包文件夹", defaultPath: stickerRoot(), properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    config = Object.assign({}, config, { stickerDir: res.filePaths[0] });
    try { LiteLoader.api.config.set(SLUG, config); } catch (e) {}
    broadcast(CH.configChanged, config);
    return config;
});

ipcMain.handle(CH.stickerSend, async (event, peer, file, hint) => {
    if (!config.stickers) return { error: "本地表情包已关闭" };
    try {
        if (!peer || !peer.peerUid || typeof file !== "string") return { error: "没有找到当前会话" };
        if (!IMG_EXT.has(extOf(file)) || !(insideRoot(file) || favs.includes(file))) return { error: "只能发送表情文件夹里的图片" };
        const buf = fs.readFileSync(file);
        const md5 = crypto.createHash("md5").update(buf).digest("hex");
        const ext = extOf(file) === "jpeg" ? "jpg" : extOf(file);
        const size = imageSize(buf) || { w: Number(hint && hint.w) || 200, h: Number(hint && hint.h) || 200 };
        const fileName = md5 + "." + ext;

        const wcId = event.sender.id;
        let dst = await invokeNT(wcId, "nodeIKernelMsgService/getRichMediaFilePathForGuild", [{
            path_info: { md5HexStr: md5, fileName, elementType: 2, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" },
        }, null]);
        if (typeof dst !== "string" || !dst) {
            log("sticker: no rich media path (" + JSON.stringify(dst).slice(0, 120) + "), use cache");
            fs.mkdirSync(STICKER_CACHE, { recursive: true });
            dst = path.join(STICKER_CACHE, fileName);
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (!fs.existsSync(dst)) fs.copyFileSync(file, dst);

        const pic = {
            elementType: 2, elementId: "",
            picElement: {
                fileName, fileSize: String(buf.length), fileSubId: "", fileUuid: "", md5HexStr: md5,
                original: true, picWidth: size.w, picHeight: size.h,
                picSubType: 1, picType: ext === "gif" ? 2000 : 1001,
                sourcePath: dst, summary: "[动画表情]", thumbFileSize: 0,
            },
        };
        const res = await invokeNT(wcId, "nodeIKernelMsgService/sendMsg", [{
            msgId: "0",
            peer: { chatType: peer.chatType, peerUid: String(peer.peerUid), guildId: peer.guildId ? String(peer.guildId) : "" },
            msgElements: [pic],
            msgAttributeInfos: new Map(),
        }, null]);
        log("sticker " + path.basename(file) + " -> " + JSON.stringify(res).slice(0, 160));
        return res;
    } catch (e) {
        log("sticker failed: " + (e && e.stack || e));
        return { error: e.message };
    }
});

log("main loaded | qqnt=" + LiteLoader.versions.qqnt + " recalled=" + recalled.size + " config=" + JSON.stringify(config));

module.exports = {
    onBrowserWindowCreated(window) {
        try { hookWindow(window); } catch (e) { log("hook failed: " + e.message); }
    },
};
