# tavern-stack

SillyTavern（ST）加一个 LLM 网关、用文件管设置的 seed、酒馆助手脚本，以及给其他机器用的两种打包（精简版 Docker、手机 Termux）。全部由 `docker-compose.yml` 启动。

ST 里的聊天地址永远是 `http://gateway:8789/v1`。换上游只改 `.gateway.env`，ST 的设置不动。

```
./st.sh        重启容器（先重跑 st-init，seed 的改动才生效）
./st.sh re     重建容器（改了 docker-compose.yml 之后用）
./st.sh logs   所有服务的日志（带时间）写进 $SCRATCH/st/all.log，容器重建后要重开

gateway      gateway.mjs：OpenAI 兼容上游前面的一层
st-init      一次性任务：装酒馆助手、提示词模板、Edge TTS 插件，再应用 ./seed
sillytavern  :8000，局域网可访问
```

上游（CLIProxyAPI）不在这个仓库里，`.gateway.env` 的 `UPSTREAM_URL` 现在指向云上的服务。`.env`（不提交）可放 `LLM_HOST`，也就是这台机器在局域网里的地址，打精简版包时用。

## 网关

`cp .gateway.env.example .gateway.env`，填好后 `./st.sh re`。

| 变量 | 作用 |
|---|---|
| `UPSTREAM_URL` | 上游基础地址（必填） |
| `UPSTREAM_KEY` | 上游的 key；留空就不发 `Authorization` |
| `MODEL` | 替换 ST 要的模型名，ST 的模型栏留空 |
| `BODY` | JSON，合并进每个请求，用来关推理；写法因上游而异（OpenRouter 用 `{"reasoning":{"enabled":false}}`，cpa 用 `{"reasoning_effort":"low"}`） |
| `RETRIES` | 额外重试次数，默认 2 |
| `ORIGINS` | 允许浏览器直接请求网关的页面来源，默认 `127.0.0.1:8000` 和 `localhost:8000`；用局域网地址打开 ST 时要加上 |

- 重试：429/502/503/504、网络错误、200 但 `choices` 为空（Gemini 偶发）、上游内容过滤（`blocked: finish_reason=…`）。用完仍失败就把错误交给 ST。流式请求不检查。
- 末尾是 assistant 的请求：上游返回 400 且含 `ending with a model turn` 时，补一条 `user: Continue.` 重发，并记住这个上游。
- 日志一行：`模型 状态 耗时 in= out= reasoning=`。网关没有超时。
- 网关发布在 `0.0.0.0:8789`，前面没有鉴权，局域网里的设备都能用你的上游额度。

## 状态

- ST 的数据都在内存盘 `$SCRATCH/st` 下，聊天记录也是，重启就没了。想留的聊天在 ST 的 "Manage chat files" 里下载。
- 每次启动后刷新 ST 页面，并关掉其他标签页，否则旧页面会把旧设置写回去，覆盖 seed。
- 只重启 ST：`docker stop sillytavern && docker start -a st-init && docker start sillytavern`。

## Seed

`seed/` 每次启动由 `merge-settings.mjs` 应用，优先级高于界面里的修改。

| 文件 | 怎么应用 |
|---|---|
| `seed/settings.json` | 深度合并进用户的 `settings.json`（对象合并，数组和标量替换） |
| `seed/scripts/*.js` | 酒馆助手全局脚本；同名（`// @name`）的被替换，自己建的保留；改名后旧条目要手动删 |
| `seed/QuickReplies/*.json` | 复制进快捷回复集；文件名就是集合名 |
| `seed/avatars/*.png` | 复制进 `User Avatars/`；`user-default.png` 是 persona 齐野的头像 |

快捷回复 `quick-replies`：`代写`（id 2）、`更多`（id 3）、`全屏`（id 4）。脚本按 id 引用；改 id 要同步改 `page.js` 和 `story.js` 里的常量。

## 打包

```
./pack-lite.sh [输出]     另一台机器上的 Docker 版：只有 ST 和 st-init，聊天走这台机器的网关，没有生图
./pack-mobile.sh [输出]   手机 Termux：ST 和网关都在手机上，聊天直连 .gateway.env 里的上游
```

- 精简版的 seed 和这里只差两处：去掉 `sd`，`story.pictures` 设为 `false`。`.env` 里的 `LLM_HOST` 没设时 `pack-lite.sh` 会报错。解压后 `docker compose up -d --force-recreate`。
- 手机版的 `.gateway.env` 原样带进去（里面可能有 key，别外传压缩包）。`sd` 的三个地址改成 `192.168.31.171`，PC 开着时生图可用，`story.pictures` 保持 `true`。解压后 `bash start.sh`（第一次会装 node、clone ST、装扩展），访问 `http://<手机IP>:8000`。更新时用 `tar -xzf … --exclude='st-mobile/SillyTavern'`，不要覆盖已装的 ST。

## 图像后端

地址都在 `seed/settings.json`，ST 的"图像生成"来源下拉框里切换，`source` 是默认来源（`sdcpp`）。

| 来源 | 地址 | 说明 |
|---|---|---|
| `sdcpp` | `host.docker.internal:1234` | stable-diffusion.cpp，imagegen-stack 的 `run_sdcpp.sh`，要监听 `0.0.0.0`，约 26 秒一张 |
| `comfy` | `host.docker.internal:8188` | ComfyUI，CPU 约 43 秒一张；步数和 CFG 在工作流里 |
| `auto` | `host.docker.internal:7860` | 手机上的 Local Dream（SD1.5） |

