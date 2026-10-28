# tavern-stack

SillyTavern（ST）加一个 LLM 网关、用文件管设置的 seed、酒馆助手脚本，以及给其他机器用的部署和打包（远端 Docker、精简版 Docker、手机 Termux）。主机和远端 mc 用同一个 `docker-compose.yml`。

ST 里的聊天地址在 `seed/settings.json` 里默认是 `http://host.docker.internal:3425/v1`（上游在同一台主机上）；部署到远端时，`deploy_to_mc.sh` 把它和故事神谕、生图的地址换成运行 LLM 接口（3425）和生图后端（1234）那台主机的 IP，所以 ST 里看到的是真实地址，网络怎么通不在本仓库里。上游要 key：直连时在 ST 里把它填成自定义 API 密钥（密钥不能放进 seed）。直连没有重试，错误原样显示，方便调试。要经过网关（换成 Gemini 之类需要重试和修补的上游），把 `seed/settings.json` 的 `custom_url` 改回 `http://gateway:8789/v1`，上游在 `gateway.env` 里改（精简版和手机版另有地址，见"打包"）。模型在 ST 里选。

```
./st.sh        重启容器（先重跑 st-init，seed 的改动才生效）
./st.sh re     重建容器（改了 docker-compose.yml 之后用）
./st.sh logs   所有服务的日志（带时间）写进 $SCRATCH/st/all.log，容器重建后要重开

gateway      gateway.mjs：OpenAI 兼容上游前面的一层，发布 0.0.0.0:8789（默认不用，见上）
st-perms     一次性任务：建状态目录并改成 1000:1000，免得 Docker 建成 root 的
st-init      一次性任务：装酒馆助手、提示词模板、故事神谕、Edge TTS 插件，再应用 ./seed
sillytavern  :8000，局域网可访问
```

上游服务不在本仓库里，经网关时地址写在 `gateway.env`。

状态目录由环境变量 `ST_ROOT` 决定（下面有 `config`、`data`、`plugins`、`extensions`）：`st.sh` 设为 `$SCRATCH/st`，远端和精简版的 `.env` 设为 `./data`。`ST_RESTART` 是容器的 `restart` 策略，默认 `no`，远端和精简版设为 `unless-stopped`。打精简版包之前，在不入库的 `.env` 里把 `LLM_HOST` 设为网关所在主机，没有默认值。

## 网关

经过网关时，ST 连固定地址 `http://gateway:8789/v1`，上游地址和 key 写在 `gateway.env`，换上游不用动 ST。改完 `gateway.env` 后重建容器。

```dotenv
UPSTREAM_URL=http://host.docker.internal:8317/v1
UPSTREAM_KEY=
```

| 变量 | 作用 |
|---|---|
| `UPSTREAM_URL` | 上游基础地址（必填） |
| `UPSTREAM_KEY` | 上游的 key；留空就不发 `Authorization` |

`gateway.env` 入库，不要提交真实的部署地址或凭据。`deploy_to_mc.sh` 每次把远端的 `gateway.env` 写成 `UPSTREAM_URL=http://<上游主机的 IP>:3425/v1`，`UPSTREAM_KEY` 留空。

功能：
- 转发 `/v1/chat/completions` 和 `/v1/models`。模型和请求参数（`reasoning_effort`、采样参数等）原样透传，有 key 就带上。空的 `reasoning_effort`（`''`、`null`）会被剥掉。
- 重试：429/502/503/504、网络错误、200 但 `choices` 为空（Gemini 偶发）、上游内容过滤。用完仍失败，就把原因（`finish_reason`）作为错误交给 ST。流式请求不检查。
- 请求以 assistant 消息结尾时，上游若回 400（`ending with a model turn`），补一条 `user: Continue.` 重发，并按模型记住。
- ST 点停止按钮、客户端断开时，同时中止上游请求。
- CORS 对所有来源开放，页面里的脚本可以直接请求。
- 日志一行：`模型 状态 耗时 [(stream)] effort= in= out= reasoning= think= finish=`，没有的字段不显示。`reasoning` 是上游报的推理 token 数（cpa 没思考时不报）；`think` 是返回的推理文本字符数（部分模型只报 token 不返回文本）。

网关没有超时。它发布在 `0.0.0.0:8789`，前面没有鉴权，局域网里的设备都能用你的上游额度。

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

`oai_settings.custom_include_body` 在 seed 里是空的，所以默认不发推理档位。要指定档位，在 ST 里把它改成 `reasoning_effort: low`（或 `medium`/`high`，YAML 格式，对所有模型生效，重启后回到 seed 的空值）。直连时空值不要写成 `reasoning_effort: ''`，因为只有网关会把它剥掉。

