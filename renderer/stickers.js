// QQ 增强 · 本地表情包（并进 QQ 自带的表情面板）
//   - 表情面板底部分类栏里，「我的收藏」后面多一个「本地表情」切换按钮
//   - 切过去后，整个面板（连同底部分类栏）换成本地表情：底栏是收藏 + 每个子文件夹，
//     文件夹用它里面第一张图做缩略图；底栏最左边的按钮切回 QQ 自带的表情
//   - 点图片直接发送并收起面板；Ctrl/Shift + 点击发送后不收起；右键或右上角星标切换收藏
//   - 图片用 QQ 自己的 appimg:// 协议读本地文件
// 表情面板是 Vue 管理的，往里塞的节点会被重渲染清掉：
//   切换按钮由主循环反复调 ensure() 补回；本地表情页不放进面板，而是挂在 body 上、按面板位置整个盖上去。

const ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4 2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z"/></svg>';
const STAR = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

const ICON_BACK = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>';
const STAR_BIG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
const LABEL = "本地表情";
const FAV = "\u0000fav";
const TAB_KEY = "qq-enhance-sticker-tab";
const ORDER_KEY = "qq-enhance-sticker-order";
const LAST_KEY = "qq-enhance-sticker-last";   // 关面板时是否停在本地表情页（重启/刷新后也记得）
// 表情面板里 QQ 自带的三个按钮，设置页可以分别隐藏
export const NATIVE_TABS = [["showEmojiSearch", "搜索表情", "search"], ["showEmojiDefault", "默认表情", "default"], ["showEmojiFav", "我的收藏", "fav"]];
const ACTIVE_CLS = "tabs-container-item-active";

