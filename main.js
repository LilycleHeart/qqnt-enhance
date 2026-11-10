// QQ 增强 · SnowLora 适配版（主进程）
// 由 SnowLora 注入到 QQ 主进程执行；同一进程只初始化一次。
// 与 LiteLoader 版的差异：
//   - 数据目录改到 QQ userData\snowlora\qq-enhance
//   - 设置读写改为本地 JSON（不再用 LiteLoader.api.config）
//   - renderer 通过 console token 通道通信（SnowLora 没有 preload/IPC）
//   - ipcMain.handle 改为桥接方法；防撤回/复读/表情包逻辑保持不变
//
// 移植进度（对照 LiteLoader 版 v1.3.0 / 上游 commit b226822）：
//   [x] DEFAULTS 增加 pokeNoCd / pangu（setConfig 的键白名单依赖它）
//       pokeNoCd 默认 **false**（维护者拍板：绕过 QQ 10 秒冷却默认不生效）、pangu 默认 true
//   [x] 桥方法 poke（戳一戳无冷却）：chatType 转 Number 且只认 1/2；私聊 chatUin 用 peerUin
//   [x] pangu：整段同步上游 b226822（ASCII 早退、围栏代码块/行内代码/URL/Windows 路径占位保护、
//       Symbol.for("qqEnhance.panguHook") 状态单例），与上游逐字一致
//   [x] wc.send 代理支持 thenable 返回值（异步防撤回用）
//   [x] hookWindow 监听器累积修复（R1）
//   [x] M5 防撤回异步重写：对齐上游 b226822 的 handle()/restoreOne/collectMessageRecords/预取，
//       兜底（50ms×11 重试、500ms 硬超时、recentFetches 5s 去重、MAX_RECORDS=1000）原样保留
const BUILD = '1.3.0+snowlora.2';
const require = process.getBuiltinModule('module').createRequire(snowlora.script);
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const SLUG = 'qq-enhance';
const root = path.dirname(snowlora.script);
const DATA = path.join(app.getPath('userData'), 'snowlora', SLUG);
const LEGACY_DATA = path.join(process.env.APPDATA || '', 'LiteLoaderQQNT', 'data', SLUG);
const LEGACY_STICKERS = path.join(LEGACY_DATA, 'stickers');
const AR_DIR = path.join(DATA, 'anti-recall');
const MSG_DIR = path.join(AR_DIR, 'messages');
const RECALLED_FILE = path.join(AR_DIR, 'recalled.json');
const CONFIG_FILE = path.join(DATA, 'config.json');
const LOG = path.join(DATA, 'plugin.log');
const RENDERER_FILE = path.join(root, 'renderer.js');

const DEFAULTS = {
  antiRecall: true,
  chatPos: true,
  repeat: true,
  pokeNoCd: false,
  quoteNoAt: true,
  arkExternal: true,
  pangu: true,
  stickers: true,
  stickerDir: '',
  showEmojiSearch: true,
  showEmojiDefault: true,
  showEmojiFav: true,
};

fs.mkdirSync(MSG_DIR, { recursive: true });

function log(message) {
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + message + '\n');
  } catch (e) {}
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return String(v);
      if (v instanceof Map) return Object.fromEntries(v);
      return v;
    });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

/* ---------- 从 LiteLoader 版迁移数据（只搬配置/防撤回/收藏，不搬 stickers） ---------- */
(function migrate() {
  try {
    if (!fs.existsSync(LEGACY_DATA) || fs.existsSync(path.join(DATA, '.migrated-ll'))) return;
    fs.mkdirSync(DATA, { recursive: true });
    for (const name of ['config.json', 'sticker-favs.json']) {
      const src = path.join(LEGACY_DATA, name);
      const dst = path.join(DATA, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
    for (const name of ['anti-recall', 'sticker-cache']) {
      const src = path.join(LEGACY_DATA, name);
      const dst = path.join(DATA, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.cpSync(src, dst, { recursive: true });
    }
    fs.writeFileSync(path.join(DATA, '.migrated-ll'), new Date().toISOString());
    log('migrated config/anti-recall from ' + LEGACY_DATA + ' (stickers stay in place)');
  } catch (e) {
    log('migrate failed: ' + e.message);
  }
})();

/* ---------- 设置 ---------- */
let config = Object.assign({}, DEFAULTS);
try {
  config = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {});
} catch (e) {}
function saveConfig() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    log('save config failed: ' + e.message);
  }
}

/* ---------- 防撤回：存储 ---------- */
const MAX_CACHE = 5000;
const MAX_RECALLED = 3000;
const UPDATE_CMDS = new Set([
  'nodeIKernelMsgListener/onMsgInfoListUpdate',
  'nodeIKernelMsgListener/onActiveMsgInfoUpdate',
]);

const cache = new Map();
const recalled = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(RECALLED_FILE, 'utf8'));
  for (const [id, nick] of Object.entries(saved)) recalled.set(id, nick);
} catch (e) {}

let saveTimer = null;
function saveRecalled() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    while (recalled.size > MAX_RECALLED) recalled.delete(recalled.keys().next().value);
    try {
      fs.writeFileSync(RECALLED_FILE, JSON.stringify(Object.fromEntries(recalled)));
    } catch (e) {
      log('save recalled failed: ' + e.message);
    }
  }, 500);
}

