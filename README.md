# tavern-stack

两部分：

- 仓库根目录：Tavern Stack，一个 SillyTavern 扩展（`manifest.json`、`index.js`、`profiles.js`、`style.css`）。
- `stack/`：SillyTavern 加 LLM 网关的 Docker 部署、seed、聊天工具，见 `stack/README.md`。

## Tavern Stack 扩展

只用酒馆官方的扩展接口（`SillyTavern.getContext()`），不依赖酒馆助手。

- 规则（profile）：按角色名决定发什么提示词。一条规则有名称、适用角色（名字里包含的文字，或 `/正则/`）、若干提示词（标签、深度、role、文字）。匹配的角色在每次生成前，这些提示词用 `setExtensionPrompt` 插进聊天里，和预设、世界书无关，换预设也在。默认带一条「大凉龙虎传」：页眉和落卷每轮必须输出（七格页眉的字段取自 v4.15 世界书，第一格、第二格也是 v4.11 的时间脚本读的那两格）。
- 设置页：扩展 → Tavern Stack。可开关扩展和悬浮按钮，新建、删除、编辑规则和提示词。设置存在 ST 的扩展设置里。
- 悬浮按钮 🧰：可拖动，位置会记住；点开面板，能勾选当前角色匹配的提示词，还有「代写」（`/imp {{input}}`）、「更多」（`/more`，菜单在按钮上方）、「全屏」、「设置」。它取代了输入框下面的快捷回复栏（seed 里已关掉）；`Alt+/` 等键盘快捷键仍在 `stack/seed/scripts/page.js`。
- 群聊没有「当前角色」，规则不生效。

## 安装

在 ST 的扩展页 Install extension，填 `https://github.com/aar0u/tavern-stack`；`stack/` 里的部署会自动装它（`stack/init.sh`）。更新在扩展页点更新。

## 检查

```
node --test profiles.test.mjs
```

测的是规则的逻辑；`index.js` 和页面要在 ST 里看。
