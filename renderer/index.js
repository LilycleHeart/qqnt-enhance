// QQ 增强 · 界面
//   1. 防撤回：给已还原的消息打「已撤回」标记
//   2. 记住浏览位置：切回会话时停在上次看到的地方（Telegram 的做法）
//   3. 右键菜单「复读」：把这条消息原样再发一次
//   4. 引用时不带 @：点「引用」后删掉 QQ 自动插入的 @
//   5. 本地表情包：表情文件夹按子文件夹分组，另有一个收藏分组（见 stickers.js）
//   6. 设置页：每项单独开关
// 消息数据从 .message 元素上的 __VUE__[0].props.msgRecord 读（QQ 9.9.36 实测）。
import { installStickers, NATIVE_TABS } from "./stickers.js";

const api = window.qq_enhance;
let config = { antiRecall: true, chatPos: true, repeat: true, quoteNoAt: true, stickers: true, stickerDir: "", showEmojiSearch: true, showEmojiDefault: true, showEmojiFav: true };
let stickers = null;

function recordOf(el) {
    try {
        const m = el && el.closest && el.closest(".message");
        const inst = m && m.__VUE__ && m.__VUE__[0];
        return (inst && inst.props && inst.props.msgRecord) || null;
    } catch (e) { return null; }
}

function toast(text) {
    let el = document.getElementById("qq-enhance-toast");
    if (!el) {
        el = document.createElement("div");
        el.id = "qq-enhance-toast";
        el.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:99999;" +
            "padding:6px 14px;border-radius:10px;font-size:13px;pointer-events:none;opacity:0;transition:opacity 160ms;" +
            "background:var(--ll-float-bg, rgba(30,30,30,0.9));color:var(--ll-on-glass, #fff);box-shadow:0 4px 16px rgba(0,0,0,0.3)";
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = "0"; }, 1600);
}

/* ════════════════ 1. 防撤回标记 ════════════════ */
const recalled = new Map();   // msgId -> 撤回人
const AR_CSS = `
.ml-item.ar-recalled .message-content__wrapper {
  position: relative;
  opacity: 0.78;
  outline: 1.5px dashed var(--ll-brand, var(--brand_standard, #1d9bf0));
  outline-offset: 2px;
  border-radius: 10px;
}
.ml-item.ar-recalled .message-content__wrapper::after {
  content: "已撤回 · " attr(data-ar-by);
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--ll-brand, var(--brand_standard, #1d9bf0));
  white-space: nowrap;
}`;

function markRecalled() {
    if (!recalled.size) return;
    const items = document.querySelectorAll(".ml-item[id]");
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const nick = recalled.get(item.id);
        if (nick === undefined) {
            if (item.classList.contains("ar-recalled")) item.classList.remove("ar-recalled");
            continue;
        }
        if (!item.classList.contains("ar-recalled")) item.classList.add("ar-recalled");
        const wrap = item.querySelector(".message-content__wrapper");
        if (wrap && wrap.dataset.arBy !== nick) wrap.dataset.arBy = nick;
    }
}

function reloadRecalled() {
    api.recalledList().then(map => {
        recalled.clear();
        for (const [id, nick] of Object.entries(map || {})) recalled.set(id, nick);
        markRecalled();
        // 清空后要把旧标记去掉
        if (!recalled.size) document.querySelectorAll(".ml-item.ar-recalled").forEach(x => x.classList.remove("ar-recalled"));
    }).catch(() => {});
}

/* ════════════════ 2. 记住浏览位置 ════════════════
 * 记：滚动停下 300ms 后，记下视口最上面那条消息的 id 和它离视口顶的距离；
 *     当时就在最底下则记「在底部」，回来时什么都不做（QQ 默认就在底部）。
 * 回：切换会话后等 QQ 先渲染，再找那条消息：找到就滚回原位置；
 *     找不到就往上翻一屏让 QQ 加载更早的消息，最多翻 40 次。用户一滚动/点击就停手。 */