const safeId = id => String(id).replace(/[^0-9A-Za-z_-]/g, '');
const clone = v => {
  try {
    return structuredClone(v);
  } catch (e) {
    return JSON.parse(stringify(v), revive);
  }
};
const MAP_TAG = '__qqeMap';
const stringify = v =>
  JSON.stringify(v, (_k, x) => (x instanceof Map ? { [MAP_TAG]: [...x.entries()] } : x));
const revive = (_k, x) =>
  x && typeof x === 'object' && Array.isArray(x[MAP_TAG]) && Object.keys(x).length === 1
    ? new Map(x[MAP_TAG])
    : x;
function toMap(o) {
  if (o instanceof Map) return o;
  const m = new Map();
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) m.set(/^\d+$/.test(k) ? Number(k) : k, v);
  return m;
}
function fixMaps(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  if (!(msg.msgAttrs instanceof Map)) msg.msgAttrs = toMap(msg.msgAttrs);
  for (const el of Array.isArray(msg.elements) ? msg.elements : []) {
    if (!el || typeof el !== 'object') continue;
    for (const sub of Object.values(el)) {
      if (sub && typeof sub === 'object' && 'thumbPath' in sub && !(sub.thumbPath instanceof Map)) sub.thumbPath = toMap(sub.thumbPath);
    }
  }
  return msg;
}

function remember(msg) {
  const id = String(msg.msgId);
  if (cache.has(id)) cache.delete(id);
  cache.set(id, clone(msg));
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}
function lookup(id) {
  id = String(id);
  if (cache.has(id)) return cache.get(id);
  const file = path.join(MSG_DIR, safeId(id) + '.json');
  try {
    if (fs.existsSync(file)) {
      const msg = fixMaps(JSON.parse(fs.readFileSync(file, 'utf8'), revive));
      cache.set(id, msg);
      return msg;
    }
  } catch (e) {}
  return null;
}
function persist(msg) {
  const file = path.join(MSG_DIR, safeId(msg.msgId) + '.json');
  if (fs.existsSync(file)) return;
  fs.writeFile(file, stringify(msg), () => {});
}

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
function isOwnRecall(rv) {
  if (!rv.isSelfOperate) return false;
  const op = rv.operatorUid,
    orig = rv.origMsgSenderUid;
  if (!orig || !op) return true;
  return String(op) === String(orig);
}
// 收集事件里所有消息记录（不只 msgList：快速撤回时原文可能挂在 payload.records 等位置）
// 上限不能太小：一次 onMsgInfoListUpdate 可能带几百条（切会话、补历史），
// 截断后这些消息既不进缓存、撤回也命中不了。
const MAX_RECORDS = 1000;
function collectMessageRecords(value, out, seen, depth) {
  if (!value || typeof value !== 'object' || depth > 6 || out.length >= MAX_RECORDS) return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectMessageRecords(item, out, seen, depth + 1);
    return out;
  }
  if (value.msgId !== undefined && Array.isArray(value.elements)) {
    out.push(value);
    return out;
  }
  for (const key of Object.keys(value)) collectMessageRecords(value[key], out, seen, depth + 1);
  return out;
}

function restoreOne(msg, rv, cmd) {
  const id = String(msg.msgId);
  const old = lookup(id);
  if (!old || !Array.isArray(old.elements) || revokeOf(old)) return false;

  const nick = rv.isSelfOperate ? '你' : (rv.operatorMemRemark || rv.operatorRemark || rv.operatorNick || '对方');
  const copy = clone(old); // 副本：QQ 之后原地改对象也不影响缓存
  for (const k of Object.keys(copy)) msg[k] = copy[k];
  persist(old);
  // 只有第一次登记时才广播：重试循环和 QQ 的重复推送都会再调进来，
  // 无条件广播会让界面收到 N 次 recalled。
  if (!recalled.has(id)) {
    recalled.set(id, nick);
    saveRecalled();
    log('recalled ' + id + ' by ' + nick + ' via ' + (cmd || 'response'));
    setTimeout(() => broadcastEvent('recalled', id, nick), 100);
  }
  return true;
}

function collectRecentTargets(value, out, seen, depth) {
  if (!value || typeof value !== 'object' || depth > 8 || out.length >= 30) return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRecentTargets(item, out, seen, depth + 1);
    return out;
  }
  const msgId = value.msgId == null ? '' : String(value.msgId);
  const chatType = Number(value.chatType ?? value.peer?.chatType);
  const peerUid = String(value.peerUid ?? value.peer?.peerUid ?? '');
  const guildId = String(value.guildId ?? value.peer?.guildId ?? '');
  if (msgId && Number.isFinite(chatType) && chatType > 0 && peerUid) {
    if (!out.some(item => item.msgId === msgId)) out.push({ msgId, chatType, peerUid, guildId });
    return out;
  }
  for (const key of Object.keys(value)) collectRecentTargets(value[key], out, seen, depth + 1);
  return out;
}

