# QQ 增强（LiteLoaderQQNT 插件）

功能性改动的合集。外观相关的（主题、Markdown、@ 高亮、名字颜色、入场动画）在 `liuli-dsh-theme` 里。

设置：QQ 设置左栏「QQ 增强」，每项单独开关，改了立刻生效。

| 功能 | 说明 |
|---|---|
| 防撤回 | 别人撤回的消息照常显示，标「已撤回 · 撤回人」。自己用管理员身份撤回别人的也保留；自己撤回自己的不管（保留「重新编辑」）。移植自 BetterQQNT 的 AntiRecallPlugin |
| 记住浏览位置 | 切回会话时停在上次看到的地方（Telegram 的做法）；上次在底部就留在底部 |
| 右键复读 | 消息右键菜单「转发」下面加「复读」，调内核 `forwardMsgWithComment` 原样转发回当前会话 |
| 引用时不带 @ | 点「引用」后删掉 QQ 自动插入的 `@对方` |

## 数据

`%APPDATA%\LiteLoaderQQNT\data\qq-enhance\`

- `config.json`：开关
- `anti-recall\messages\<msgId>.json`：被撤回消息的原文
- `anti-recall\recalled.json`：撤回列表（重启后仍有标记）
- `plugin.log`：日志

第一次启动会从旧的独立 `anti-recall` 插件目录搬一次数据。

## 实测依据（QQ 9.9.36）

- 内核消息下行：`webContents.send("RM_IPCFROM_MAIN…", meta, {cmdName, payload})`
- 内核调用上行：`RM_IPCFROM_RENDERER<id>`，`{type:"request", callbackId, eventName:"ntApi", peerId}` + `{cmdName, cmdType:"invoke", payload:[arg, null]}`
- 消息数据：`.message` 元素的 `__VUE__[0].props.msgRecord`
- 输入框里引用插入的 @：`<span class="editor-el__at" contenteditable="false">`
- 撤回字段：`revokeElement.isSelfOperate / operatorUid / origMsgSenderUid`

## 测试

```powershell
node test/anti-recall.test.cjs
```

## 安装

1. 按 [LiteLoaderQQNT 官方文档](https://liteloaderqqnt.github.io/guide/install.html) 装好 LiteLoaderQQNT
2. 把本仓库放到 `LiteLoaderQQNT\plugins\qq-enhance\`
3. 重启 QQ

外观部分见姊妹插件 [qqnt-liuli-theme](https://github.com/LilycleHeart/qqnt-liuli-theme)。
