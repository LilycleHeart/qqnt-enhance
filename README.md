<div align="center">

# ⚡ QQ 增强 · qq-enhance

**QQNT 功能插件合集：防撤回 · 记住浏览位置 · 右键复读 · 引用不带 @**

[![LiteLoaderQQNT](https://img.shields.io/badge/LiteLoaderQQNT-1.4.1-7c6ce6?style=flat-square)](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT)
[![QQ](https://img.shields.io/badge/QQ-9.9.36%20%28Win%29-1d9bf0?style=flat-square)](https://im.qq.com/)
[![platform](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20mac-888?style=flat-square)](#)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](#)

<img src="https://count.getloli.com/get/@qqnt-enhance?theme=gelbooru" alt="访问计数" />

</div>

---

> 功能性改动的合集。外观相关的（主题、Markdown、@ 高亮、名字颜色、入场动画）在姊妹插件 **[琉璃 Liuli · qqnt-liuli-theme](https://github.com/LilycleHeart/qqnt-liuli-theme)** 里。
>
> 设置：QQ 设置左栏「**QQ 增强**」，每项单独开关，改了立刻生效。

## 📸 预览

<div align="center">

<!-- SCREENSHOTS -->
<img src="assets/screenshots/settings.svg" alt="设置页示意" width="760" />

<br/><br/>

<img src="assets/screenshots/anti-recall.svg" alt="防撤回示意" width="760" />

<br/>
<sub>示意图，非实机截图</sub>

</div>

## ✨ 功能

| | 功能 | 说明 |
|---|---|---|
| 🛡️ | **防撤回** | 别人撤回的消息照常显示，标「已撤回 · 撤回人」。自己用管理员身份撤回别人的也保留；自己撤回自己的不管（保留「重新编辑」）。移植自 BetterQQNT 的 AntiRecallPlugin |
| 📍 | **记住浏览位置** | 切回会话时停在上次看到的地方（Telegram 的做法）；上次在底部就留在底部 |
| 🔁 | **右键复读** | 消息右键菜单「转发」下面加「复读」，调内核 `forwardMsgWithComment` 原样转发回当前会话 |
| 💬 | **引用时不带 @** | 点「引用」后删掉 QQ 自动插入的 `@对方` |

## 📦 安装

### 第一步：装好 LiteLoaderQQNT

本插件是标准 [**LiteLoaderQQNT**](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT) 插件，先按官方方式让 QQ 加载 LiteLoader。

QQ 9.9.x 会校验自身文件，直接改会被拦。用**文件校验补丁**绕过（向作者索取，或见姊妹仓库 `docs/patch/`）：

| 文件 | 放到哪里 | 作用 |
|---|---|---|
| `dbghelp_x64.dll` → 改名 `dbghelp.dll` | QQ 安装目录（和 `QQ.exe` 同级，如 `C:\Program Files\Tencent\QQNT\`） | 跳过文件校验，加载 LiteLoader |
| `QQ.exe`（补丁版） | QQ 安装目录，覆盖原来的 | 配套补丁，缺它启动会报「文件损坏」 |

> **先备份**原来的 `dbghelp.dll` 和 `QQ.exe` 再覆盖。完整步骤见 [LiteLoaderQQNT 官方文档](https://liteloaderqqnt.github.io/guide/install.html)。

### 第二步：装插件

1. 把本仓库放到 `LiteLoaderQQNT\plugins\qq-enhance\`
2. 重启 QQ
3. QQ 设置左栏找到「**QQ 增强**」，按需开关各功能

## 🗄️ 数据

`%APPDATA%\LiteLoaderQQNT\data\qq-enhance\`

| 文件 | 内容 |
|---|---|
| `config.json` | 四个功能的开关 |
| `anti-recall\messages\<msgId>.json` | 被撤回消息的原文 |
| `anti-recall\recalled.json` | 撤回列表（重启后仍有标记） |
| `plugin.log` | 日志 |

第一次启动会从旧的独立 `anti-recall` 插件目录搬一次数据。

## 🔬 实测依据（QQ 9.9.36）

- 内核消息下行：`webContents.send("RM_IPCFROM_MAIN…", meta, {cmdName, payload})`
- 内核调用上行：`RM_IPCFROM_RENDERER<id>`，`{type:"request", callbackId, eventName:"ntApi", peerId}` + `{cmdName, cmdType:"invoke", payload:[arg, null]}`
- 消息数据：`.message` 元素的 `__VUE__[0].props.msgRecord`
- 输入框里引用插入的 @：`<span class="editor-el__at" contenteditable="false">`
- 撤回字段：`revokeElement.isSelfOperate / operatorUid / origMsgSenderUid`

## 🧪 测试

```powershell
node test/anti-recall.test.cjs
```

---

<div align="center">
<sub>基于 <a href="https://github.com/LiteLoaderQQNT/LiteLoaderQQNT">LiteLoaderQQNT</a> · 部分移植自 BetterQQNT</sub>
</div>