const recentFetches = new Map();
function fetchMessageByTarget(wc, target) {
  if (!wc || wc.isDestroyed?.() || !target || !target.msgId || String(target.msgId) === '0') return Promise.resolve([]);
  if (recentFetches.has(target.msgId)) return Promise.resolve([]);
  recentFetches.set(target.msgId, Date.now());
  return invokeNT(wc.id, 'nodeIKernelMsgService/getMsgsByMsgId', [{
    peer: {
      chatType: target.chatType,
      peerUid: String(target.peerUid),
      guildId: String(target.guildId || ''),
    },
    msgIds: [String(target.msgId)],
  }, null]).then(result => {
    const records = collectMessageRecords(result, [], new WeakSet(), 0);
    for (const msg of records) remember(msg);
    log('proactive fetch ' + target.msgId + ' -> ' + records.length);
    return records;
  }).catch(e => {
    log('proactive fetch failed: ' + (e && e.message || e));
    return [];
  }).finally(() => {
    setTimeout(() => recentFetches.delete(target.msgId), 5000);
  });
}

function scheduleRecentFetches(wc, args) {
  const targets = collectRecentTargets(args, [], new WeakSet(), 0).filter(t => String(t.msgId) !== '0');
  // 启动/切换账号时最近联系人快照会一次带几十条历史，没必要全量拉；
  // 新消息的增量事件通常只有 1~3 条，按需缓存即可。
  if (targets.length > 12) {
    log('recent fetch baseline skipped ' + targets.length);
    return;
  }
  for (const target of targets.slice(0, 8)) fetchMessageByTarget(wc, target);
}

// 返回 true 表示整条发送要拦掉；返回 Promise 表示撤回原文还没到，先等一小段时间
function handle(args, wc) {
  if (!config.antiRecall) return false;

  const cmd = args && args[1] && args[1].cmdName;
  if (cmd && cmd.includes('onRecentContactListChangedVer2')) {
    try {
      scheduleRecentFetches(wc, args);
    } catch (e) {
      log('recent fetch error: ' + (e && e.message || e));
    }
  }

  const records = collectMessageRecords(args, [], new WeakSet(), 0);
  if (!records.length) return false;
  const recalls = [];
  let cached = false;

  // 先把这一批里的普通消息全部记下来，再处理撤回：即使撤回记录排在原文前面也能命中
  for (const msg of records) {
    if (!msg || msg.msgId === undefined) continue;
    if (revokeOf(msg)) recalls.push(msg);
    else {
      remember(msg);
      cached = true;
    }
  }

  let restoredAll = true;
  let selfRecallSkipped = false; // 自撤回要放行，不能被 restoredAll 当成"还原失败"
  const pending = [];
  for (const msg of recalls) {
    const rv = revokeOf(msg);
    if (!rv || isOwnRecall(rv)) {
      restoredAll = false;
      selfRecallSkipped = true;
      continue;
    }
    if (!restoreOne(msg, rv, cmd)) {
      restoredAll = false;
      pending.push({ msg, rv, cmd });
    }
  }

  // 快速撤回：原文事件可能比撤回事件晚几十毫秒到。先压住撤回事件，
  // 等原文进入缓存后再把消息还原；超时才放行 QQ 的灰条。
  // 只有"整批都是撤回"才压住：同批里若还有普通消息（cached=true），压住会把
  // 新消息一起延迟，这种情况就地还原，还原不了的按灰条照常放行。
  if (pending.length && !cached) {
    return new Promise(resolve => {
      let tries = 0;
      // 硬超时：内核不回包时 invokeNT 要 5s 才超时，不能让它把整条事件压 5 秒
      const hardTimeout = new Promise(r => setTimeout(r, 500));
      const fetches = pending.map(item => fetchMessageByTarget(wc, {
        msgId: item.msg.msgId,
        chatType: item.msg.chatType,
        peerUid: item.msg.peerUid,
        guildId: item.msg.guildId,
      }));
      const finish = () => {
        try {
          let all = true;
          for (const item of pending) {
            if (!restoreOne(item.msg, item.rv, item.cmd)) all = false;
          }
          resolve(all && !selfRecallSkipped && cached === false && UPDATE_CMDS.has(cmd));
        } catch (e) {
          log('restore finish failed: ' + (e && e.stack || e));
          resolve(false);
        }
      };
      const retry = () => {
        try {
          let all = true;
          for (const item of pending) {
            if (!restoreOne(item.msg, item.rv, item.cmd)) all = false;
          }
          if (all) return resolve(!selfRecallSkipped && cached === false && UPDATE_CMDS.has(cmd));
          if (++tries > 10) {
            Promise.race([Promise.all(fetches), hardTimeout]).then(finish, finish);
            return;
          }
          setTimeout(retry, 50);
        } catch (e) {
          // 定时器里抛出的异常不会再被 hookWindow 的 try/catch 接住，
          // 这里必须自己兜底：出错就当作没还原，把原事件放行。
          log('restore retry failed: ' + (e && e.stack || e));
          resolve(false);
        }
      };
      setTimeout(retry, 30);
    });
  }

  return restoredAll && cached === false && UPDATE_CMDS.has(cmd);
}

