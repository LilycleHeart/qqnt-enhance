// 离线测试「防撤回」在快速撤回 / 后台会话 / 大批量事件下的行为契约。
// 用假 electron / 假 LiteLoader 原样加载 main/index.js，从 webContents.send 灌入内核事件。
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qqe-ar-race-"));
const handlers = {};
const kernelCalls = []; // 主进程反向调内核（invokeNT）的记录
const appHooks = {};
const fakeIpcMain = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: () => {},
    emit: (channel, ...args) => { kernelCalls.push({ channel, args }); return true; },
};

const mainWc = makeWc(2);
const fakeWin = { isDestroyed: () => false, webContents: mainWc };
const fakeElectron = {
    ipcMain: fakeIpcMain,
    app: { on: (name, fn) => { appHooks[name] = fn; } },
    webContents: { getAllWebContents: () => [mainWc] },
    BrowserWindow: { getAllWindows: () => [fakeWin] },
    shell: {},
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
    return req === "electron" ? fakeElectron : origLoad.call(this, req, ...rest);
};
global.LiteLoader = {
    path: { data: tmp },
    versions: { qqnt: "test" },
    api: { config: { get: (_s, d) => d, set: () => {} } },
};

const plugin = require(path.resolve(__dirname, "../main/index.js"));

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
    if (cond) { passed++; console.log("PASS " + name + (detail ? "  [" + detail + "]" : "")); }
    else { failed++; console.log("FAIL " + name + (detail ? "  [" + detail + "]" : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 <= timeout) {
        if (pred()) return Date.now() - t0;
        await sleep(5);
    }
    return -1;
}

function makeWc(id) {
    const wc = {
        id,
        sent: [],
        isDestroyed: () => false,
        on: () => {},
        executeJavaScript: () => Promise.resolve(),
        send(channel, ...args) { this.sent.push([channel, ...args]); },
    };
    wc.__rawSend = wc.send;
    return wc;
}

/* ---------- 构造消息 ---------- */
const textMsg = (id, content) => ({
    msgId: String(id), msgType: 2, chatType: 1, peerUid: "u_friend", guildId: "",
    elements: [{ elementType: 1, textElement: { content: content || ("原话 " + id) } }],
});
const revokeMsg = (id, nick, extra) => ({
    msgId: String(id), msgType: 5, chatType: 1, peerUid: "u_friend", guildId: "",
    elements: [{ elementType: 8, grayTipElement: { revokeElement: Object.assign({ operatorNick: nick || "张三", isSelfOperate: false }, extra || {}) } }],
});
const selfRevokeMsg = id => ({
    msgId: String(id), msgType: 5, chatType: 1, peerUid: "u_friend", guildId: "",
    elements: [{ elementType: 8, grayTipElement: { revokeElement: { isSelfOperate: true, operatorUid: "u_me", origMsgSenderUid: "u_me" } } }],
});
const adminRevokeMsg = id => ({
    msgId: String(id), msgType: 5, chatType: 1, peerUid: "u_friend", guildId: "",
    elements: [{ elementType: 8, grayTipElement: { revokeElement: { isSelfOperate: true, operatorUid: "u_me", origMsgSenderUid: "u_member" } } }],
});

/** 灌一条内核事件（模拟主进程发给界面） */
function emitEvent(wc, cmdName, payload) {
    wc.send("RM_IPCFROM_MAIN3", { type: "request", callbackId: "" }, { cmdName, payload });
}
const updateEvent = (wc, list) => emitEvent(wc, "nodeIKernelMsgListener/onMsgInfoListUpdate", { msgList: list });
const recvEvent = (wc, list) => emitEvent(wc, "nodeIKernelMsgListener/onRecvMsg", { msgList: list });
const delivered = (wc, cmdName) => wc.sent.filter(s => s[0] === "RM_IPCFROM_MAIN3" && s[2] && s[2].cmdName === cmdName).length;
const recalledIds = async () => Object.keys(await handlers["LiteLoader.qq_enhance.recalledList"]());
const stats = () => handlers["LiteLoader.qq_enhance.stats"]();
const getMsgCalls = () => kernelCalls.filter(k => k.args.some(a => a && a.cmdName === "nodeIKernelMsgService/getMsgsByMsgId")).length;

(async () => {
    plugin.onBrowserWindowCreated(fakeWin);

    /* ===== 1. 快速撤回：撤回事件先到，原文 30ms 后到 → 最终不显示灰条 ===== */
    {
        const before = mainWc.sent.length;
        updateEvent(mainWc, [revokeMsg(9001, "张三")]);
        await sleep(30);
        recvEvent(mainWc, [textMsg(9001, "这条会被撤回")]);
        await sleep(400);
        const deliveredRevoke = mainWc.sent.slice(before).filter(s => s[2] && s[2].payload && JSON.stringify(s[2].payload).includes('"9001"') && !JSON.stringify(s[2].payload).includes("这条会被撤回"));
        check("快速撤回：撤回更新没有以灰条形式送到界面", deliveredRevoke.length === 0, "漏出 " + deliveredRevoke.length + " 条");
        check("快速撤回：原文被还原并登记", (await recalledIds()).includes("9001"));
        check("快速撤回：原文落盘", fs.existsSync(path.join(tmp, "qq-enhance", "anti-recall", "messages", "9001.json")));
    }

    /* ===== 2. 内核静默：超时后必须放行，且不能压住 5 秒 ===== */
    {
        const before = mainWc.sent.length;
        const t0 = Date.now();
        updateEvent(mainWc, [revokeMsg(9002)]);
        const waited = await waitUntil(() => mainWc.sent.length > before, 3000);
        const elapsed = waited === -1 ? -1 : Date.now() - t0;
        check("内核静默时最终仍会放行", waited !== -1);
        check("放行延迟 ≤ 1200ms（不能被 5s 内核超时拖住）", elapsed !== -1 && elapsed <= 1200, elapsed + "ms");
        const replay = mainWc.sent.slice(before).find(s => s[2] && s[2].payload);
        check("放行的仍是 QQ 原来的灰条事件（不丢事件）", !!replay && JSON.stringify(replay[2].payload).includes("9002"));
    }

    /* ===== 3. 同批混入普通新消息：新消息不能被撤回等待连累 ===== */
    {
        const before = mainWc.sent.length;
        const t0 = Date.now();
        updateEvent(mainWc, [textMsg(9003, "新消息"), revokeMsg(9004)]);
        const waited = await waitUntil(() => mainWc.sent.length > before, 2000);
        const elapsed = waited === -1 ? -1 : Date.now() - t0;
        check("同批新消息正常送达", waited !== -1);
        check("同批新消息投递延迟 ≤ 200ms", elapsed !== -1 && elapsed <= 200, elapsed + "ms");
        check("同批新消息进入缓存", (await stats()).cached >= 1);
    }

    /* ===== 4. 单事件 120 条消息：不能有 80 条截断导致尾部撤回还原不了 ===== */
    {
        const list = [];
        for (let i = 0; i < 120; i++) list.push(textMsg(9100 + i));
        recvEvent(mainWc, list);
        const afterBatch = (await stats()).cached;
        check("120 条批次全部进缓存", afterBatch >= 120, "cached=" + afterBatch);
        const before = mainWc.sent.length;
        updateEvent(mainWc, [revokeMsg(9219)]);
        await sleep(250);
        check("批次尾部消息被撤回后能还原", (await recalledIds()).includes("9219"));
        const leaked = mainWc.sent.slice(before).filter(s => {
            const payload = s[2] && s[2].payload;
            return payload && JSON.stringify(payload).includes('"9219"') && !JSON.stringify(payload).includes("原话 9219");
        });
        check("尾部撤回没有回灌灰条", leaked.length === 0, "漏出 " + leaked.length + " 条");
    }

    /* ===== 5. 同批里「别人撤回」+「自己撤回」：自撤回必须照常送达 ===== */
    {
        recvEvent(mainWc, [textMsg(9005, "别人的消息")]);
        const before = mainWc.sent.length;
        updateEvent(mainWc, [selfRevokeMsg(9006), revokeMsg(9005, "李四")]);
        const waited = await waitUntil(() => mainWc.sent.length > before, 2000);
        check("自撤回与别人撤回同批时，事件仍送达界面", waited !== -1);
        check("同批里的别人撤回仍被还原", (await recalledIds()).includes("9005"));
    }

    /* ===== 6. 重复撤回只广播一次「已撤回」标记 ===== */
    {
        recvEvent(mainWc, [textMsg(9007, "重复撤回")]);
        const before = mainWc.sent.filter(s => s[0] === "LiteLoader.qq_enhance.recalled" && s[1] === "9007").length;
        updateEvent(mainWc, [revokeMsg(9007, "王五")]);
        updateEvent(mainWc, [revokeMsg(9007, "王五")]);
        await sleep(500);
        const count = mainWc.sent.filter(s => s[0] === "LiteLoader.qq_enhance.recalled" && s[1] === "9007").length - before;
        check("重复撤回不会重复向界面广播", count === 1, "broadcast=" + count);
    }

    /* ===== 7. 后台窗口：webContents-created 后新窗口也要生效 ===== */
    {
        const bgWc = makeWc(17);
        const handler = appHooks["web-contents-created"];
        check("已注册 web-contents-created", typeof handler === "function");
        if (typeof handler === "function") handler({}, bgWc);
        check("后台窗口的 send 被 hook", bgWc.send !== bgWc.__rawSend);
        recvEvent(bgWc, [textMsg(9008, "后台会话的消息")]);
        updateEvent(bgWc, [revokeMsg(9008, "后台撤回人")]);
        await sleep(300);
        check("后台窗口的撤回也被还原", (await recalledIds()).includes("9008"));
        check("后台窗口被标记为已 hook", bgWc.__qqEnhanceHooked === true);
    }

    /* ===== 8. 最近联系人预取：>12 跳过、≤12 按上限 8、5 秒内去重 ===== */
    {
        const mkEvent = n => {
            const list = [];
            for (let i = 0; i < n; i++) list.push({ msgId: "9200" + i, chatType: 1, peerUid: "u_prefetch_" + i });
            return { recentContactList: list };
        };
        const before = getMsgCalls();
        emitEvent(mainWc, "nodeIKernelMsgListener/onRecentContactListChangedVer2", mkEvent(13));
        await sleep(150);
        check("启动快照 >12 条时不做预取", getMsgCalls() - before === 0, "calls=" + (getMsgCalls() - before));
        emitEvent(mainWc, "nodeIKernelMsgListener/onRecentContactListChangedVer2", mkEvent(4));
        await sleep(150);
        check("≤12 条时按实际条数预取", getMsgCalls() - before === 4, "calls=" + (getMsgCalls() - before));
        emitEvent(mainWc, "nodeIKernelMsgListener/onRecentContactListChangedVer2", mkEvent(4));
        await sleep(150);
        check("5 秒内重复事件不重复预取", getMsgCalls() - before === 4, "calls=" + (getMsgCalls() - before));
    }

    /* ===== 9. 基础行为回归：自撤回放行 / 管理员撤回他人 / 自己撤回他人 ===== */
    {
        const ipcSends = () => mainWc.sent.filter(s => String(s[0]).startsWith("RM_IPCFROM")).length;
        recvEvent(mainWc, [textMsg(9010, "自己的消息")]);
        const before = ipcSends();
        updateEvent(mainWc, [selfRevokeMsg(9010)]);
        check("自己撤回自己的消息照常送达（保留重新编辑）", ipcSends() === before + 1);
        recvEvent(mainWc, [textMsg(9011, "成员的消息")]);
        const before2 = ipcSends();
        updateEvent(mainWc, [adminRevokeMsg(9011)]);
        await sleep(150);
        check("管理员撤回别人的消息被拦下", ipcSends() === before2, "多送 " + (ipcSends() - before2) + " 条");
        check("管理员撤回别人的消息登记为「你」", (await handlers["LiteLoader.qq_enhance.recalledList"]())["9011"] === "你");
    }

    console.log("\n汇总：" + passed + " PASS / " + failed + " FAIL");
    process.exit(failed ? 1 : 0);
})().catch(e => {
    console.error("测试崩溃：" + (e && e.stack || e));
    process.exit(1);
});