const POS_KEY = "qq-enhance-chat-pos";
const POS_MAX = 300;
const BOTTOM_PX = 48;
let posStore = {};
try { posStore = JSON.parse(localStorage.getItem(POS_KEY) || "{}"); } catch (e) { posStore = {}; }

function savePosStore() {
    const ids = Object.keys(posStore);
    if (ids.length > POS_MAX) ids.sort((a, b) => posStore[a].t - posStore[b].t).slice(0, ids.length - POS_MAX).forEach(k => delete posStore[k]);
    try { localStorage.setItem(POS_KEY, JSON.stringify(posStore)); } catch (e) {}
}

function currentPeer() {
    const rec = recordOf(document.querySelector(".chat-msg-area .message"));
    return rec ? rec.chatType + ":" + rec.peerUid : "";
}

function findScroller() {
    const area = document.querySelector(".chat-msg-area");
    if (!area) return null;
    const item = area.querySelector(".ml-item");
    for (let n = item && item.parentElement; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 4) return n;
        if (n === area) break;
    }
    return null;
}

function distanceToBottom(sc) {
    // 倒序列表（column-reverse）在底部时 scrollTop 是 0、往上是负数
    if (sc.scrollTop < 0 || getComputedStyle(sc).flexDirection === "column-reverse") return -sc.scrollTop;
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight;
}

function topVisibleItem(sc) {
    const top = sc.getBoundingClientRect().top;
    let best = null, bestTop = Infinity;
    const items = sc.querySelectorAll(".ml-item[id]");
    for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (r.bottom <= top + 4) continue;
        if (r.top < bestTop) { bestTop = r.top; best = items[i]; }
    }
    return best ? { id: best.id, off: Math.round(bestTop - top) } : null;
}

let peer = "";
let restoring = false;
let posSaveTimer = 0;
let restoreJob = 0;

function savePos() {
    if (!config.chatPos || restoring || !peer) return;
    // 界面已经换成别的会话（QQ 切会话时会把新会话滚到底并触发 scroll），
    // 这时再记就会把「在底部」错记到旧会话头上，把真正的位置冲掉
    if (currentPeer() !== peer) return;
    const sc = findScroller();
    if (!sc) return;
    if (distanceToBottom(sc) <= BOTTOM_PX) posStore[peer] = { bottom: true, t: Date.now() };
    else {
        const a = topVisibleItem(sc);
        if (!a) return;
        posStore[peer] = { id: a.id, off: a.off, t: Date.now() };
    }
    savePosStore();
}

document.addEventListener("scroll", e => {
    if (restoring || !config.chatPos) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest(".chat-msg-area")) return;
    clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(savePos, 300);
}, { capture: true, passive: true });

function stopRestore() { restoring = false; restoreJob++; }
// 点会话列表等地方之前，先把还没来得及记的位置立刻记下（滚完 300ms 内就切走也不丢）
document.addEventListener("mousedown", e => {
    if (!posSaveTimer || restoring) return;
    if (e.target && e.target.closest && e.target.closest(".chat-msg-area")) return;
    clearTimeout(posSaveTimer); posSaveTimer = 0;
    savePos();
}, true);
["wheel", "mousedown", "keydown", "touchstart"].forEach(ev =>
    document.addEventListener(ev, () => { if (restoring) stopRestore(); }, { capture: true, passive: true }));

function restorePos(target) {
    const job = ++restoreJob;
    restoring = true;
    let tries = 0;
    const align = (sc, el) => { sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - target.off; };
    const step = () => {
        if (job !== restoreJob) return;
        const sc = findScroller();
        if (!sc) { if (tries++ < 40) return setTimeout(step, 150); return stopRestore(); }
        const sel = '.ml-item[id="' + CSS.escape(target.id) + '"]';
        const el = sc.querySelector(sel);
        if (el) {
            align(sc, el);
            setTimeout(() => {                             // 虚拟列表滚动后可能重排一次，再校正
                if (job !== restoreJob) return;
                const el2 = sc.querySelector(sel);
                if (el2) align(sc, el2);
                restoring = false;
            }, 120);
            return;
        }
        if (tries++ >= 40) return stopRestore();
        sc.scrollTop -= sc.clientHeight * 1.5;
        setTimeout(step, 180);
    };
    setTimeout(step, 350);
}

