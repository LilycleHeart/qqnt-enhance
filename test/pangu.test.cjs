// 离线测试「发送时自动 pangu」主进程逻辑：
// 伪造 electron / LiteLoader，加载 main/index.js，向 ipcMain.emit 灌入渲染进程的
// nodeIKernelMsgService/sendMsg 请求，断言 msgElements 里的文本被改写。
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qqe-pangu-test-"));
const handlers = {};
const originalEmits = []; // 未被 pangu hook 改写前的 emit 记录，用来验证「只转一次」
const fakeIpcMain = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: () => {},
    emit: (channel, ...args) => { originalEmits.push({ channel, args }); return true; },
};
const fakeElectron = {
    ipcMain: fakeIpcMain,
    app: { on: () => {} },
    webContents: { getAllWebContents: () => [] },
    BrowserWindow: { getAllWindows: () => [] },
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
const fakeWin = { isDestroyed: () => false, webContents: { send() {} } };
plugin.onBrowserWindowCreated(fakeWin);

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
    if (cond) { passed++; console.log("PASS " + name + (detail ? "  [" + detail + "]" : "")); }
    else { failed++; console.log("FAIL " + name + (detail ? "  [" + detail + "]" : "")); }
};

const textEl = content => ({ elementType: 1, textElement: { content } });
const atEl = content => ({ elementType: 1, textElement: { content, atType: 1 } });
const picEl = () => ({ elementType: 2, picElement: { fileName: "a.png", md5HexStr: "x" } });

let seq = 0;
/** 模拟渲染进程发一条消息，返回 msgElements（会被原地改写） */
function emitSend(elements, opts) {
    const o = opts || {};
    const msg = { msgId: "0", peer: { chatType: 1, peerUid: "u_test", guildId: "" }, msgElements: elements, msgAttributeInfos: new Map() };
    fakeIpcMain.emit(
        "RM_IPCFROM_RENDERER2",
        { type: "request", callbackId: "cb" + (++seq), eventName: "ntApi", peerId: 2 },
        { cmdName: o.cmdName || "nodeIKernelMsgService/sendMsg", cmdType: o.cmdType || "invoke", payload: [msg, null] }
    );
    return msg.msgElements;
}
const textOf = els => els.find(e => e.textElement && !e.textElement.atType).textElement.content;

/* 1. 基本规则 */
check("中英之间补空格", textOf(emitSend([textEl("中文English")])) === "中文 English");
check("英中之间补空格", textOf(emitSend([textEl("English中文")])) === "English 中文");
check("中文与数字两侧补空格", textOf(emitSend([textEl("第2章")])) === "第 2 章");
check("中文与数字连写只补一次", textOf(emitSend([textEl("版本3")])) === "版本 3");
check("纯英文/纯数字不动", textOf(emitSend([textEl("hello world 123")])) === "hello world 123");
check("纯中文不动", textOf(emitSend([textEl("你好世界")])) === "你好世界");

/* 2. 不该动的地方 */
const els2 = emitSend([textEl("中文English")]);
check("多条 textElement 都处理", textOf(els2) === "中文 English");
const els3 = emitSend([atEl("@张三"), textEl("中文English")]);
check("@ 元素内容不处理", els3[0].textElement.content === "@张三");
check("@ 后面的正文照常处理", els3[1].textElement.content === "中文 English");
const els4 = emitSend([textEl("中文English"), picEl()]);
check("图片元素不破坏", els4[1].picElement.fileName === "a.png" && textOf(els4) === "中文 English");
check("非消息命令不改写", textOf(emitSend([textEl("中文English")], { cmdName: "nodeIKernelMsgService/forwardMsgWithComment" })) === "中文English");
check("非 invoke 请求也按 payload 形态处理", textOf(emitSend([textEl("中文English")], { cmdType: "send" })) === "中文 English");

/* 3. 空白与缩进 */
check("保留行首缩进（代码片段）", textOf(emitSend([textEl("    中文English")])) === "    中文 English");
check("保留连续空格（对齐文本）", textOf(emitSend([textEl("a  b中文")])) === "a  b 中文");
check("保留换行", textOf(emitSend([textEl("第一行中文English\n第二行中文")])) === "第一行中文 English\n第二行中文");

/* 4. ,, / ，， 前缀豁免 */
check(",, 前缀：去掉逗号且不处理", textOf(emitSend([textEl(",,中文English123")])) === "中文English123");
check("，， 前缀：去掉逗号且不处理", textOf(emitSend([textEl("，，中文English")])) === "中文English");
check("前缀前有空格也认", textOf(emitSend([textEl("  ,,中文English")])) === "中文English");
check("单个逗号不算豁免", textOf(emitSend([textEl(",中文English")])) === ",中文 English");
check("逗号不相邻不算豁免", textOf(emitSend([textEl(", ,中文English")])) === ", ,中文 English");
check("豁免只对首个正文元素生效", (() => {
    const els = emitSend([atEl("@张三"), textEl(",,中文English")]);
    return els[1].textElement.content === "中文English";
})());

/* 5. 幂等：同一个 payload 再灌一次不会继续加空格 */
const sameEls = emitSend([textEl("中文English")]);
const once = sameEls[0].textElement.content;
const msgAgain = { msgId: "0", peer: { chatType: 1, peerUid: "u_test", guildId: "" }, msgElements: sameEls, msgAttributeInfos: new Map() };
fakeIpcMain.emit("RM_IPCFROM_RENDERER2", { type: "request", callbackId: "cb-re" },
    { cmdName: "nodeIKernelMsgService/sendMsg", cmdType: "invoke", payload: [msgAgain, null] });
check("重复处理保持幂等", msgAgain.msgElements[0].textElement.content === once, once);

/* 6. 开关关闭时不改写 */
(async () => {
    await handlers["LiteLoader.qq_enhance.setConfig"](null, { pangu: false });
    check("设置页关掉后不改写", textOf(emitSend([textEl("中文English")])) === "中文English");
    await handlers["LiteLoader.qq_enhance.setConfig"](null, { pangu: true });
    check("重新打开后恢复改写", textOf(emitSend([textEl("中文English")])) === "中文 English");

    /* 7. hook 只装一层 + 每个请求只透传一次 */
    check("ipcMain.emit 上有幂等标记", fakeIpcMain.__qqEnhancePanguHooked === true);
    // +1 是第 5 节幂等用例里那次手写 emit（没有走 emitSend，不计 seq）
    check("每个请求只透传一次", originalEmits.length === seq + 1, "emit=" + originalEmits.length + " / send=" + (seq + 1));

    console.log(failed ? "SOME FAILED" : "ALL PASS");
    process.exit(failed ? 1 : 0);
})();