步数、CFG、采样器、调度器是共用的。seed 按 Anima-Turbo 写了 `steps: 8`、`scale: 1`、`euler`、`simple`；切到 SD1.5 要在界面里改成约 20 步、CFG 9、DPM++ 2M，重启会按 seed 还原。sdcpp 来源不发 LoRA，要在服务器那边设（`SD_LORA_TAGS`）。

## 页面脚本

`seed/scripts/page.js`（酒馆助手里叫"懒人快捷键"）：

- 没有输入框有焦点时：`u` `,` 向上、`d` `.` 向下翻聊天 0.4 屏；`/` 聚焦输入框；输入框里 `Shift+/` 或 `Esc` 失焦；`Alt+/` 随时运行"代写"。
- 发送消息时输入框会失焦，这样回复期间快捷键可用。
- "全屏"快捷回复：进出浏览器全屏（iPhone Safari 不支持）。
- 生成中，停止按钮上方显示耗时和已收到字数的小药丸。
- 消息 iframe 滚出视野后，暂停里面无限循环的动画（有的卡画动态背景，会占满一个核）。

## 剧情命令

`seed/scripts/story.js` 提供四个斜杠命令，都用 `generateRaw` 发不带预设的干净请求。

| 命令 | 入口 | 作用 |
|---|---|---|
| `/pic me｜you｜face｜bg｜last｜pov｜<描述>` | "更多"菜单 | 让模型写 SD 标签，把完整的 `/sd …` 放进输入框，改完回车才出图。最新剧情含 `EXPLICIT_TERMS` 的词或参数写了 `nsfw` 时，加 `NSFW_BASE` |
| `/imp [草稿]` | "代写"、`Alt+/` | 写玩家接下来的台词或动作，放进输入框，不自动发送；结果没改过时再按是重抽 |
| `/sum` | "更多"菜单 | 把聊天总结成 500 到 800 字的长期记忆，弹窗里复制，贴进"作者注释" |
| `/more` | "更多"快捷回复 | 弹出小菜单 |

- 不认标签名：一条回复按"顶层标签块 + 标签外文字"切段，名字含 `think`/`thought`/`reason`/`analy` 的和像 JSON 的不算，字最多的那段当故事。朗读（TTS）用同一套，另有 `settings.json` 里的保守正则兜底，钩子只装给 Edge 提供方。
- 人称、语言、时态一律照玩家自己的发言，脚本不绑某张卡或预设。
- 标签怎么写全在 `STYLE`（给 Anima）和 `SD15_RULES`（`auto` 来源才加）这两段文字里，代码不改写标签；换了生图模型只改文字。
- 生图本身是 ST 的 `/sd`。魔杖菜单里的生图项用 ST 自带模板，会被拒绝，请用 `/pic`。
- 某个命令没反应时，按 F12 看控制台。

提示词调参结论（样本小，看趋势）：
- Anima：250 字符上限要留，放宽到 400 会漂；发色眼色、衣着、年代和文化要写明；三人及以上用 `3women`、`2men, 1woman` 这类通用写法。
- SD1.5（Anything V5）：CFG 9、20 步；单人用竖画布加 `solo`，否则常画成孪生；两人时互动标签放最前；`cow print` 这类带动物名的词会被画成动物，不要写。
- 通用：关推理的小模型有时写分析不写标签，所以回复要校验；有的上游会把 "Draw …" 开头的请求误判成生图并限额，任务用 "Write the prompt for …"，一次只发一个请求。

## 工具

`tools/wd-tag.sh`：图片反推标签，调 [wd-tagger Space](https://huggingface.co/spaces/SmilingWolf/wd-tagger)，图片会上传到 Space，每张 11 到 20 秒。

```
tools/wd-tag.sh                  交互：Ctrl+V 或回车读剪贴板里的图片，也可粘贴或拖入文件路径，q 退出
tools/wd-tag.sh [-v] [-n] 图.png  标签打到标准输出并复制到剪贴板；-n 不复制，-v 加分级和置信度
```

环境变量：`WD_MODEL`、`WD_GENERAL`（0.35）、`WD_CHARACTER`（0.85）、`WD_URL`、`HF_TOKEN`、`WD_COPY=0`。

## 自检

```
node merge-settings.mjs --self-test
node gateway.mjs --self-test
```

## 酒馆助手和提示词模板

酒馆助手的仓库名是 JS-Slash-Runner，所以扩展列表里搜"酒馆助手"找不到。提示词模板是 ST-Prompt-Template。两个都由 `st-init` 装到 `$SCRATCH/st/extensions`，已存在就跳过；酒馆助手要 ST 1.13.0 及以上。

自动安装失败（`docker compose logs st-init`）时，在 ST 的扩展页 Install extension，填 https://github.com/N0VI028/JS-Slash-Runner（国内用 https://gitlab.com/novi028/JS-Slash-Runner），装完刷新。要重装先删 `$SCRATCH/st/extensions/JS-Slash-Runner` 再 `./st.sh`。

## 许可

MIT，见 `LICENSE`。仓库里不含第三方的预设和角色卡，不要放进来再公开推送。`init.sh` 装的各扩展有自己的许可。