function checkPeer() {
    const p = currentPeer();
    if (!p || p === peer) return;
    stopRestore();                                         // 此时界面已是新会话，不能再给旧会话补记
    peer = p;
    const saved = posStore[p];
    if (config.chatPos && saved && !saved.bottom && saved.id) restorePos(saved);
}

/* ════════════════ 3. 右键菜单「复读」 ════════════════
 * 记下右键的是哪条消息；菜单出现后在「转发」后面克隆一项「复读」。 */
const REPEAT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
let ctxMsg = null;

document.addEventListener("contextmenu", e => {
    if (!config.repeat) { ctxMsg = null; return; }
    const rec = recordOf(e.target);
    // 只传几个字段：msgRecord 是 Vue 响应式对象，不能直接走 IPC
    ctxMsg = rec ? { msgId: String(rec.msgId), chatType: rec.chatType, peerUid: String(rec.peerUid), guildId: rec.guildId ? String(rec.guildId) : "" } : null;
    if (ctxMsg) setTimeout(injectRepeat, 0);
}, true);

function menuItemByText(menu, text) {
    const items = menu.querySelectorAll(".q-context-menu-item");
    for (let i = 0; i < items.length; i++) if ((items[i].textContent || "").trim() === text) return items[i];
    return null;
}

function injectRepeat(tries) {
    tries = tries || 0;
    const menu = document.querySelector(".q-context-menu");
    if (!menu || !ctxMsg) { if (tries < 10) setTimeout(() => injectRepeat(tries + 1), 30); return; }
    if (menu.querySelector(".qe-repeat-item")) return;
    const anchor = menuItemByText(menu, "转发") || menuItemByText(menu, "复制");
    if (!anchor) return;
    const item = anchor.cloneNode(true);
    item.classList.add("qe-repeat-item");
    item.classList.remove("q-context-menu-item--disabled");
    const label = item.querySelector(".q-context-menu-item__text");
    if (label) label.textContent = "复读";
    const icon = item.querySelector("svg");
    if (icon && icon.parentElement) icon.parentElement.innerHTML = REPEAT_ICON;
    const msg = ctxMsg;
    item.addEventListener("click", ev => {
        ev.stopPropagation();
        ev.preventDefault();
        menu.style.display = "none";
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        api.repeat(msg).then(res => {
            if (res && (res.error || (res.result !== undefined && res.result !== 0))) toast("复读失败：" + (res.error || res.errMsg || res.result));
        }).catch(() => toast("复读失败"));
    }, true);
    anchor.after(item);
}

/* ════════════════ 4. 引用时不带 @ ════════════════
 * 点「引用」后，QQ 往输入框里插：引用块 .editor-el__reply-wrapper + <p>@某人 </p>。
 * 实测：@ 是 <span class="editor-el__at" contenteditable="false">，后跟一个空格。
 * 点「引用」后 1.5 秒内，一出现紧跟引用块的 @，就把它和后面的空格删掉；
 * ProseMirror 会把这次 DOM 改动读回自己的文档（与用户删字走同一条路）。 */
let quoteUntil = 0;

document.addEventListener("click", e => {
    if (!config.quoteNoAt) return;
    const item = e.target && e.target.closest && e.target.closest(".q-context-menu-item");
    if (!item || (item.textContent || "").trim() !== "引用") return;
    quoteUntil = Date.now() + 1500;
    watchQuoteAt();
}, true);

function editorEl() {
    return document.querySelector(".chat-input-area .ProseMirror") || document.querySelector(".ProseMirror");
}

