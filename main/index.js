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
const { ipcMain, BrowserWindow } = require("electron");

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
};

const DEFAULTS = { antiRecall: true, chatPos: true, repeat: true, quoteNoAt: true };

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
    for (const k of Object.keys(DEFAULTS)) if (patch && typeof patch[k] === "boolean") next[k] = patch[k];
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
function invokeNT(webContentsId, cmdName, args) {
    return new Promise(resolve => {
        const callbackId = crypto.randomUUID();
        const timer = setTimeout(() => resolve({ pending: true }), 5000);
        const fakeEvent = {
            sender: {
                id: webContentsId,
                isDestroyed: () => false,
                send: (_channel, meta, result) => {
                    if (meta && meta.callbackId === callbackId) { clearTimeout(timer); resolve(result); }
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

log("main loaded | qqnt=" + LiteLoader.versions.qqnt + " recalled=" + recalled.size + " config=" + JSON.stringify(config));

module.exports = {
    onBrowserWindowCreated(window) {
        try { hookWindow(window); } catch (e) { log("hook failed: " + e.message); }
    },
};