const CSS = `
#qe-sticker-view {
  position: fixed; z-index: 4500; display: none; flex-direction: column; box-sizing: border-box;
  overflow: hidden;
  background: transparent;
  color: var(--ll-on-glass, var(--text_primary, #222)); font-size: 13px;
}
#qe-sticker-view.is-open { display: flex; }
#qe-sticker-view .qe-sp-grid {
  flex: 1; overflow-y: auto; padding: 4px 8px 8px; display: grid; align-content: start;
  grid-template-columns: repeat(auto-fill, minmax(68px, 1fr)); grid-auto-rows: 68px; gap: 4px;
}
#qe-sticker-view .qe-sp-cell {
  position: relative; height: 68px; min-width: 0; padding: 6px; box-sizing: border-box; border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
#qe-sticker-view .qe-sp-cell:hover { background: var(--overlay_hover, rgba(127,127,127,.14)); }
/* 格子定死 68px、图片铺满格子再 contain：大图不会撑开格子叠到一起 */
#qe-sticker-view .qe-sp-cell img { display: block !important; width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important; object-fit: contain !important; pointer-events: none; }
#qe-sticker-view .qe-sp-star {
  position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; border-radius: 6px;
  display: none; align-items: center; justify-content: center;
  color: var(--ll-on-glass-2, var(--text_secondary, #888)); background: rgba(127,127,127,.2);
}
#qe-sticker-view .qe-sp-cell:hover .qe-sp-star { display: flex; }
#qe-sticker-view .qe-sp-cell.is-fav .qe-sp-star { display: flex; color: #f5b400; background: transparent; }
#qe-sticker-view .qe-sp-star:hover { background: rgba(127,127,127,.32); }
#qe-sticker-view .qe-sp-title {
  grid-column: 1 / -1; padding: 4px 4px 2px; font-size: 12px;
  color: var(--ll-on-glass-2, var(--text_secondary, #888));
}
#qe-sticker-view .qe-sp-divide { flex: 0 0 1px; margin: 0 8px; background: rgba(127,127,127,.18); }
#qe-sticker-view .qe-sp-bar { display: flex; align-items: center; gap: 2px; padding: 6px 8px; flex: 0 0 auto; height: 48px; box-sizing: border-box; }
#qe-sticker-view .qe-sp-tabs { flex: 1; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
#qe-sticker-view .qe-sp-tabs::-webkit-scrollbar { display: none; }
#qe-sticker-view .qe-sp-tab, #qe-sticker-view .qe-sp-act {
  flex: 0 0 auto; width: 36px; height: 36px; padding: 0; border: none; border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: transparent;
  color: var(--icon_primary, var(--ll-on-glass, currentColor)); font: inherit;
}
#qe-sticker-view .qe-sp-act { width: 28px; color: var(--ll-on-glass-2, var(--text_secondary, #888)); }
#qe-sticker-view .qe-sp-back { margin-right: 2px; }
#qe-sticker-view .qe-sp-tab img { width: 28px; height: 28px; object-fit: cover; border-radius: 6px; pointer-events: none; }
#qe-sticker-view .qe-sp-tab:hover, #qe-sticker-view .qe-sp-act:hover { background: var(--overlay_hover, rgba(127,127,127,.14)); }
#qe-sticker-view .qe-sp-tab.is-active { background: var(--overlay_active, rgba(var(--ll-brand-rgb, 0,153,255), .2)); }
#qe-sticker-view .qe-sp-tab.is-fav-tab.is-active { color: #f5b400; }
#qe-sticker-view .qe-sp-empty {
  grid-column: 1 / -1; padding: 40px 16px; text-align: center; line-height: 1.7;
  color: var(--ll-on-glass-2, var(--text_secondary, #888));
}
#qe-sticker-view .qe-sp-empty b { color: var(--ll-on-glass, var(--text_primary, #222)); font-weight: 600; }
/* 本地表情页打开时，把 QQ 自己的内容藏起来（面板底色和分类栏留着） */
body.qe-st-active .expression-panel .sticker-panel > :first-child,
body.qe-st-active .expression-panel .sticker-panel__pages,
body.qe-st-active .expression-panel .sticker-panel__divide,
body.qe-st-active .expression-panel .sticker-panel__bar { visibility: hidden !important; }
body[data-qe-hide-search] .expression-panel .tabs-container-item[aria-label="搜索表情"],
body[data-qe-hide-default] .expression-panel .tabs-container-item[aria-label="默认表情"],
body[data-qe-hide-fav] .expression-panel .tabs-container-item[aria-label="我的收藏"] { display: none !important; }
/* 切换按钮放在分类栏最前面（分类栏翻页也不动），不在可翻页的那一排里 */
.expression-panel .sticker-panel__bar > .qe-st-tab {
  flex: 0 0 auto; width: 36px; height: 36px; margin: 0 4px 0 10px; border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; align-self: center;
}
.expression-panel .sticker-panel__bar > .qe-st-tab:hover { background: var(--overlay_hover, rgba(127,127,127,.14)); }
.expression-panel .sticker-panel__bar > .qe-st-tab.tabs-container-item-active { background: var(--overlay_active, rgba(127,127,127,.2)); }
#qe-sticker-view .qe-sp-tab.is-dragging { opacity: .35; }
#qe-sticker-view .qe-sp-tab.is-drop-before { box-shadow: inset 2px 0 0 var(--ll-brand, var(--brand_standard, #0099ff)); }
#qe-sticker-view .qe-sp-tab.is-drop-after { box-shadow: inset -2px 0 0 var(--ll-brand, var(--brand_standard, #0099ff)); }
.expression-panel .qe-st-tab { color: var(--icon_primary, currentColor); }
.expression-panel .qe-st-tab svg { width: 24px; height: 24px; display: block; }
`;