function stripQuoteAt() {
    const pm = editorEl();
    if (!pm || !pm.querySelector(".editor-el__reply-wrapper")) return false;
    const p = pm.querySelector(".editor-el__reply-wrapper ~ p");
    const at = p && p.querySelector(".editor-el__at");
    if (!at || at !== p.firstElementChild) return false;
    const next = at.nextSibling;
    at.remove();
    if (next && next.nodeType === 3) {
        next.data = next.data.replace(/^[\s\u00a0]/, "");
        if (!next.data) next.remove();
    }
    if (!p.childNodes.length) p.appendChild(document.createElement("br"));
    pm.focus();
    return true;
}

function watchQuoteAt() {
    const pm = editorEl();
    if (!pm) return;
    if (stripQuoteAt()) return;
    const ob = new MutationObserver(() => {
        if (Date.now() > quoteUntil) { ob.disconnect(); return; }
        if (stripQuoteAt()) ob.disconnect();
    });
    ob.observe(pm, { childList: true, subtree: true });
    setTimeout(() => ob.disconnect(), 1600);
}

/* ════════════════ 启动 ════════════════ */
function start() {
    if (!api || window.__qqEnhanceStarted) return;
    window.__qqEnhanceStarted = true;

    const style = document.createElement("style");
    style.id = "qq-enhance-style";
    style.textContent = AR_CSS;
    (document.head || document.documentElement).appendChild(style);

    api.getConfig().then(cfg => { if (cfg) config = cfg; }).catch(() => {});
    api.onConfigChanged(cfg => { if (cfg) config = cfg; reloadRecalled(); if (stickers) { stickers.ensure(); stickers.reload(); } });
    reloadRecalled();
    api.onRecalled((id, nick) => { recalled.set(String(id), nick || "对方"); markRecalled(); });
    if (location.hash.indexOf("#/setting") !== 0) stickers = installStickers(api, () => config, toast);

    // DOM 变动后 150ms 跑一次（滚动时合并成一次，不每帧跑）
    let timer = 0;
    new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => { timer = 0; markRecalled(); checkPeer(); if (stickers) stickers.ensure(); }, 150);
    }).observe(document.body, { childList: true, subtree: true });
}

if (document.body) start();
else addEventListener("DOMContentLoaded", start);

/* ════════════════ 5. 设置页 ════════════════
 * 用 LiteLoader 自带的 setting-* 组件，样式跟其他插件设置一致。 */
const FEATURES = [
    ["antiRecall", "防撤回", "别人撤回的消息照常显示，标上「已撤回」。只能还原插件运行时收到过的消息。"],
    ["chatPos", "记住浏览位置", "切回会话时停在上次看到的地方，而不是跳到最底下。"],
    ["repeat", "右键复读", "消息右键菜单里加一项「复读」，把这条消息原样再发一次。"],
    ["quoteNoAt", "引用时不带 @", "点「引用」时，不自动在输入框里插入 @对方。"],
    ["stickers", "本地表情包", "表情面板底部多一个「本地表情」分类，发送表情文件夹里的图片。每个子文件夹是一个分组，另有收藏分组。"],
];

function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
}

