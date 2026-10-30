// 离线测试 qq-enhance 防撤回主进程逻辑：伪造 electron / LiteLoader，模拟「收到消息 → 对方撤回」
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmp = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), "ar-test-"));
const sent = [];
const fakeWin = { isDestroyed: () => false, webContents: { send(ch, ...a) { sent.push([ch, ...a]); } } };
const handlers = {};
const fakeElectron = {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {} },
    BrowserWindow: { getAllWindows: () => [fakeWin] },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : origLoad.call(this, req, ...rest); };
global.LiteLoader = { path: { data: tmp }, versions: { qqnt: "test" }, api: { config: { get: (s, d) => d, set: () => {} } } };

const plugin = require(path.resolve(__dirname, "../main/index.js"));
plugin.onBrowserWindowCreated(fakeWin);
const wc = fakeWin.webContents;

const normal = { msgId: "7001", msgType: 2, elements: [{ elementType: 1, textElement: { content: "原话" } }] };
const revoke = { msgId: "7001", msgType: 5, elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorNick: "张三", isSelfOperate: false } } }] };
const selfRevoke = { msgId: "7002", msgType: 5, elements: [{ grayTipElement: { revokeElement: { isSelfOperate: true, operatorUid: "u_me", origMsgSenderUid: "u_me" } } }] };
const adminNormal = { msgId: "7003", msgType: 2, elements: [{ textElement: { content: "成员的话" } }] };
const adminRevoke = { msgId: "7003", msgType: 5, elements: [{ grayTipElement: { revokeElement: { isSelfOperate: true, operatorUid: "u_me", origMsgSenderUid: "u_member" } } }] };

let ok = true;
const check = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) ok = false; };

wc.send("RM_IPCFROM_MAIN3", { type: "request" }, { cmdName: "nodeIKernelMsgListener/onRecvMsg", payload: { msgList: [JSON.parse(JSON.stringify(normal))] } });
check("普通消息照常发出", sent.length === 1);

const upd = { cmdName: "nodeIKernelMsgListener/onMsgInfoListUpdate", payload: { msgList: [JSON.parse(JSON.stringify(revoke))] } };
wc.send("RM_IPCFROM_MAIN3", { type: "request" }, upd);
check("撤回更新被拦掉", sent.length === 1);

const resp = { result: 0, msgList: [JSON.parse(JSON.stringify(revoke))] };
wc.send("RM_IPCFROM_MAIN3", { type: "response", callbackId: "x" }, resp);
check("历史消息里的撤回灰条被换回原文", resp.msgList[0].elements[0].textElement?.content === "原话");

const own = { cmdName: "nodeIKernelMsgListener/onMsgInfoListUpdate", payload: { msgList: [selfRevoke] } };
const before = sent.length;
wc.send("RM_IPCFROM_MAIN3", {}, own);
check("自己撤回不拦", sent.length === before + 1);

wc.send("RM_IPCFROM_MAIN3", {}, { cmdName: "nodeIKernelMsgListener/onRecvMsg", payload: { msgList: [JSON.parse(JSON.stringify(adminNormal))] } });
const n2 = sent.length;
wc.send("RM_IPCFROM_MAIN3", {}, { cmdName: "nodeIKernelMsgListener/onMsgInfoListUpdate", payload: { msgList: [JSON.parse(JSON.stringify(adminRevoke))] } });
check("自己撤回别人的消息被拦掉", sent.length === n2);

wc.send("OTHER_CHANNEL", 1);
check("其他频道不受影响", sent.at(-1)[0] === "OTHER_CHANNEL");

setTimeout(async () => {
    check("通知界面已撤回", sent.some(s => s[0] === "LiteLoader.qq_enhance.recalled" && s[1] === "7001" && s[2] === "张三"));
    check("原文已落盘", fs.existsSync(path.join(tmp, "qq-enhance", "anti-recall", "messages", "7001.json")));
    const list = await handlers["LiteLoader.qq_enhance.recalledList"]();
    check("撤回列表可查询", list["7001"] === "张三" && list["7003"] === "你");
    setTimeout(() => {
        check("撤回列表已保存", fs.existsSync(path.join(tmp, "qq-enhance", "anti-recall", "recalled.json")));
        console.log(ok ? "ALL PASS" : "SOME FAILED");
        process.exit(ok ? 0 : 1);
    }, 700);
}, 200);