export function appimg(p) {
    return "appimg://" + encodeURI(String(p).replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

export function installStickers(api, getConfig, toast) {
    let data = { groups: [], favs: [], root: "" };
    let favSet = new Set();
    let tab = localStorage.getItem(TAB_KEY) || FAV;
    let view = null, grid = null, tabsEl = null;
    let active = false;          // 本地表情页是否打开
    // 上次关面板时停在本地表情页：下次打开直接回到这里。存进 localStorage，刷新/重启也记得
    let lastOursVal = localStorage.getItem(LAST_KEY) === "1";
    const setLast = v => { lastOursVal = !!v; try { localStorage.setItem(LAST_KEY, v ? "1" : "0"); } catch (e) {} };
    let panelWasOpen = false;
    let recheck = 0, recheckLeft = 0;
    let raf = 0;

    const style = document.createElement("style");
    style.id = "qq-enhance-sticker-style";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

    function peerNow() {
        try {
            const area = document.querySelector(".chat-msg-area");
            for (const inst of (area && area.__VUE__) || []) {
                const p = inst && inst.props && inst.props.peer;
                if (p && p.peerUid) return { chatType: p.chatType, peerUid: String(p.peerUid), guildId: p.guildId ? String(p.guildId) : "" };
            }
            const m = document.querySelector(".chat-msg-area .message");
            const rec = m && m.__VUE__ && m.__VUE__[0] && m.__VUE__[0].props && m.__VUE__[0].props.msgRecord;
            if (rec && rec.peerUid) return { chatType: rec.chatType, peerUid: String(rec.peerUid), guildId: rec.guildId ? String(rec.guildId) : "" };
        } catch (e) {}
        return null;
    }

    function stickerPanel() {
        const sp = document.querySelector(".chat-input-area .expression-panel .sticker-panel") || document.querySelector(".expression-panel .sticker-panel");
        if (!sp) return null;
        const r = sp.getBoundingClientRect();
        return r.width > 100 && r.height > 100 ? sp : null;
    }

    function loadOrder() {
        try { return JSON.parse(localStorage.getItem(ORDER_KEY) || "[]"); } catch (e) { return []; }
    }
    function sortGroups() {
        const order = loadOrder();
        const rank = name => { const i = order.indexOf(name); return i < 0 ? 1e6 : i; };
        data.groups = data.groups.map((g, i) => [g, i]).sort((a, b) => (rank(a[0].name) - rank(b[0].name)) || (a[1] - b[1])).map(x => x[0]);
    }
    function moveGroup(from, to, after) {
        const names = data.groups.map(g => g.name);
        if (from === to) return;
        names.splice(names.indexOf(from), 1);
        let i = names.indexOf(to);
        if (after) i++;
        names.splice(i, 0, from);
        try { localStorage.setItem(ORDER_KEY, JSON.stringify(names)); } catch (e) {}
        sortGroups();
        render();
    }

    async function reload() {
        try { data = await api.stickerList(); } catch (e) { data = { groups: [], favs: [], root: "" }; }
        sortGroups();
        favSet = new Set(data.favs || []);
        if (tab !== FAV && !data.groups.some(g => g.name === tab)) tab = FAV;
        if (active) render();
    }

    function build() {
        if (view) return;
        view = document.createElement("div");
        view.id = "qe-sticker-view";
        view.innerHTML = '<div class="qe-sp-grid"></div><div class="qe-sp-divide"></div>' +
            '<div class="qe-sp-bar">' +
            '<button type="button" class="qe-sp-tab qe-sp-back" data-act="back" title="切回 QQ 表情">' + ICON_BACK + '</button>' +
            '<div class="qe-sp-tabs"></div>' +
            '<button type="button" class="qe-sp-act" data-act="refresh" title="刷新">' + ICON_REFRESH + '</button>' +
            '<button type="button" class="qe-sp-act" data-act="open" title="打开表情文件夹">' + ICON_FOLDER + '</button></div>';
        grid = view.querySelector(".qe-sp-grid");
        tabsEl = view.querySelector(".qe-sp-tabs");
        document.body.appendChild(view);

        // 面板外点击会让 QQ 收起表情面板；内容层不在面板 DOM 里，得挡住 mousedown，免得 QQ 以为点到了外面
        view.addEventListener("mousedown", e => e.stopPropagation());
        view.addEventListener("click", e => {
            e.stopPropagation();
            const act = e.target.closest("[data-act]");
            if (act) {
                if (act.dataset.act === "back") { setLast(false); deactivate(); }
                else if (act.dataset.act === "open") api.stickerOpenDir();
                else reload().then(() => toast("已刷新"));
                return;
            }
            const t = e.target.closest(".qe-sp-tab");
            if (t) { tab = t.dataset.tab; localStorage.setItem(TAB_KEY, tab); render(); grid.scrollTop = 0; return; }
            const cell = e.target.closest(".qe-sp-cell");
            if (!cell) return;
            if (e.target.closest(".qe-sp-star")) { toggleFav(cell.dataset.path); return; }
            send(cell, !(e.ctrlKey || e.shiftKey));
        });
        // 拖动文件夹按钮调整分组顺序（收藏固定在最前，不参与）
        let dragName = null;
        const clearMarks = () => tabsEl.querySelectorAll(".is-drop-before, .is-drop-after").forEach(n => n.classList.remove("is-drop-before", "is-drop-after"));
        const dropTarget = e => {
            const b = e.target.closest && e.target.closest(".qe-sp-tabs .qe-sp-tab");
            if (!b || b.dataset.tab === FAV) return null;
            const r = b.getBoundingClientRect();
            return { b, after: e.clientX > r.left + r.width / 2 };
        };
        tabsEl.addEventListener("dragstart", e => {
            const b = e.target.closest(".qe-sp-tab");
            if (!b || b.dataset.tab === FAV) { e.preventDefault(); return; }
            dragName = b.dataset.tab;
            b.classList.add("is-dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", dragName);
        });
        tabsEl.addEventListener("dragover", e => {
            if (!dragName) return;
            e.preventDefault();
            e.stopPropagation();
            clearMarks();
            const d = dropTarget(e);
            if (d && d.b.dataset.tab !== dragName) d.b.classList.add(d.after ? "is-drop-after" : "is-drop-before");
            // 拖到两头时自动横向滚动
            const r = tabsEl.getBoundingClientRect();
            if (e.clientX < r.left + 24) tabsEl.scrollLeft -= 8;
            else if (e.clientX > r.right - 24) tabsEl.scrollLeft += 8;
        });
        tabsEl.addEventListener("drop", e => {
            if (!dragName) return;
            e.preventDefault();
            e.stopPropagation();
            const d = dropTarget(e);
            const from = dragName;
            dragName = null;
            clearMarks();
            if (d) moveGroup(from, d.b.dataset.tab, d.after);
        });
        tabsEl.addEventListener("dragend", () => {
            dragName = null;
            clearMarks();
            tabsEl.querySelectorAll(".is-dragging").forEach(n => n.classList.remove("is-dragging"));
        });

        view.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();
            const cell = e.target.closest(".qe-sp-cell");
            if (cell) toggleFav(cell.dataset.path);
        });
        // QQ 的表情面板一看到滚动/滚轮就收起（它在 document 上监听）。
        // 本地表情页里的滚动在 window 捕获阶段就截住，不让 QQ 看到；底栏的滚轮在这里顺手换成横向滚动。
        const guard = e => {
            if (!view || !(e.target instanceof Node) || !view.contains(e.target)) return;
            if (e.type === "wheel" && e.target.closest && e.target.closest(".qe-sp-bar")) {
                tabsEl.scrollLeft += e.deltaY || e.deltaX;
                e.preventDefault();
            }
            e.stopPropagation();
        };
        addEventListener("scroll", guard, true);
        addEventListener("wheel", guard, { capture: true, passive: false });
    }

    async function toggleFav(p) {
        const on = !favSet.has(p);
        try {
            data.favs = await api.stickerFav(p, on);
            favSet = new Set(data.favs);
            toast(on ? "已收藏" : "已取消收藏");
        } catch (e) { toast("收藏失败"); }
        render();
    }

    function closePanel() {
        setLast(true);
        const btn = document.querySelector('.chat-func-bar .icon-item[aria-label="表情"]');
        if (btn) btn.click();
        deactivate();
    }

    function send(cell, close) {
        const peer = peerNow();
        if (!peer) { toast("没有找到当前会话"); return; }
        const img = cell.querySelector("img");
        const hint = img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
        if (close) closePanel();
        api.stickerSend(peer, cell.dataset.path, hint).then(res => {
            if (res && (res.error || (res.result !== undefined && res.result !== 0))) toast("发送失败：" + (res.error || res.errMsg || res.result));
        }).catch(() => toast("发送失败"));
    }

    function render() {
        if (!view) return;
        tabsEl.innerHTML = "";
        const tabs = [{ id: FAV, name: "收藏" }].concat(data.groups.map(g => ({ id: g.name, name: g.name, cover: g.files[0] })));
        for (const it of tabs) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "qe-sp-tab" + (it.id === tab ? " is-active" : "") + (it.id === FAV ? " is-fav-tab" : "");
            b.dataset.tab = it.id;
            b.title = it.name;
            if (it.id === FAV) b.innerHTML = STAR_BIG;
            else {
                b.draggable = true;
                b.title = it.name + "（拖动可调整顺序）";
                const img = document.createElement("img");
                img.loading = "lazy";
                img.draggable = false;
                img.src = appimg(it.cover);
                b.appendChild(img);
            }
            tabsEl.appendChild(b);
        }
        const cur = tabsEl.querySelector(".is-active");
        // 只滚底栏自己：scrollIntoView 会连带滚动外层，QQ 看到滚动就把表情面板收起了
        if (cur) {
            const l = cur.offsetLeft - tabsEl.offsetLeft, rgt = l + cur.offsetWidth;
            if (l < tabsEl.scrollLeft) tabsEl.scrollLeft = l;
            else if (rgt > tabsEl.scrollLeft + tabsEl.clientWidth) tabsEl.scrollLeft = rgt - tabsEl.clientWidth;
        }
        const files = tab === FAV ? data.favs : ((data.groups.find(g => g.name === tab) || {}).files || []);
        grid.innerHTML = "";
        const title = document.createElement("div");
        title.className = "qe-sp-title";
        title.textContent = (tab === FAV ? "收藏" : tab) + (files.length ? " · " + files.length : "");
        grid.appendChild(title);
        if (!files.length) {
            const empty = document.createElement("div");
            empty.className = "qe-sp-empty";
            if (tab === FAV) empty.innerHTML = data.groups.length
                ? "还没有收藏<br>在表情上点右上角的星标，或右键它，就会收进这里"
                : "表情文件夹是空的<br>点右下角<b>文件夹</b>按钮，把图片放进去<br>每个子文件夹会成为一个分组";
            else empty.textContent = "这个分组里没有图片";
            grid.appendChild(empty);
            return;
        }
        const frag = document.createDocumentFragment();
        for (const p of files) {
            const cell = document.createElement("div");
            cell.className = "qe-sp-cell" + (favSet.has(p) ? " is-fav" : "");
            cell.dataset.path = p;
            cell.title = p.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
            const img = document.createElement("img");
            img.loading = "lazy";
            img.decoding = "async";
            img.draggable = false;
            img.src = appimg(p);
            const star = document.createElement("div");
            star.className = "qe-sp-star";
            star.title = favSet.has(p) ? "取消收藏" : "收藏";
            star.innerHTML = STAR;
            cell.appendChild(img);
            cell.appendChild(star);
            frag.appendChild(cell);
        }
        grid.appendChild(frag);
    }

    // 整个盖住 QQ 的表情面板（内容区 + 分类栏）
    function place() {
        const sp = stickerPanel();
        if (!sp) return false;
        const r = sp.getBoundingClientRect();
        view.style.left = Math.round(r.left) + "px";
        view.style.top = Math.round(r.top) + "px";
        view.style.width = Math.round(r.width) + "px";
        view.style.height = Math.round(r.height) + "px";
        view.style.borderRadius = getComputedStyle(sp.closest(".expression-panel") || sp).borderRadius;
        return true;
    }

    function follow() {
        raf = 0;
        if (!active) return;
        if (!place()) { setLast(true); deactivate(); return; }
        raf = requestAnimationFrame(follow);
    }

    function markTab(on) {
        const tc = document.querySelector(".expression-panel .tabs-container");
        if (!tc) return;
        const mine = document.querySelector(".expression-panel .qe-st-tab");
        if (on) {
            tc.querySelectorAll("." + ACTIVE_CLS).forEach(n => { if (n !== mine) { n.classList.remove(ACTIVE_CLS); n.dataset.qeWasActive = "1"; } });
            if (mine) { mine.classList.add(ACTIVE_CLS); mine.setAttribute("aria-pressed", "true"); }
        } else {
            if (mine) { mine.classList.remove(ACTIVE_CLS); mine.setAttribute("aria-pressed", "false"); }
            tc.querySelectorAll("[data-qe-was-active]").forEach(n => { n.classList.add(ACTIVE_CLS); delete n.dataset.qeWasActive; });
        }
    }

    function activate() {
        build();
        active = true;
        document.body.classList.add("qe-st-active");
        markTab(true);
        if (place()) view.classList.add("is-open");
        render();
        reload();                                       // 每次切过来都重扫一遍，刚放进去的图马上能看到
        if (!raf) raf = requestAnimationFrame(follow);
    }

    function deactivate() {
        active = false;
        document.body.classList.remove("qe-st-active");
        if (view) view.classList.remove("is-open");
        markTab(false);
    }

    // 点 QQ 自带的分类：回到 QQ 的内容
    document.addEventListener("click", e => {
        const item = e.target.closest && e.target.closest(".expression-panel .tabs-container-item");
        if (!item) return;
        if (item.classList.contains("qe-st-tab")) {
            e.stopPropagation();
            e.preventDefault();
            if (!active) activate();
            return;
        }
        if (active) { setLast(false); deactivate(); }
    }, true);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && active) { setLast(true); deactivate(); } }, true);
    addEventListener("hashchange", () => { if (active) { setLast(true); deactivate(); } });
    // 点输入框上的「表情」按钮：面板可能只是显示/隐藏，不触发 DOM 增删，主动看几次
    document.addEventListener("click", e => {
        if (!(e.target.closest && e.target.closest('.chat-func-bar .icon-item[aria-label="表情"]'))) return;
        [60, 200, 400].forEach(ms => setTimeout(ensureTab, ms));
    }, true);

    function applyNativeTabs() {
        const cfg = getConfig();
        for (const [key, , id] of NATIVE_TABS) {
            const attr = "data-qe-hide-" + id;
            const hide = cfg[key] === false;
            if (document.body.hasAttribute(attr) !== hide) document.body.toggleAttribute(attr, hide);
        }
    }

    function ensureTab() {
        applyNativeTabs();
        const bar = document.querySelector(".expression-panel .sticker-panel__bar");
        const tc = bar && bar.querySelector(".tabs-container");
        const on = !!getConfig().stickers;
        // 面板开/关要在任何提前 return 之前记下：面板关掉时底栏也没了，
        // 以前会直接 return，panelWasOpen 一直停在 true，下次打开就认不出“刚打开”
        const open = !!(on && tc && stickerPanel());
        const justOpened = open && !panelWasOpen;
        panelWasOpen = open;
        // 底栏出来了但面板还在展开动画里（尺寸不够）：过一会再看一次
        if (on && tc && !open) {
            if (!recheck) { if (recheckLeft <= 0) recheckLeft = 10; recheck = setTimeout(() => { recheck = 0; recheckLeft--; if (recheckLeft > 0) ensureTab(); }, 60); }
        } else recheckLeft = 0;
        const old = document.querySelectorAll(".qe-st-tab");
        if (!on || !tc) { old.forEach(n => n.remove()); if (!on && active) deactivate(); return; }
        if (old.length === 1 && bar.firstElementChild !== old[0]) bar.prepend(old[0]);   // Vue 重排后可能被挤到后面
        if (!(old.length === 1 && bar.contains(old[0]))) {
            old.forEach(n => n.remove());
            const item = document.createElement("div");
            item.className = "tabs-container-item qe-st-tab";
            item.setAttribute("role", "button");
            item.setAttribute("aria-label", LABEL);
            item.setAttribute("aria-pressed", "false");
            item.title = LABEL;
            item.tabIndex = -1;
            item.innerHTML = ICON;
            // 带上 QQ 分类按钮的 scoped 属性（data-v-xxx），图标颜色等样式和原生的一致
            const sib = tc.querySelector(".tabs-container-item");
            if (sib) for (const a of sib.attributes) if (a.name.startsWith("data-v-")) item.setAttribute(a.name, "");
            bar.prepend(item);
        }
        if (active) markTab(true);                      // QQ 重渲染时会把它自己那项重新点亮
        // 面板刚打开：上次停在本地表情页就切回来
        if (justOpened && lastOursVal && !active) activate();
    }

    return { ensure: ensureTab, reload, hide: deactivate };
}