export const onSettingWindowCreated = async view => {
    let cfg = config;
    try { cfg = (await api.getConfig()) || cfg; } catch (e) {}

    view.innerHTML = `
<setting-section data-title="功能">
  <setting-panel>
    <setting-list data-direction="column" class="qe-features"></setting-list>
  </setting-panel>
</setting-section>
<setting-section data-title="本地表情包">
  <setting-panel>
    <setting-list data-direction="column" class="qe-st-list">
      <setting-item>
        <div>
          <setting-text>表情文件夹</setting-text>
          <setting-text data-type="secondary" class="qe-st-dir">读取中…</setting-text>
        </div>
        <div style="display:flex;gap:8px">
          <setting-button data-type="secondary" class="qe-st-open">打开</setting-button>
          <setting-button data-type="secondary" class="qe-st-pick">更换</setting-button>
          <setting-button data-type="secondary" class="qe-st-reset" style="display:none">恢复默认</setting-button>
        </div>
      </setting-item>
    </setting-list>
  </setting-panel>
</setting-section>
<setting-section data-title="防撤回数据">
  <setting-panel>
    <setting-list data-direction="column">
      <setting-item>
        <div>
          <setting-text>已保存的原文</setting-text>
          <setting-text data-type="secondary" class="qe-stats">读取中…</setting-text>
        </div>
        <setting-button data-type="secondary" class="qe-clear">清空</setting-button>
      </setting-item>
    </setting-list>
  </setting-panel>
</setting-section>`;

    const list = view.querySelector(".qe-features");
    for (const [key, name, desc] of FEATURES) {
        const item = document.createElement("setting-item");
        item.innerHTML = `<div><setting-text></setting-text><setting-text data-type="secondary"></setting-text></div><setting-switch></setting-switch>`;
        const texts = item.querySelectorAll("setting-text");
        texts[0].textContent = name;
        texts[1].textContent = desc;
        const sw = item.querySelector("setting-switch");
        sw.toggleAttribute("is-active", !!cfg[key]);
        sw.addEventListener("click", async () => {
            const on = !sw.hasAttribute("is-active");
            sw.toggleAttribute("is-active", on);
            try { cfg = await api.setConfig({ [key]: on }); } catch (e) { sw.toggleAttribute("is-active", !on); }
        });
        list.appendChild(item);
    }

    // 表情面板里 QQ 自带的三个按钮：可以分别隐藏
    const stList = view.querySelector(".qe-st-list");
    for (const [key, label] of NATIVE_TABS) {
        const item = document.createElement("setting-item");
        item.innerHTML = `<div><setting-text></setting-text><setting-text data-type="secondary"></setting-text></div><setting-switch></setting-switch>`;
        const texts = item.querySelectorAll("setting-text");
        texts[0].textContent = "表情面板显示「" + label + "」";
        texts[1].textContent = "关掉后，表情面板底栏不再显示 QQ 自带的这个按钮。";
        const sw = item.querySelector("setting-switch");
        sw.toggleAttribute("is-active", cfg[key] !== false);
        sw.addEventListener("click", async () => {
            const on = !sw.hasAttribute("is-active");
            sw.toggleAttribute("is-active", on);
            try { cfg = await api.setConfig({ [key]: on }); } catch (e) { sw.toggleAttribute("is-active", !on); }
        });
        stList.appendChild(item);
    }

    const dirEl = view.querySelector(".qe-st-dir");
    const resetBtn = view.querySelector(".qe-st-reset");
    const refreshDir = () => api.stickerList().then(s => {
        const n = s.groups.reduce((a, g) => a + g.files.length, 0);
        dirEl.textContent = s.root + "（" + s.groups.length + " 个分组，" + n + " 张，收藏 " + s.favs.length + " 张）";
        resetBtn.style.display = s.isDefault ? "none" : "";
    }).catch(() => { dirEl.textContent = "读取失败"; });
    refreshDir();
    view.querySelector(".qe-st-open").addEventListener("click", () => api.stickerOpenDir());
    view.querySelector(".qe-st-pick").addEventListener("click", async () => {
        const c = await api.stickerPickDir();
        if (c) { cfg = c; refreshDir(); }
    });
    resetBtn.addEventListener("click", async () => {
        cfg = await api.setConfig({ stickerDir: "" });
        refreshDir();
    });

    const statsEl = view.querySelector(".qe-stats");
    const refreshStats = () => api.stats().then(s => {
        statsEl.textContent = s.saved + " 条，占用 " + fmtBytes(s.bytes) + "；已标记撤回 " + s.recalled + " 条";
    }).catch(() => { statsEl.textContent = "读取失败"; });
    refreshStats();

    const clearBtn = view.querySelector(".qe-clear");
    let armed = false;
    clearBtn.addEventListener("click", async () => {
        // 点两次才清：第一次变成确认
        if (!armed) {
            armed = true;
            clearBtn.textContent = "确定清空？";
            setTimeout(() => { armed = false; clearBtn.textContent = "清空"; }, 3000);
            return;
        }
        armed = false;
        clearBtn.textContent = "清空";
        await api.clearSaved();
        refreshStats();
    });
};
