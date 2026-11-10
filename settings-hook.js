// QQ 增强 · 设置窗创建钩子
// SnowLora 的 shell watcher 在窗口创建瞬间按规则（title_contains 为空 = 不过滤标题）
// 调用本脚本；这里只处理 #/setting 窗口，其他窗口直接返回。
const require = process.getBuiltinModule('module').createRequire(snowlora.script);
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const wanted = String(snowlora.window || '').toLowerCase();
const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
let wc = null;
for (const win of windows) {
  try {
    if (win.getNativeWindowHandle().readBigUInt64LE().toString(16) === wanted) {
      wc = win.webContents;
      break;
    }
  } catch (e) {}
}
if (!wc) wc = windows.map(w => w.webContents).find(w => String(w.getURL()).includes('#/setting')) || null;

try {
  fs.appendFileSync(path.join(process.env.APPDATA || '', 'QQ', 'snowlora', 'qq-enhance', 'settings-hook.log'), new Date().toISOString() + ' hwnd=' + wanted + ' url=' + (wc ? wc.getURL() : 'none') + '\\n');
} catch (e) {}
if (wc && typeof globalThis.__qqEnhanceEnsureSettings === 'function') {
  globalThis.__qqEnhanceEnsureSettings(wc);
}