快捷回复 `quick-replies`：`代写`（id 2）、`更多`（id 3）、`全屏`（id 4）。脚本按 id 引用；改 id 要同步改 `page.js` 和 `story.js` 里的常量。

## 打包

```
./deploy_to_mc.sh [主机]  部署 ST 和网关到远端（默认 ssh 主机 mc），那台机器上已有 leyline
./pack-lite.sh [输出]     另一台机器上的 Docker 版：只有 ST 和初始化，聊天走 LLM_HOST 上的网关，没有生图
./pack-mobile.sh [输出]   手机 Termux：ST 和网关都在手机上，使用本地 gateway.mobile.env 打包上游配置
```

- 远端：把 `docker-compose.yml`、`init.sh`、`merge-settings.mjs`、`gateway.mjs`、seed 传到远端的 `~/others/tavern-stack`，状态在那里的 `./data`，然后 `docker compose up -d --force-recreate`。上游主机的地址是脚本里的环境变量 `LAN_HOST`（有默认值，可用环境变量覆盖）。每次部署都会把 seed 里的三个地址换成这个 IP，并把远端的 `gateway.env` 覆盖成 `UPSTREAM_URL=http://<这个 IP>:3425/v1` 加空的 `UPSTREAM_KEY`，本地的网关配置不会上传。网关的 8789 端口对外开放且没有鉴权，云上的安全组要放行。`docker-compose.yml` 打开了酒馆的 CORS 代理（`SILLYTAVERN_ENABLECORSPROXY=true`），浏览器可以请求 `<酒馆地址>/proxy/<目标地址>`，由酒馆服务端去取；能访问 8000 端口的人也就能让服务端取它能到的任何地址，所以 8000 端口只对自己放行，或者打开基本认证（compose 里注释掉的那三行）。
- 精简版是同一份 `docker-compose.yml` 去掉 `gateway` 服务，`.env` 写 `ST_ROOT=./data` 和 `ST_RESTART=unless-stopped`。seed 和这里只差三处：去掉 `sd`，`story.pictures` 设为 `false`，`custom_url` 改成 `http://<LLM_HOST>:8789/v1`。`LLM_HOST` 要在本地 `.env` 里明确写，主机名或 IP 都行。 换网关地址要改包里 `seed/settings.json` 的 `custom_url`。解压后 `docker compose up -d --force-recreate`。
- 手机版需要本地的 `gateway.mobile.env`（写 `UPSTREAM_URL` 和 `UPSTREAM_KEY`），git 忽略这个文件。上游地址要手机能访问，Android 上没有 Docker 的 `host.docker.internal`。打包时原样复制成 `st-mobile/gateway.env`，缺这个文件会报错。包里有私有地址，可能还有 key，不要公开。 `sd` 的三个地址改成 `192.168.31.171`，PC 开着时生图可用，`story.pictures` 保持 `true`。解压后 `bash start.sh`（第一次会装 node、clone ST、装扩展），访问 `http://<手机IP>:8000`。更新时用 `tar -xzf … --exclude='st-mobile/SillyTavern'`，不要覆盖已装的 ST。

### 远端访问上游

远端主机本身要能访问到那个 IP 的 3425 和 1234 端口（怎么通不在本仓库里），容器经宿主机出去。模型和其他请求参数在 ST 里设。生图的 `sdcpp` 用同一个 IP 的 1234 端口。

## 清洗聊天

换预设之后，旧预设留在聊天里的思考块、状态栏、选项块会被新预设当成普通文字，还会被模型模仿。`chat-cleanup/clean_chat.py` 写出一份清洗过的副本，保留剧情文字和卡自己的变量数据；`chat-cleanup/PROMPT.md` 是给 Claude Code 会话用的完整说明，粘进去再告诉它聊天文件名就行。

```
./chat.sh <目录> [主机]                                                   从服务器把每份聊天原样备份到目录（默认命令，主机默认 mc）
python3 -I chat-cleanup/clean_chat.py inventory 聊天.jsonl                先看有哪些标记
python3 -I chat-cleanup/clean_chat.py clean 聊天.jsonl 输出.jsonl [--add-blocks a,b] [--drop-empty-tail]
python3 -I chat-cleanup/clean_chat.py verify 聊天.jsonl 输出.jsonl        不是 OK 就不要上传
./chat.sh upload 输出.jsonl [主机] [角色]                                 把清洗好的聊天作为新聊天传回服务器
python3 -I chat-cleanup/clean_chat.py --self-test
```