/* ---------- 调内核接口（复读/表情包） ---------- */
const pendingNT = new Map();
function invokeNT(webContentsId, cmdName, args) {
  return new Promise(resolve => {
    const callbackId = crypto.randomUUID();
    const finish = v => {
      clearTimeout(timer);
      pendingNT.delete(callbackId);
      resolve(v);
    };
    const timer = setTimeout(() => {
      pendingNT.delete(callbackId);
      resolve({ pending: true });
    }, 5000);
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
    ipcMain.emit(
      'RM_IPCFROM_RENDERER' + webContentsId,
      fakeEvent,
      { type: 'request', callbackId, eventName: 'ntApi', peerId: webContentsId },
      { cmdName, cmdType: 'invoke', payload: args }
    );
  });
}

/* ════════════════ 发送时自动 pangu ════════════════
 * 在渲染进程把发送请求交给内核之前改 msgElements 里的文本：聊天框里保持原样，
 * 发出去的内容才带空格，用户不需要任何额外操作。
 * 消息开头两个逗号（,, 或 ，，）时去掉逗号，并且这一条不处理。 */
const CJK_RANGE = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const ANY_CJK = new RegExp("[" + CJK_RANGE + "]");
const COMMA_PREFIX = /^[\s\u00a0]*[,，][,，]/;

