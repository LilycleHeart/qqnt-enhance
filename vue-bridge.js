/* QQ 增强 · SnowLora 适配版：Vue 实例桥
 * 原插件依赖 LiteLoader renderer hook 注入的 element.__VUE__。
 * SnowLora 没有这个 hook，这里从 #app.__vue_app__ 的根 vnode 反向遍历，
 * 把组件实例回填到对应 DOM 元素上；之后新挂载的组件由 MutationObserver + 定时器补。
 * 实测 QQ 9.9.36：.message.__VUE__[0].props.msgRecord 可正常取到。
 */
(() => {
  if (window.__qeVueBridge) return;
  window.__qeVueBridge = true;

  function mapVue() {
    try {
      const appEl = document.getElementById('app');
      const app = appEl && appEl.__vue_app__;
      const root = app && app._container && app._container._vnode;
      if (!root) return 0;
      let count = 0;
      const seen = new Set();
      const walk = (vnode, depth) => {
        if (!vnode || typeof vnode !== 'object' || depth > 80 || seen.has(vnode)) return;
        seen.add(vnode);
        if (vnode.__v_isVNode) {
          const el = vnode.el;
          if (el && el.nodeType === 1) {
            if (!el.__VUE__) el.__VUE__ = [];
            if (vnode.component && !el.__VUE__.includes(vnode.component)) {
              el.__VUE__.push(vnode.component);
              count++;
            }
          }
          if (vnode.component) walk(vnode.component.subTree, depth + 1);
          if (Array.isArray(vnode.children)) {
            for (const child of vnode.children) walk(child, depth + 1);
          } else if (vnode.children && typeof vnode.children === 'object' && vnode.children.__v_isVNode) {
            walk(vnode.children, depth + 1);
          }
          if (vnode.suspense) walk(vnode.suspense.activeBranch, depth + 1);
        }
      };
      walk(root, 0);
      return count;
    } catch (e) {
      return 0;
    }
  }

  window.__qeMapVue = mapVue;
  mapVue();
  let timer = 0;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      mapVue();
    }, 100);
  };
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(mapVue, 2000);
})();