`chat.sh upload` 的角色就是服务器上 `chats/` 下的目录名：第三个参数；没给就依次找：文件所在的目录名（备份出来的目录结构里就是）、文件第一行的 `character_name`（ST 自己写的是 `unused`，不算）、服务器上哪个角色目录里有同一个 `chat_metadata.integrity` 的聊天（清洗不会改它）；原件已经不在服务器上（比如重置过 ST）时，服务器 `chats/` 下只有一个角色目录就用它，并在输出里说明。恰好剩下一个才用，有多个或一个都没有就拒绝，不猜。文件名就是聊天的名字，ST 的聊天列表里能直接选；服务器上已有同名文件时拒绝，不覆盖；传完比较字节数。备份目录和上传的文件都必须在仓库外，在仓库里会被拒绝。

`clean` 默认会做：

- 删旧预设留下的标签块、页眉、水平线（`---`、`***`、`___`）、楼层计数；`--add-blocks a,b` 追加新预设的标签。
- 一条回复被模型写了两遍时，只留第一份（规则 `collapse_repeat`）。
- 删其他扩展写在聊天元数据里的状态（`LWB_*`、`storyOracle_*`、`extensions`），其中 `LWB_SNAP` 一项就能占文件的一半；用 `--no-drop-extension-state` 保留。
- 卡自己的变量（每条消息的 `variables`、`chat_metadata.variables`、`<UpdateVariable>` 块）原样保留。

末尾失败生成留下的空消息要显式加 `--drop-empty-tail` 才去掉。

聊天文件和输出放在仓库外，不要提交。默认的标签列表是为一张卡和三个预设写的，换卡或换预设之前先看 `inventory`，细节见 `PROMPT.md`。

## 图像后端

地址都在 `seed/settings.json`，ST 的"图像生成"来源下拉框里切换，`source` 是默认来源（`sdcpp`）。

| 来源 | 地址 | 说明 |
|---|---|---|
| `sdcpp` | `host.docker.internal:1234`（远端部署时换成上游主机的 IP） | stable-diffusion.cpp，imagegen-stack 的 `run_sdcpp.sh`，要监听 `0.0.0.0`，约 26 秒一张 |
| `comfy` | `host.docker.internal:8188` | ComfyUI，CPU 约 43 秒一张；步数和 CFG 在工作流里 |
| `auto` | `host.docker.internal:7860` | 手机上的 Local Dream（SD1.5） |

步数、CFG、采样器、调度器是共用的。seed 按 Anima-Turbo 写了 `steps: 8`、`scale: 1`、`euler`、`simple`；切到 SD1.5 要在界面里改成约 20 步、CFG 9、DPM++ 2M，重启会按 seed 还原。sdcpp 来源不发 LoRA，要在服务器那边设（`SD_LORA_TAGS`）。

## 页面脚本

`seed/scripts/page.js`（酒馆助手里叫"懒人快捷键"）：

- 没有输入框有焦点时：`u` `,` 向上、`d` `.` 向下翻聊天 0.4 屏；`/` 聚焦输入框；输入框里 `Shift+.` 或 `Esc` 失焦（`Shift+.` 在聊天输入框里会吃掉键入的 `>`）；`Alt+/` 随时运行"代写"。
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

## 默认安装的扩展

酒馆助手的仓库名是 JS-Slash-Runner，所以扩展列表里搜"酒馆助手"找不到。提示词模板是 ST-Prompt-Template。故事神谕是 [story-oracle](https://github.com/namelessone88/story-oracle)，一个侧边的剧情助手窗口，要在它的设置里填自己的 OpenAI 兼容端点（seed 里设为上游地址并开启"经酒馆后端转发"，由 ST 的服务端去请求，部署时换成上游主机的 IP；不转发时是浏览器直接请求，解析不了 `host.docker.internal` 和 `gateway` 这类 Docker 里的名字。上游要 key 的话，在它的设置里填 `apiKey`，密钥不能放进 seed）。三个都由 `st-init` 装到 `$SCRATCH/st/extensions`，已存在就跳过；酒馆助手要 ST 1.13.0 及以上。故事神谕的仓库没有许可证，也没有固定版本，新装时拿到的是当时的最新提交。

自动安装失败（`docker compose logs st-init`）时，在 ST 的扩展页 Install extension，填 https://github.com/N0VI028/JS-Slash-Runner（国内用 https://gitlab.com/novi028/JS-Slash-Runner），装完刷新。要重装先删 `$SCRATCH/st/extensions/JS-Slash-Runner` 再 `./st.sh`。

## 许可

MIT，见 `LICENSE`。仓库里不含第三方的预设和角色卡，不要放进来再公开推送。`init.sh` 装的各扩展有自己的许可。