function panguSpace(text) {
  if (!text || !ANY_CJK.test(text)) return text; // 纯 ASCII 原样返回：代码、表格、缩进都不能动
  // 用户自己输入了占位符字符（私有区 U+E000/U+E001）时直接跳过，避免被误当成占位符替换
  if (text.indexOf("\uE000") !== -1 || text.indexOf("\uE001") !== -1) return text;
  const saved = [];
  const put = s => { saved.push(s); return "\uE000" + (saved.length - 1) + "\uE001"; };
  // 代码先藏起来，后面所有规则都碰不到它（包括下面的 URL/路径补空格）
  let s = text
    .replace(/```[\s\S]*?```/g, put)                                     // 围栏代码块
    .replace(/`[^`\n]*`/g, put);                                          // 行内代码
  // 中文紧贴 URL / Windows 路径时先补空格：必须在隐藏 URL 之前做，否则补不进保护罩
  s = s.replace(new RegExp("([" + CJK_RANGE + "])(https?:\\/\\/)", "g"), "$1 $2");
  s = s.replace(new RegExp("([" + CJK_RANGE + "])([A-Za-z]:\\\\)", "g"), "$1 $2");
  s = s
    .replace(/https?:\/\/[^\s\uE000\uE001\u3000-\u303f\uff00-\uffef]+/g, put) // URL（含 CJK 路径/参数）
    .replace(/[A-Za-z]:\\[^\s\uE000\uE001]+/g, put);                     // Windows 路径
  s = s.replace(new RegExp("([" + CJK_RANGE + "])([A-Za-z0-9])", "g"), "$1 $2");
  s = s.replace(new RegExp("([A-Za-z0-9])([" + CJK_RANGE + "])", "g"), "$1 $2");
  // 括号只在中文外侧补空格，不往括号里面塞（成对的半角引号不处理，左右难分）
  s = s.replace(new RegExp("([" + CJK_RANGE + "])([\\[({<])", "g"), "$1 $2");
  s = s.replace(new RegExp("([\\])}>])([" + CJK_RANGE + "])", "g"), "$1 $2");
  // 中文与标点之间的多余空格去掉（半角 + 全角），只吃空格/制表符，不吃换行
  s = s.replace(new RegExp("([" + CJK_RANGE + "])[ \\t]+([,.;:!?])", "g"), "$1$2");
  s = s.replace(new RegExp("([" + CJK_RANGE + "])[ \\t]+([、。，：；！？“”（）「」『』【】《》])", "g"), "$1$2");
  // 还原：到这里所有规则都跑完了，代码块 / 行内代码 / URL / 路径都不会再被改
  s = s.replace(/\uE000(\d+)\uE001/g, (_m, i) => saved[Number(i)]);
  // 不合并连续空格、不去掉行首缩进：用户发代码片段/对齐文本时这是有意义的
  return s;
}

function collectTextElements(node, out, depth) {
  if (!node || typeof node !== "object" || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const v of node) collectTextElements(v, out, depth + 1);
    return out;
  }
  const te = node.textElement;
  if (te && typeof te.content === "string") out.push(te);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") collectTextElements(v, out, depth + 1);
  }
  return out;
}

/* 改写发送参数；返回 true 表示动过文本 */
function rewritePangu(payload) {
  const texts = collectTextElements(payload, [], 0).filter(te => !te.atType);
  if (!texts.length) return false;
  // 转义标记按「整条消息的第一个非空文本」判断（QQ 可能先给一个空 textElement）
  const first = texts.find(te => te.content !== "") || texts[0];
  if (first && COMMA_PREFIX.test(first.content)) {
    const stripped = first.content.replace(/^[\s\u00a0]*[,，][,，]/, "");
    if (stripped !== first.content) {
      // 只打了 ",," 时不要改成空消息
      if (!stripped.trim()) return false;
      first.content = stripped;
      return true;
    }
    return false;
  }
  let changed = false;
  for (const te of texts) {
    const t = panguSpace(te.content);
    if (t !== te.content) { te.content = t; changed = true; }
  }
  return changed;
}

/* 钩子只装一次：热重载时更新闭包里的开关/实现，避免在 ipcMain.emit 上层层套娃、
 * 也避免旧包装继续按旧配置改写。 */
const PANGU_HOOK = Symbol.for("qqEnhance.panguHook");
function installPanguHook() {
  if (!ipcMain) return;
  let state = ipcMain[PANGU_HOOK];
  if (!state) {
    state = { installed: false, enabled: () => true, rewrite: () => false };
    Object.defineProperty(ipcMain, PANGU_HOOK, { value: state, configurable: true });
  }
  state.enabled = () => !!config.pangu;
  state.rewrite = rewritePangu;
  if (state.installed || typeof ipcMain.emit !== "function") return;
  state.installed = true;
  const originalEmit = ipcMain.emit.bind(ipcMain);
  ipcMain.emit = function (channel, ...args) {
    try {
      if (state.enabled() && typeof channel === "string" && channel.indexOf("RM_IPCFROM_RENDERER") === 0) {
        const req = args.find(a => a && typeof a === "object" && typeof a.cmdName === "string");
        const payload = req && req.payload;
        // 只认「发消息」请求：回包/其它 cmdName 一律不碰。
        // 用 payload 形态判断而不是 cmdType，避免 QQ 侧换 invoke/send 写法时静默失效。
        if (req && req.cmdName === "nodeIKernelMsgService/sendMsg" &&
          Array.isArray(payload) && payload[0] && Array.isArray(payload[0].msgElements) &&
          state.rewrite(payload)) {
          // 每条被改写的消息都同步写日志会刷屏（appendFileSync），只在首次命中时记一条，便于真机自检
          if (!installPanguHook.logged) { installPanguHook.logged = true; log("pangu sendMsg"); }
        }
      }
    } catch (e) { log("pangu hook failed: " + (e && e.message)); }
    return originalEmit(channel, ...args);
  };
}

installPanguHook();

/* ---------- 窗口 / 桥接 ---------- */
const TOKEN = '__QQE_' + crypto.randomUUID().replace(/-/g, '') + '__';
const injected = new Set();
const injecting = new Map(); // wc.id -> 正在进行的注入 Promise，避免同一文档重复注入

function injectable(url) {
  if (!url || !url.startsWith('app://')) return false;
  if (/hiddenWindow\.html/i.test(url)) return false;
  if (/#\/(av|screenshare|screenselector|tray-menu|blank|mini-fishing)/.test(url)) return false;
  if (/newLogin\.html|screenshot\.html/i.test(url)) return false;
  // 没有路由的页面（hash 为空或只有 '#/'）不注入
  const hash = url.split('#')[1] || '';
  if (!hash || hash === '/') return false;
  return true;
}

function isAlive(wc) {
  try {
    return wc && !wc.isDestroyed();
  } catch (e) {
    return false;
  }
}

function reply(wc, id, result, error) {
  if (!isAlive(wc)) return;
  const payload = safeJson({ result, error: error || null });
  wc.executeJavaScript('window.__qqeBridge && window.__qqeBridge.resolve(' + Number(id) + ',' + payload + ')').catch(() => {});
}

function emitEvent(wc, name, ...args) {
  if (!isAlive(wc) || !injected.has(wc.id)) return;
  const payload = safeJson(args);
  wc.executeJavaScript(
    'window.__qqeBridge && window.__qqeBridge.emit(' + JSON.stringify(name) + ',' + payload + ')'
  ).catch(() => {});
}
function broadcastEvent(name, ...args) {
  for (const wc of BrowserWindow.getAllWindows().map(w => w.webContents)) emitEvent(wc, name, ...args);
}

function bridgeBootstrap() {
  return `(() => {
  if (window.__qqeBridge) return;
  const TOKEN = ${JSON.stringify(TOKEN)};
  const pending = new Map();
  let seq = 0;
  const send = console.debug.bind(console);
  function request(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('QQ 增强宿主响应超时：' + method)); }, 60000);
      pending.set(id, { resolve, reject, timer });
      send(TOKEN + JSON.stringify({ id: id, method: method, args: args || [] }));
    });
  }
  const events = Object.create(null);
  window.__qqeBridge = {
    resolve(id, payload) {
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      clearTimeout(task.timer);
      if (payload && payload.error) task.reject(new Error(payload.error));
      else task.resolve(payload ? payload.result : undefined);
    },
    emit(name, args) {
      const list = events[name];
      if (!list) return;
      for (const cb of list) { try { cb.apply(null, args || []); } catch (e) {} }
    }
  };
  function on(name, cb) { (events[name] || (events[name] = [])).push(cb); }
  window.qq_enhance = {
    getConfig: () => request('getConfig'),
    setConfig: patch => request('setConfig', [patch]),
    onConfigChanged: cb => on('configChanged', cb),
    recalledList: () => request('recalledList'),
    onRecalled: cb => on('recalled', cb),
    stats: () => request('stats'),
    clearSaved: () => request('clearSaved'),
    repeat: msg => request('repeat', [msg]),
    poke: ctx => request('poke', [ctx]),
    openExternal: url => request('openExternal', [url]),
    stickerList: () => request('stickerList'),
    stickerFav: (file, on) => request('stickerFav', [file, on]),
    stickerSend: (peer, file, hint) => request('stickerSend', [peer, file, hint]),
    stickerOpenDir: () => request('stickerOpenDir'),
    stickerPickDir: () => request('stickerPickDir')
  };
})();`;
}

function inject(wc) {
  if (!isAlive(wc)) return null;
  const url = wc.getURL();
  if (!injectable(url)) return null;
  // 同一 wc 正在注入时直接复用，不再叠加一次 executeJavaScript
  const running = injecting.get(wc.id);
  if (running) return running;
  let rendererSource = '';
  try { rendererSource = fs.readFileSync(RENDERER_FILE, 'utf8'); } catch (e) { log('renderer.js missing: ' + e.message); return null; }
  injected.add(wc.id);
  // 页面侧再判一次标记：renderer 里全在同一个 if 块内执行，
  // 顶层 const/let/class 变成块作用域（重复执行不会 "Identifier has already been declared"）。
  const wrapped =
    'if (!window.__qqeRendererLoaded) { window.__qqeRendererLoaded = true;\n' +
    rendererSource +
    '\n}';
  const task = wc.executeJavaScript(bridgeBootstrap())
    .then(() => wc.executeJavaScript(wrapped))
    .then(() => log('renderer injected wc=' + wc.id + ' ' + url))
    .catch(e => log('inject failed wc=' + wc.id + ': ' + e.message))
    .then(() => { injecting.delete(wc.id); });
  injecting.set(wc.id, task);
  return task;
}

function hookWindow(window) {
  const wc = window.webContents;
  if (!isAlive(wc)) return;
  // 同一个 wc 只挂一次 hook。
  // 设置窗常见"window_created 一次 + settings-hook.js 再调 __qqEnhanceEnsureSettings 一次"，
  // 重复注册 did-finish-load/dom-ready/console-message 会不断累积（R1）。
  // 第二次进来只补一次注入，页面加载完就注入，没加载完等它自己的事件。
  if (wc.__qqeHooked) {
    if (!wc.isLoading()) inject(wc);
    return;
  }
  wc.__qqeHooked = true;
  const send = wc.send;
  wc.send = function (channel, ...args) {
    if (typeof channel === 'string' && channel.includes('RM_IPCFROM_')) {
      const meta = args[0];
      if (meta && meta.callbackId && pendingNT.has(meta.callbackId)) {
        const done = pendingNT.get(meta.callbackId);
        pendingNT.delete(meta.callbackId);
        done(args[1]);
        return;
      }
      try {
        const result = handle(args, wc);
        // 异步处理器（M5 的快速撤回：撤回事件先压住，等原文进缓存再决定要不要转发）。
        // 返回 thenable 时先不发；resolve(false) 才把原消息放给界面，异常也一律放行，
        // 绝不因为我们的逻辑出错而永久吞掉一条消息。
        if (result && typeof result.then === 'function') {
          result.then(handled => {
            if (!handled) {
              try { send.call(wc, channel, ...args); } catch (e) {}
            }
          }).catch(e => {
            log('handle async error: ' + (e && e.stack ? e.stack : e));
            try { send.call(wc, channel, ...args); } catch (err) {}
          });
          return;
        }
        if (result) return;
      } catch (e) {
        log('handle error: ' + (e && e.stack ? e.stack : e));
      }
    }
    return send.apply(this, [channel, ...args]);
  };
  wc.on('console-message', details => {
    try {
      const message = details && details.message;
      if (typeof message !== 'string' || !message.startsWith(TOKEN)) return;
      if (details.frame && details.frame !== wc.mainFrame) return;
      if (message.length > 4 * 1024 * 1024) return;
      const req = JSON.parse(message.slice(TOKEN.length));
      if (!Number.isSafeInteger(req.id) || !req.id || !Object.hasOwn(methods, req.method)) return;
      log('bridge ' + req.method);
      Promise.resolve(methods[req.method](req.args || [], wc))
        .then(result => reply(wc, req.id, result))
        .catch(e => reply(wc, req.id, null, (e && e.message) || String(e)));
    } catch (e) {
      log('bridge parse failed: ' + e.message);
    }
  });
  wc.once('destroyed', () => {
    injected.delete(wc.id);
    injecting.delete(wc.id);
  });
  wc.on('did-finish-load', () => inject(wc));
  wc.on('dom-ready', () => inject(wc));
  wc.on('did-navigate-in-page', () => inject(wc));
  if (!wc.isLoading()) inject(wc);
}

/* ---------- 表情包 ---------- */
const DEFAULT_STICKER_DIR = fs.existsSync(LEGACY_STICKERS) ? LEGACY_STICKERS : path.join(DATA, 'stickers');
const FAV_FILE = path.join(DATA, 'sticker-favs.json');
const STICKER_CACHE = path.join(DATA, 'sticker-cache');
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const MAX_PER_GROUP = 2000;

function stickerRoot() {
  const dir = (config.stickerDir || '').trim();
  return dir ? path.resolve(dir) : DEFAULT_STICKER_DIR;
}
try {
  fs.mkdirSync(DEFAULT_STICKER_DIR, { recursive: true });
} catch (e) {}

let favs = [];
try {
  favs = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')).filter(x => typeof x === 'string');
} catch (e) {
  favs = [];
}
function saveFavs() {
  try {
    fs.writeFileSync(FAV_FILE, JSON.stringify(favs));
  } catch (e) {
    log('save favs failed: ' + e.message);
  }
}
const extOf = p => path.extname(p).slice(1).toLowerCase();
const byName = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true });

function collectImages(dir, out, depth) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  ents.sort((a, b) => byName(a.name, b.name));
  for (const e of ents) {
    if (out.length >= MAX_PER_GROUP) break;
    const full = path.join(dir, e.name);
    if (e.isFile() && IMG_EXT.has(extOf(e.name))) out.push(full);
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.')) collectImages(full, out, depth - 1);
  }
  return out;
}

function listStickers() {
  const rootDir = stickerRoot();
  const groups = [];
  let ents = [];
  try {
    ents = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (e) {}
  const loose = ents.filter(e => e.isFile() && IMG_EXT.has(extOf(e.name))).map(e => path.join(rootDir, e.name)).sort(byName);
  for (const e of ents.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => byName(a.name, b.name))) {
    const files = collectImages(path.join(rootDir, e.name), [], 4);
    if (files.length) groups.push({ name: e.name, files });
  }
  if (loose.length) groups.push({ name: '未分组', files: loose.slice(0, MAX_PER_GROUP) });
  const existing = favs.filter(f => fs.existsSync(f));
  return { root: rootDir, groups, favs: existing, isDefault: !config.stickerDir };
}

function insideRoot(p) {
  try {
    const rootDir = fs.realpathSync(stickerRoot());
    const real = fs.realpathSync(p);
    const rel = path.relative(rootDir, real);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (e) {
    return false;
  }
}

function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
      }
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (e) {}
  return null;
}

/* ---------- 桥接方法 ---------- */
const methods = {
  getConfig: () => config,
  setConfig: ([patch]) => {
    const next = Object.assign({}, config);
    for (const k of Object.keys(DEFAULTS)) if (patch && typeof patch[k] === typeof DEFAULTS[k]) next[k] = patch[k];
    config = next;
    saveConfig();
    broadcastEvent('configChanged', config);
    log('config ' + JSON.stringify(config));
    return config;
  },
  recalledList: () => Object.fromEntries(recalled),
  stats: () => {
    let files = 0,
      bytes = 0;
    try {
      for (const f of fs.readdirSync(MSG_DIR)) {
        files++;
        bytes += fs.statSync(path.join(MSG_DIR, f)).size;
      }
    } catch (e) {}
    return { saved: files, bytes, recalled: recalled.size, cached: cache.size };
  },
  clearSaved: () => {
    let n = 0;
    try {
      for (const f of fs.readdirSync(MSG_DIR)) {
        fs.unlinkSync(path.join(MSG_DIR, f));
        n++;
      }
    } catch (e) {}
    recalled.clear();
    saveRecalled();
    log('cleared ' + n + ' saved messages');
    broadcastEvent('configChanged', config);
    return n;
  },
  repeat: async ([msg], wc) => {
    if (!config.repeat) return { error: '复读已关闭' };
    try {
      if (!msg || !msg.msgId) return { error: 'no msg' };
      const contact = { chatType: msg.chatType, peerUid: msg.peerUid, guildId: msg.guildId || '' };
      const res = await invokeNT(wc.id, 'nodeIKernelMsgService/forwardMsgWithComment', [
        {
          msgIds: [String(msg.msgId)],
          srcContact: contact,
          dstContacts: [contact],
          commentElements: [],
          msgAttributeInfos: new Map(),
        },
        null,
      ]);
      log('repeat ' + msg.msgId + ' -> ' + JSON.stringify(res).slice(0, 200));
      return res;
    } catch (e) {
      log('repeat failed: ' + e.message);
      return { error: e.message };
    }
  },
  // 戳一戳无冷却：界面把「戳一戳」菜单项的点击拦下来后走这里，直接调内核 sendNudge，
  // QQ 自己的 10 秒冷却判断不会跑。私聊的 chatUin 用会话对方的 uin，群聊用群号（peerUid）。
  // 逻辑与 LiteLoader 版 main/index.js 的 CH.poke 处理器一致。
  poke: async ([ctx], wc) => {
    if (!config.pokeNoCd) return { error: '戳一戳无冷却已关闭' };
    try {
      if (!ctx || !ctx.peerUid || !ctx.targetUin) return { error: '没认出戳的是谁' };
      const chatType = Number(ctx.chatType);
      if (chatType !== 1 && chatType !== 2) return { error: '没认出戳的是谁' };
      const peer = { chatType, peerUid: String(ctx.peerUid), guildId: ctx.guildId || '' };
      // 私聊的 chatUin 是「会话对方的 uin」，不是被戳目标：戳自己的消息时两者不同
      const chatUin = chatType === 1 ? String(ctx.peerUin || ctx.targetUin) : String(ctx.peerUid);
      const res = await invokeNT(wc.id, 'nodeIKernelMsgService/sendNudge', [
        { peer, targetUin: String(ctx.targetUin), chatUin },
        null,
      ]);
      log('nudge ' + peer.peerUid + ' -> ' + ctx.targetUin + ' : ' + JSON.stringify(res).slice(0, 200));
      return res;
    } catch (e) {
      log('nudge failed: ' + e.message);
      return { error: e.message };
    }
  },
  openExternal: async ([url]) => {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      await shell.openExternal(u.href);
      log('open external ' + u.href);
      return true;
    } catch (e) {
      log('open external failed: ' + e.message);
      return false;
    }
  },
  stickerList: () => listStickers(),
  stickerFav: ([p, on]) => {
    if (typeof p !== 'string') return favs;
    favs = favs.filter(x => x !== p);
    if (on && insideRoot(p)) favs.unshift(p);
    saveFavs();
    broadcastEvent('configChanged', config);
    return favs;
  },
  stickerOpenDir: () => {
    const rootDir = stickerRoot();
    try {
      fs.mkdirSync(rootDir, { recursive: true });
    } catch (e) {}
    return shell.openPath(rootDir);
  },
  stickerPickDir: async (_args, wc) => {
    const win = BrowserWindow.fromWebContents(wc) || undefined;
    const res = await dialog.showOpenDialog(win, {
      title: '选择表情包文件夹',
      defaultPath: stickerRoot(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    config = Object.assign({}, config, { stickerDir: res.filePaths[0] });
    saveConfig();
    broadcastEvent('configChanged', config);
    return config;
  },
  stickerSend: async ([peer, file, hint], wc) => {
    if (!config.stickers) return { error: '本地表情包已关闭' };
    try {
      if (!peer || !peer.peerUid || typeof file !== 'string') return { error: '没有找到当前会话' };
      if (!IMG_EXT.has(extOf(file)) || !(insideRoot(file) || favs.includes(file))) return { error: '只能发送表情文件夹里的图片' };
      const buf = fs.readFileSync(file);
      const md5 = crypto.createHash('md5').update(buf).digest('hex');
      const ext = extOf(file) === 'jpeg' ? 'jpg' : extOf(file);
      const size = imageSize(buf) || { w: Number(hint && hint.w) || 200, h: Number(hint && hint.h) || 200 };
      const fileName = md5 + '.' + ext;
      const wcId = wc.id;
      let dst = await invokeNT(wcId, 'nodeIKernelMsgService/getRichMediaFilePathForGuild', [
        {
          path_info: { md5HexStr: md5, fileName, elementType: 2, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' },
        },
        null,
      ]);
      if (typeof dst !== 'string' || !dst) {
        log('sticker: no rich media path (' + JSON.stringify(dst).slice(0, 120) + '), use cache');
        fs.mkdirSync(STICKER_CACHE, { recursive: true });
        dst = path.join(STICKER_CACHE, fileName);
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (!fs.existsSync(dst)) fs.copyFileSync(file, dst);
      const pic = {
        elementType: 2,
        elementId: '',
        picElement: {
          fileName,
          fileSize: String(buf.length),
          fileSubId: '',
          fileUuid: '',
          md5HexStr: md5,
          original: true,
          picWidth: size.w,
          picHeight: size.h,
          picSubType: 0,
          picType: ext === 'gif' ? 2000 : 1001,
          sourcePath: dst,
          summary: '',
          thumbFileSize: 0,
        },
      };
      const res = await invokeNT(wcId, 'nodeIKernelMsgService/sendMsg', [
        {
          msgId: '0',
          peer: { chatType: peer.chatType, peerUid: String(peer.peerUid), guildId: peer.guildId ? String(peer.guildId) : '' },
          msgElements: [pic],
          msgAttributeInfos: new Map(),
        },
        null,
      ]);
      log('sticker ' + path.basename(file) + ' -> ' + JSON.stringify(res).slice(0, 160));
      return res;
    } catch (e) {
      log('sticker failed: ' + (e && e.stack ? e.stack : e));
      return { error: e.message };
    }
  },
};

/* ---------- 初始化（只做一次） ---------- */
// SnowLora 的 shell watcher 命中设置窗时，settings-hook.js 会调这里；
// 不依赖标题，URL 里带 #/setting 就立刻 hook 并注入。
globalThis.__qqEnhanceEnsureSettings = wc => {
  try {
    if (!wc || wc.isDestroyed()) return false;
    if (!String(wc.getURL()).includes('#/setting')) return false;
    const win = BrowserWindow.fromWebContents(wc);
    if (win) hookWindow(win);
    inject(wc);
    return true;
  } catch (e) {
    return false;
  }
};

async function init() {
  app.on('browser-window-created', (_event, window) => {
    try {
      hookWindow(window);
    } catch (e) {
      log('hook failed: ' + e.message);
    }
  });
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      hookWindow(window);
    } catch (e) {
      log('hook existing failed: ' + e.message);
    }
  }
  log('main loaded | build=' + BUILD + ' | qqnt=' + process.versions.qqnt + ' recalled=' + recalled.size + ' config=' + JSON.stringify(config));
}

if (!globalThis.__qqEnhanceMain) {
  globalThis.__qqEnhanceMain = init();
}
await globalThis.__qqEnhanceMain;
