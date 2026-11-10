# QQ 增强 · qq-enhance（SnowLora 版）

QQNT 功能插件合集：防撤回 · 记住浏览位置 · 右键复读 · 发送时自动 pangu · 引用不带 @ · 戳一戳无冷却 · 卡片用浏览器打开 · 本地表情包。

> LiteLoaderQQNT 版在 [liteloader 分支](https://github.com/LilycleHeart/qqnt-enhance/tree/liteloader)。

main 分支是 **SnowLora 版**：由 SnowLora 外部注入，不修改 QQ 安装文件。需要 SnowLora 0.3.0 及以上（见 `snowlora-plugin.json` 的 `minSnowLora`），在 Windows 版 QQ 9.9.36 上开发和测试。外观相关的（主题、Markdown、@ 高亮、名字颜色、入场动画）在姊妹插件 **[琉璃 Liuli · qqnt-liuli-theme](https://github.com/LilycleHeart/qqnt-liuli-theme)** 里。

## 功能

| 功能 | 说明 |
|---|---|
| **防撤回** | 别人撤回的消息照常显示，标「已撤回 · 撤回人」。自己用管理员身份撤回别人的也保留；自己撤回自己的不管（保留「重新编辑」）。只能还原加载器启动后收到的消息 |
| **记住浏览位置** | 切回会话时停在上次看到的地方；上次在底部就留在底部 |
| **右键复读** | 消息右键菜单「转发」下面加「复读」，调内核 `forwardMsgWithComment` 原样转发回当前会话 |
| **发送时自动 pangu** | 发出去的文本自动在中英文、中文与数字之间补空格。消息开头打两个逗号（`,,` 或 `，，`）则这条不处理，逗号本身也会去掉 |
| **引用时不带 @** | 点「引用」或双击消息引用后，删掉 QQ 自动插入的 `@对方` |
| **戳一戳无冷却** | 右键头像点「戳一戳」不再受 10 秒冷却限制，可以连续戳。点的时候把界面自己的处理截下来，直接调内核 `sendNudge` 发，冷却判断不会跑。**默认关闭**，需要时在设置页打开 |
| **卡片用浏览器打开** | 点 B 站、腾讯文档等「QQ小程序」分享卡片，取卡片里的网页链接用默认浏览器打开，不再弹「文件已损坏，请重新安装QQ」。没有网页链接的卡片照旧交给 QQ |
| **本地表情包** | 表情面板底部多一个「本地表情」分类：每个子文件夹是一个分组，另有独立的收藏分组。点一下直接发送，Ctrl/Shift + 点击发完不收起面板；底栏文件夹可拖动排序，设置页能隐藏 QQ 自带的「搜索表情」「默认表情」「我的收藏」 |

设置：QQ 设置窗左侧「**QQ 增强**」，每项单独开关，改了立刻生效。

## 安装

推荐在 QQ 设置 → SnowLora 页安装：

- 插件上架到 [SnowLuma/snowlora-plugins](https://github.com/SnowLuma/snowlora-plugins) 索引后，会出现在「可安装插件」里；该索引当前未公开；
- 也可以在本仓库 [Releases](https://github.com/LilycleHeart/qqnt-enhance/releases) 下载 `qq-enhance-<版本>.zip`（tag 形如 `v1.3.0+snowlora.2`），用「从本地安装」安装。

装完重启 QQ，QQ 设置窗左侧出现「QQ 增强」即加载成功。

手动放置（开发者）：把本仓库文件复制到 SnowLora 目录下的 `assets/qq-enhance/`，确认 `snowlora-plugin.json` 里的规则分别是 `script: main.js` 和 `script: settings-hook.js`，然后重启 QQ。

## 数据与配置

目录：`QQ userData\snowlora\qq-enhance`（Windows 上通常是 `%APPDATA%\QQ\snowlora\qq-enhance`）。

| 文件 | 内容 |
|---|---|
| `config.json` | 各功能开关、表情文件夹位置 |
| `stickers\` | 默认的表情文件夹（设置页可换成别的文件夹） |
| `sticker-favs.json` | 本地表情的收藏 |
| `anti-recall\messages\<msgId>.json` | 被撤回消息的原文 |
| `anti-recall\recalled.json` | 撤回列表（重启后仍有标记） |
| `plugin.log` | 日志 |

表情文件夹默认位置：如果原来的 LiteLoader 数据目录还在，**优先沿用** `%APPDATA%\LiteLoaderQQNT\data\qq-enhance\stickers`（旧表情不用搬）；否则用上面目录下的 `stickers\`。

迁移：首次运行会把旧数据目录里的 `config.json`、`sticker-favs.json`、`anti-recall`、`sticker-cache` 复制过来，**`stickers` 保留在原路径不复制**。

## 与 LiteLoader 版的差异

- **配置与数据**：配置从 `LiteLoader.api.config` 改成数据目录下的本地 JSON，数据目录从 `LiteLoader.path.data\qq-enhance` 改到 `QQ userData\snowlora\qq-enhance`（见上一节）。
- **通信**：SnowLora 没有 preload / IPC，renderer 改走 console token 通道，并提供 `window.qq_enhance` 兼容层；琉璃的「卡片用浏览器打开」靠它避免重复处理。
- **Vue 实例**：LiteLoader 版由 renderer hook 注入 `element.__VUE__`，这里改为从 `#app.__vue_app__` 根 vnode 反向遍历、MutationObserver 回填。
- **设置页**：只在 QQ 设置窗里挂「QQ 增强」页（仍用 `setting-*` 标签 + CSS 重绘），主窗不再有齿轮按钮和页内对话框。
- **多窗口**：主窗、设置窗、独立聊天窗（`chatPoolWin=1` 的 `#/chat`）注入；无路由（空 hash / `#/`）、`#/av`、托盘、截图、登录窗、`hiddenWindow` 跳过；同一文档只注入一次。

## 已知限制

- **设置入口只有一处**：QQ 设置窗（`#/setting`）里的「QQ 增强」页。设置页在文档加载时就要求 URL 已带 `#/setting`；设置窗若先以空 hash 加载，需要等它跳到 `#/setting` 后才会注入。
- 防撤回只能恢复**加载器启动后**收到的消息，启动前的历史无法还原；它依赖对 `webContents.send` 的代理，属于侵入式 hook，不需要时请在设置里关掉。
- 同一 WebContents 的重复触发（`did-finish-load` / `dom-ready` / `did-navigate-in-page`）由页面内标记 + 主进程 in-flight Map 去重，不会重复执行 renderer；若注入当天 renderer 出错，本页不会自动重试（刷新窗口即可）。
- 复读、本地表情包会调用内核发送接口（与手动操作等价），不建议高频使用。
- 设置页的 `setting-*` 标签是轻量 CSS 重绘，不是 LiteLoader 原生组件；功能一致，观感有差异。

## 目录结构

```
snowlora-plugin.json  插件清单：id、版本、minSnowLora、两条规则（main.js / settings-hook.js）
main.js               主进程：配置读写、防撤回、pangu 与 sendNudge hook、桥接方法、窗口注入与去重、旧数据迁移
settings-hook.js      设置窗创建钩子：让「QQ 增强」页在设置窗里挂上
renderer.js           renderer 包（由 build.py 生成，被 main.js 注入页面）
settings-ui.js        设置页 UI 源，构建时拼进 renderer.js
vue-bridge.js         Vue 实例访问兼容层，构建时拼进 renderer.js
build.py              从 LiteLoader 版源码拼出 renderer.js
```

## 构建 renderer

`renderer.js` 由上游 LiteLoader 版源码拼成。`build.py` 的默认路径指向作者本地的备份目录，换机器后不存在，用前请显式传入 LiteLoader 版插件目录：

```powershell
python build.py <qq-enhance LiteLoader 版目录>
```

输出 `renderer.js`；`settings-ui.js`、`vue-bridge.js` 由脚本拼接进去。

## 发布

```bash
node <snowlora-plugins>/tools/pack-plugin.mjs . --repo LilycleHeart/qqnt-enhance
gh release create "v<版本>" --repo LilycleHeart/qqnt-enhance "dist/qq-enhance-<版本>.zip"
```

这里**不需要** `--latest=false`：本仓库没有 LiteLoader 一键安装器，`releases/latest` 没有别的用途，SnowLora 版就是这个仓库的最新 release。

发完之后把 `dist/*.index-entry.json` 的内容提 PR 到 [SnowLuma/snowlora-plugins](https://github.com/SnowLuma/snowlora-plugins) 的 `plugins.json`，规范见该仓库的 `docs/`。

## 风险提示

移植机制本身不改 QQ 文件、不加网络请求；但**防撤回**（拦截消息、落盘）和**发送类**（复读、表情包、pangu）属于行为层面的修改，是否触发风控无法保证。建议默认关闭不用的项。

## 问题反馈

到 [Issues](https://github.com/LilycleHeart/qqnt-enhance/issues) 提。请附上 QQ 与 SnowLora 的版本号，以及数据目录里 `plugin.log` 的相关片段。
