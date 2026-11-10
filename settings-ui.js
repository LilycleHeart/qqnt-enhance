/* QQ 增强 · SnowLora 适配版：设置入口
 * 唯一入口：QQ 设置窗（#/setting）里的「QQ 增强」导航页——
 * 按 LiteLoader 的挂载方式克隆 .nav-item，
 * 内容放进 .setting-main .setting-main__content，点导航切页。
 * SnowLora 主进程在 browser-window-created 时就会 hook 设置窗，
 * 这里在 DOM 就绪后立刻挂载，不依赖标题匹配。
 * 主窗不再提供齿轮按钮 / 页内对话框：非设置窗直接返回，连样式都不注入。 */
(() => {
  if (window.__qqEnhanceSettingsUi) return;
  window.__qqEnhanceSettingsUi = true;
  if (location.hash.indexOf('#/setting') !== 0) return;
  if (!window.qq_enhance) return;
  if (typeof onSettingWindowCreated === 'function') window.__qeRenderSettings = onSettingWindowCreated;

  const CSS = `
.qe-settings-view setting-section { display: block; margin: 4px 0 18px; }
.qe-settings-view setting-section::before {
  content: attr(data-title); display: block; margin: 0 0 8px; font-size: 12px; font-weight: 600;
  letter-spacing: .04em; opacity: .55;
}
.qe-settings-view setting-panel,
.qe-settings-view setting-list { display: block; }
.qe-settings-view setting-item {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 10px 12px; border-radius: 10px; background: rgba(127,127,127,.08);
}
.qe-settings-view setting-item + setting-item { margin-top: 6px; }
.qe-settings-view setting-text { display: block; font-size: 13px; line-height: 1.5; }
.qe-settings-view setting-text[data-type="secondary"] { margin-top: 2px; font-size: 11.5px; opacity: .55; }
.qe-settings-view setting-switch {
  flex: 0 0 auto; position: relative; width: 36px; height: 20px; border-radius: 999px;
  background: rgba(127,127,127,.4); cursor: pointer; transition: background .15s;
}
.qe-settings-view setting-switch[is-active] { background: var(--ll-brand, #1d9bf0); }
.qe-settings-view setting-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.35);
  transition: transform .15s;
}
.qe-settings-view setting-switch[is-active]::after { transform: translateX(16px); }
.qe-settings-view setting-button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 26px; padding: 0 12px;
  border-radius: 8px; border: 1px solid rgba(127,127,127,.25); background: rgba(127,127,127,.1);
  color: inherit; font-size: 12px; cursor: pointer;
}
.qe-settings-view setting-button:hover { background: rgba(127,127,127,.18); }

.qe-settings-view { box-sizing: border-box; padding: 8px 26px 28px; }
.qe-settings-view::before { content: none; }
.qe-nav-item .name { font-size: 14px; }
`;
  const style = document.createElement('style');
  style.id = 'qq-enhance-ui-style';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);

  /* ---------- 设置窗：挂到 QQ 设置页 ---------- */
  let tries = 0;
  let installed = false;
  const mount = () => {
    if (installed) return;
    const tab = document.querySelector('.setting-tab');
    const navBar = document.querySelector('.setting-tab .nav-bar');
    const main = document.querySelector('.setting-main .setting-main__content');
    const original = document.querySelector('.setting-main .q-scroll-view');
    const title = document.querySelector('.setting-main .setting-title');
    const sample = navBar && navBar.querySelector('.nav-item');
    if (!tab || !navBar || !main || !original || !title || !sample) {
      if (tries++ < 60) setTimeout(mount, 250);
      return;
    }
    const nav = sample.cloneNode(true);
    nav.classList.remove('nav-item-active');
    nav.classList.add('qe-nav-item');
    nav.removeAttribute('data-slug');
    const name = nav.querySelector('.name');
    if (name) name.textContent = 'QQ 增强';
    else nav.textContent = 'QQ 增强';
    const group = document.createElement('div');
    group.className = 'nav-bar qe-nav';
    group.append(nav);
    tab.append(group);

    const view = document.createElement('div');
    view.className = 'q-scroll-view scroll-view--show-scrollbar qe-settings-view';
    view.style.display = 'none';
    main.append(view);

    let titleNode = null;
    let titleSaved = null;
    const showOther = () => {
      view.style.display = 'none';
      original.style.display = 'block';
      if (titleNode && titleSaved !== null && titleNode.isConnected) titleNode.nodeValue = titleSaved;
      titleNode = null;
      titleSaved = null;
    };
    nav.addEventListener('click', async () => {
      if (!view.dataset.ready) {
        view.dataset.ready = '1';
        try {
          await window.__qeRenderSettings(view);
        } catch (e) {
          view.textContent = 'QQ 增强设置加载失败：' + (e && e.message ? e.message : e);
        }
      }
      original.style.display = 'none';
      view.style.display = 'block';
      // 标题是 <div.setting-title><div.icon-area/> 通用<!--v-if--></div>：改 icon-area 后面的文本节点。
      // childNodes[1] 是 icon-area 本身，改它会让标题变成「QQ 增强通用」。离开时还原，Vue 在值没变时不会重绘。
      const titleText = [...title.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim());
      if (titleText) {
        if (titleSaved === null) titleSaved = titleText.nodeValue;
        titleNode = titleText;
        titleText.nodeValue = ' QQ 增强';
      }
      tab.querySelectorAll('.nav-item').forEach(el => el.classList.remove('nav-item-active'));
      nav.classList.add('nav-item-active');
    });
    tab.addEventListener('click', e => {
      const item = e.target.closest && e.target.closest('.nav-item');
      if (item && item !== nav) showOther();
    }, true);
    installed = true;
  };
  mount();
})();
