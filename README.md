# tavern-stack

SillyTavern 周围的一整套：docker compose、LLM 网关、用文件管设置的 seed、酒馆助手脚本、手机生图桥，以及给另一台机器用的精简版打包。

SillyTavern（ST）接一个 LLM 聊天接口，图像生成在这台机器的 GPU（sd.cpp）、ComfyUI 或手机（Local Dream）上，见下面的"图像后端"。ST 里的聊天地址永远是 `http://gateway:8789/v1`（"自定义"来源，seed 只写死地址，模型栏和 key 栏留空），换上游只改网关的 `.gateway.env`，ST 的设置不动。全部由 `docker-compose.yml` 启动。

**上游不在这个仓库里**：网关后面的 LLM 服务由 `.gateway.env` 的 `UPSTREAM_URL` 指向，可以是 OpenRouter 这样的公网服务，也可以是同一个 Docker 网络（`localmesh`，compose 里声明为外部网络，要先 `docker network create localmesh`）上另一个容器，按容器名访问；也可以是宿主机上直接跑的程序，用 `http://host.docker.internal:端口/v1`（compose 给网关加了 `host.docker.internal:host-gateway`）。宿主机上的程序要监听容器够得着的地址：`0.0.0.0`（局域网也能连），或 docker0 的地址（通常是 `172.17.0.1`，只有本机和容器能连）；端口不能用 8789，那是网关发布的。图像后端不在这个仓库里，见下面的"图像后端"。

```
st.sh                 启动：容器重启（先重跑 st-init，seed 的改动才会生效）
st.sh re              启动并重建容器（改了 docker-compose.yml 之后用）
st.sh logs            把所有服务和 leyline 的日志，每行带时间，写进 $SCRATCH/st/all.log（每次覆盖），先带每个服务最近 500 行再持续跟随；容器重建后要重开

  gateway      本仓库的 gateway.mjs：任意 OpenAI 兼容上游前面的一层，上游地址、key、模型、请求改写都在 .gateway.env
  leyline      CLIProxyAPI（cpa）：把登录的订阅当 OpenAI 兼容接口，是网关现在的上游（http://leyline:8317/v1）。它不在这个 compose 里，单独启动、接在同一个 Docker 网络上；st.sh 不启动也不重启它，只有 `st.sh logs` 会跟随它的日志（容器名要叫 leyline）
  st-init      一次性任务：装酒馆助手、提示词模板、Edge TTS 插件，再应用 ./seed
  sillytavern  应用本体，:8000（局域网可访问，见 ST_LAN_CIDR）
```

**`.env`**（同目录，不提交）可放这个网络的地址：`LLM_HOST`（这台机器在局域网里的地址，打精简版包时写进包里）。docker compose 自动读取它；仓库里的文件不写死任何地址。

**图像后端**：三个后端的地址都写在 `seed/settings.json` 里，ST 的"图像生成"来源下拉框里直接切换，不用换文件；`source` 决定默认选哪个，现在是 `sdcpp`。

| 来源 | seed 里的键 | 说明 |
|---|---|---|
| `sdcpp` | `sdcpp_url` = `http://host.docker.internal:1234` | 宿主机上的 stable-diffusion.cpp 服务器，由 imagegen-stack 仓库的 `run_sdcpp.sh` 启动（要监听 `0.0.0.0`，容器才连得到），约 26 秒一张；它自带的网页界面要用同仓库的 `build_webui.sh` 构建后，`run_sdcpp.sh` 才会提供（`http://<host>:1234/`） |
| `comfy` | `comfy_url` = `http://host.docker.internal:8188/`、`comfy_workflow`、`comfy_type` | 宿主机的 ComfyUI（imagegen-stack 的 `run_comfyui.sh`），CPU 约 43 秒一张；步数和 CFG 写在工作流里 |
| `auto` | `auto_url` = `http://host.docker.internal:7860` | 手机（Local Dream，SD1.5），由 imagegen-stack 的 `run_localdream.sh` 启动（要设 `LOCALDREAM_HOST` 为手机的地址） |

**步数、CFG、采样器、调度器是共用的**，不分来源。seed 按 Anima-Turbo 写了 `steps: 8`、`scale: 1`、`euler`、`simple`（ST 默认的 20 步、CFG 7 会慢约 5 倍）。切到手机（SD1.5）要在界面里改成约 20 步、CFG 9、DPM++ 2M，改回来用 sdcpp 前不要忘记；`./st.sh` 重启会按 seed 还原。seed 每次启动都覆盖，在界面里手改的生图设置不保留。sdcpp 来源发给服务器的字段里没有 LoRA，所以 LoRA 在服务器那边设（`run_sdcpp.sh` 启动时默认带 waiAnima，用 `SD_LORA_TAGS` 改），ST 里不能选。`story.js` 里给模型的标签规则是按 sdcpp（Anima）调的；SD1.5 才需要的几条放在 `SD15_RULES`，ST 的生图来源是 `auto`（手机）时自动加上。

## LLM 网关（gateway.mjs）

`cp .gateway.env.example .gateway.env`，填上游地址（和 key，没有就留空），然后 `./st.sh re`。换模型就改 `MODEL` 再 `./st.sh re`。它只做下面几件事，不看也不改提示词内容：

| 变量 | 作用 |
|---|---|
| `UPSTREAM_URL` | 上游的基础地址（必填） |
| `UPSTREAM_KEY` | 上游的 key；留空就不发 `Authorization`（cpa 不需要）。key 在网关里，不在 ST 里 |
| `MODEL` | 替换 ST 要的模型名，ST 的模型栏可以留空 |
| `BODY` | JSON，合并进每个请求；用来关掉推理（对聊天不需要，慢而且贵），写法因上游而异 |
| `RETRIES` | 额外重试次数（默认 2） |
| `ORIGINS` | 允许从浏览器直接请求网关的页面来源，默认 `http://127.0.0.1:8000` 和 `http://localhost:8000`；用手机或局域网地址打开 ST 时要加上 |

- **`BODY` 因上游而异**：OpenRouter 要 `{"reasoning":{"enabled":false}}`（ST 自己的 OpenRouter 来源只会发 `effort`，关不掉）；cpa 忽略那种写法，要 `{"reasoning_effort":"low"}`。换上游时先发两三个一句话的小请求（带不同的 `BODY`），看返回的 `usage` 里推理 token 有没有变，再决定写法。
- **重试**：429/502/503/504 和网络错误，指数退避。Gemini（经 cpa）偶尔回 200 但 `choices` 是空的、输出 0 token（日志里是 `out=0`，`/pic` 会报"模型返回了空内容"），同样重试；用完仍是空的就原样交给 ST。上游的内容过滤（`choices` 有一项但没有内容，`finish_reason` 是 `prohibited_content` 之类，日志里是 `blocked: finish_reason=…`）每次结果不同，也同样重试；用完仍被拦，就把 `上游没有返回内容 (finish_reason: …)` 作为错误交给 ST，而不是一条空回复。流式请求不检查。
- **末尾是 assistant 的请求**（预填、ST 的"继续"、卡里的脚本）：上游返回 400 且信息含 `ending with a model turn`（Gemini）时，网关补一条 `user: Continue.` 重发，并记住这个上游，之后直接带上；接受预填的上游不受影响。模型是重新回答，不是从预填处精确接着写，所以没有做"中断续写"的按钮。
- **CORS**：卡里的脚本会从浏览器直接请求网关，所以对 `ORIGINS` 里的来源放行，不用 `*`（否则打开的任何网页都能通过这个本地端口花掉上游额度）。
- **一行日志**：`模型 状态 耗时 in= out= reasoning=`；流式只有状态和耗时。流式被上游中途断开时，再多一行 `模型 stream cut: 原因`（ST 那边只会看到回复变短，没有别的提示）；客户端自己关闭（点停止）不算。网关没有超时：上游连接不断、也不再发数据时会一直等。
- **别的机器上的 ST 用这个网关**：compose 把网关的端口发布在 `0.0.0.0:8789`（本机和局域网都能连）；那台机器上 ST 的 `gateway` 要解析到这台机器的地址（精简版包的 `extra_hosts` 做了这件事）。网关前面没有鉴权，局域网里的任何设备都能用你的上游额度。验证：在那台机器上 `curl http://<这台机器的地址>:8789/health` 返回 200；连不上时会得到 `ECONNREFUSED`，网关这边什么日志也没有。

## 状态存放

- ST 写的所有东西都在内存盘 `$SCRATCH/st` 下，**聊天记录也是**：内存盘清空（重启）就没了，想留的聊天在 ST 的"Manage chat files"里点下载。`st.sh` 不备份。
- **每次启动后刷新 ST 页面**，并关掉其他标签页：打开着的页面把旧设置缓存在内存里，一操作就会写回去，覆盖 `st-init` 刚合并好的 seed。
- 只重启 ST、不动别的服务（家里人在用网关时）：
  ```
  docker stop sillytavern && docker start -a st-init && docker start sillytavern
  ```
  先停 ST 再合并，ST 退出时才不会把内存里的旧设置写回去。

## 精简版打包（另一台机器上的 ST）

```
./pack-lite.sh [输出文件]      默认 $SCRATCH/st-lite.tar.gz
```

精简版只跑 ST 和 `st-init`：聊天连这台机器上的网关，没有生图。包是从这个目录里现成的文件打出来的，不留第二份：`init.sh`、`merge-settings.mjs`、`seed/`，加上 `docker-compose.lite.yml`（包里叫 `docker-compose.yml`）和 `lite-README.txt`（包里叫 `README.txt`，写给那边用的步骤）。包里的 `seed/settings.json` 和这里的只差两处：去掉 `sd`，并把 `extension_settings.story.pictures` 设成 `false`。这个开关让 `story.js` 的"更多"菜单只剩"总结"（这里是 `true`，菜单里还有画图几项）。包里还有一个 `.env`，只含这里 `.env` 的 `LLM_HOST`（这台机器的地址；没设时 `pack-lite.sh` 会报错、不打包）。改了 seed 或这些文件，重新打包再发过去；那边 `docker compose up -d --force-recreate` 应用。数据在包目录里的 `./data`。

## Seed：用文件管设置

`seed/` 在每次启动时由 `merge-settings.mjs` 应用，**优先级高于界面里的修改**：要改就改这里，别在 ST 界面里改。

| 文件 | 怎么应用 |
|---|---|
| `seed/settings.json` | 深度合并进用户的 `settings.json`（对象合并，数组和标量替换） |
| `seed/scripts/*.js` | 酒馆助手的全局脚本，同名（`// @name`）的会被替换，你自己建的脚本保留；脚本改名后旧名字的条目不会被清，要自己在酒馆助手里删 |
| `seed/QuickReplies/*.json` | 复制进用户的快捷回复集；文件名就是集合名，`settings.json` 里 `quickReplyV2` 按这个名字引用 |

**快捷回复**（`quick-replies`）：`代写`（id 2，`/imp {{input}}`）、`更多`（id 3，`/more`）、`全屏`（id 4，消息是空的，由 `page.js` 处理）。脚本按 **id** 引用它们（ST 的 `quickReplyApi` 接受数字 id 代替标签）：页面上的按钮元素没有 id，只有标签，所以要认出某个按钮时，先用 id 向 API 查出它当前的标签再比对。改 id 要同步改 `page.js` 和 `story.js` 里的常量。

**朗读（TTS）**读的正文和 `/pic`、`/imp` 用的是同一套"按内容找正文"（`story.js` 的 `storyText`），不认标签名。ST 自己的过滤只有一条正则，只能删、不能挑，所以分两层：`settings.json` 里 `extension_settings.tts.regex_pattern` 只做保守的兜底（去注释、名字带 `think`/`thought`/`reason`/`analy` 的块、像 JSON 的块、`#` 标题行），不去掉别的标签；真正挑正文的是 `story.js` 启动时装到 Edge 提供方 `processText` 上的钩子（它在正则之后、带着标签的文字上运行）。朗读比给模型的更窄一步：选中的块里如果有一个子块占了大半（比如 `<content>` 里的 `<now_plot>`），只读那个子块，不念 `<time>`、`<location>`。钩子只装给 Edge；换别的朗读提供方，或 ST 改了这个接口，钩子不生效，只剩正则（会多读一些面板文字），控制台里有一条 `[story] TTS` 警告。钩子是通过页面自己的模块实例打补丁的（脚本 iframe 有自己的模块表，在那里打补丁 TTS 扩展看不到）。

**页面辅助**（`seed/scripts/page.js`，酒馆助手里叫"懒人快捷键"）：

- 没有输入框有焦点时，单按 `u` `d` `,` `.` 翻聊天 0.4 屏（`u` `,` 向上，`d` `.` 向下）。`/` 让输入框获得焦点、光标放到末尾（`/` 本身不输入）；`Esc`（ST 自带）和 `Shift+/` 让输入框失焦：左手 `Esc`，右手 `Shift+/`。输入框有焦点时这些键照常打字；`Shift+/` 只对聊天输入框生效，并且只在按键是 `?` 时（中文输入法打 `？` 不受影响），所以在主输入框里没法打英文 `?`，别的输入框不受影响。按住不放只算一次。`Alt+/` 运行"代写"快捷回复（走 `quickReplyApi`，不需要按钮在页面上；找不到会在控制台报错），不看焦点在哪（ST 每次发送后会把焦点放回输入框）。
- 快捷回复"全屏"：手机浏览器里进入 / 退出全屏。`requestFullscreen` 必须在点击本身里调用，所以脚本在页面上以捕获阶段监听点击，认出点的是"全屏"按钮（id 4 的标签）就当场处理；iPhone 的 Safari 不支持网页元素全屏，只会提示，要全屏用"添加到主屏幕"。
- 生成中的提示：停止按钮出现的那段时间（ST 在写回复时显示它），在它上方显示一个小药丸：闪动的圆点，加已用时间和已经收到的字数（`23s · 2294 字`，来自 `STREAM_TOKEN_RECEIVED`，包括卡里不显示的预处理块）。字数超过 5 秒（`STALL_AFTER`）没有增长，就换成"无新内容 6s"的计时，文字又来了就换回去。第一块文字到之前、以及没开流式时，只有时间。它只是提示，没有超时，也不会重试。药丸和"更多"菜单的定位只用 `left`/`top`，原因见 `page.js` 里的注释（ST 给 `<html>` 加了 `transform`，`fixed` 元素的包含块变了，手机上用 `right`/`bottom` 会跑到屏幕外）。
- 暂停屏外动画：有的卡在**每条消息**的 iframe 里画动态背景（飘浮的爱心、气泡、流星），同源的 srcdoc iframe 滚出视野后动画照跑（实测一个聊天里约 100 个动画，渲染进程占满一个核）。脚本用 `IntersectionObserver` 看每个消息 iframe（`TH-message` 开头）在不在视口（上下各留 300px），不在就用 `getAnimations()` 把里面**无限循环**的动画暂停，滚回来就恢复（只恢复脚本自己暂停的）；之后才启动的动画靠 `animationstart` 事件补上。**只播一次的动画不动**：有的卡靠它让内容淡入（`opacity: 0` 加 `animation … forwards`），冻在起点就会一直是透明的。
- 消息正文是 iframe，里面的按键事件到不了页面，所以每个 iframe 的文档上也挂同一个按键监听；iframe 每次渲染都会重建，所以用 `MutationObserver` 盯着。

## 图像生成和剧情命令

`seed/scripts/story.js`（酒馆助手运行）提供四个斜杠命令。它们都用 `generateRaw` 发一个**干净的请求**（不带角色扮演预设）：ST 自带的 `/sd me|you|…`、`/impersonate` 会带着整段聊天和预设去问模型，模型要么拒绝，要么按剧情格式回答，要么复述旧的玩家发言。

| 命令 | 入口 | 作用 |
|---|---|---|
| `/pic me｜you｜face｜bg｜last｜pov｜<名字、描述或场景>` | "更多"菜单 | 让模型写 SD 标签，作为完整的 `/sd …` 命令放进输入框，不自动出图，改完标签回车才出图；不带参数时提示用法。**露骨标签**：最新一条剧情（前面几条不算）含 `EXPLICIT_TERMS` 里的词，或参数里写了 `nsfw`（`/pic pov nsfw`、`/pic nsfw`），就在标签前加一串 `NSFW_BASE`，提示里会写明是哪个词或参数触发的。含这些词的句子，以及 `SCRUB_TERMS` 里的词（只删、不触发露骨标签）所在的句子，不会发给模型（词表都在 `story.js`） |
| `/imp [草稿]` | 快捷回复"代写"、`Alt+/` | 写玩家接下来的台词或动作，放进输入框，不自动发送 |
| `/sum` | "更多"菜单 | 把整个聊天总结成长期记忆，显示在弹窗里 |
| `/more` | 快捷回复"更多" | 在按钮上方弹出小菜单：画此刻、画第一人称(POV)、画我、画NPC、画特写、画景、画输入框里的…、总结 |

**不绑死卡和预设**：脚本里凡是和某张卡、某个预设有关的写法都不能写死。人称、语言、时态、台词格式一律让模型照玩家自己的发言（没有就照剧情）；`/sum` 用聊天本身的语言（指令是英文写的，写明"用聊天本身的语言，不是这段指令的语言"，否则英文聊天会被答成中文）。故事在哪个标签里：不认标签名（卡一换名字就变：`content`、`game`、`自由开局`……）。一条回复按"顶层标签块 + 标签外的文字"切成几段，名字里带 `think`/`thought`/`reason`/`analy` 的（各张卡都这么叫）和像 JSON 的不算，剩下取字最多的那一段当故事。引用在自检里的 `<content>` 模板因此不会被当成故事。

### `/pic`

```
/pic …
  1. gather：玩家第一条消息（当作他的角色档案）、最近 12 条 AI 回复、persona
  2. generateRaw：把材料和 STYLE 规则（story.js）发给聊天模型，要 SD 标签；回复第一行是画布（portrait/landscape），第二行是标签
  3. 校验：回复必须是标签列表（总长不超过 1500、每个标签不超过 80 字符），不是就重问一次，还不是就报错；模型先拒答、后面又给了一行标签时，用那一行
  4. 画布：我/你/脸/第一人称固定竖版，背景固定横版，last 和自由文本用模型给的那行；标签原样使用，只去掉 | 和 {{（斜杠解析会当命令）
  5. 把 /sd extend=false width= height= <标签> 放进输入框，改完回车，由 ST 自己的 /sd 出图
```

- **脚本**知道意图（我、你、背景、情侣），负责向模型提问；怎么写标签全是 `STYLE` 那段给模型看的文字，**代码不改写标签**。换了生图模型，只改这段文字；SD1.5 才需要的规则单独放在 `SD15_RULES`（`auto` 来源时才用），其余按 Anima 调过（见下面“调参结论”）。代码只硬编码了一件事：单人和背景的画布。
- 生图本身是 ST 的 `/sd`，后端能力（来源、放大、种子、采样器、模型切换等）更新 ST 就能拿到。拿不到的是 ST 在提示词生成层的新功能（魔杖菜单里的生图项、互动模式、函数工具模式、多模态识图、生成前的编辑弹窗）；魔杖菜单里的生图项仍用 ST 自带模板，会被拒绝，请用 `/pic`。依赖面很小：`generateRaw`、`SlashCommandParser.addCommandObject`（四个命令都这样注册，带参数说明；ST 把旧的 `registerSlashCommand` 标成了弃用）。`st-init` 装酒馆助手和提示词模板用的是最新版，ST 镜像是 `latest`，需要稳定时固定版本。

### `/imp`

- 请求只带：persona、玩家的第一条消息、最近 3 条 AI 回复、玩家第一条之后自己最近 3 条发言（标明"已经写进剧情，不要重复"）、草稿，加一条指令。第一条玩家消息在有的聊天里是角色档案，有的是第一次行动，所以只标成"第一条消息"。
- 没有草稿写主角的台词或动作；有草稿就按草稿扩写，草稿写谁（包括 NPC）就写谁，也可以是纯叙述。限制（1～3 句、80 字）在系统指令和请求末尾各写一遍，小模型只看系统指令会写成好几段。
- **重抽**：输入框里还是上次的结果、没改过时再按"代写"，照原草稿重写；改过哪怕一个字就当新草稿。结果会替换输入框里原来的内容，原草稿只存在脚本内存里。
- 结果直接赋给输入框，再触发一次 `input` 事件让 ST 知道（字数统计、草稿保存都听它），**不经过斜杠解析器**，所以文字就是模型写的样子：换行、空格、`|`、`{{` 都保留；只去掉不属于正文的东西（思考块、代码围栏、首尾空白）。`/pic` 放进输入框的是 `/sd` 命令，回车后要经过斜杠解析器，所以那里的标签仍然要去掉 `|` 和 `{{`。
- 已知限制：玩家一条发言都没有、剧情又用"你"称呼玩家时，写出的人称和剧情对不上（没有依据可照）。

### `/sum` 和 `/more`

- `/sum`：把整个聊天（玩家发言和剧情按顺序，最多最近 20 万字）总结成 500～800 字的长期记忆。弹窗上面是放哪儿的说明，中间是只读文本框，底部"复制"和"关闭"并排；"复制"是弹窗的自定义按钮，选中文本框再 `execCommand("copy")`（剪贴板接口只有安全来源才有，手机用 `http://192.168…` 时没有），成功弹"已复制"。
- 用法：复制进聊天的"作者注释"（输入框左边的三横菜单），保持"聊天的特定深度 4，作为系统"和"插入频率 1"，再用 `/hide 2-N` 隐藏旧楼层（别隐藏开头的开局器和角色档案）。预设自带的"大总结模式"不用：卡要求只输出它规定的结构，两边会冲突。
- 什么时候需要：上下文还装得下整个聊天时不需要。MVU 变量存的是状态（位置、数值、人物关系），`大事记` 一栏虽然有，但常常是空的，长剧情的记忆要靠这个。
- `/more`：脚本在页面上画一个浮在"更多"按钮上方的 `div`（用主题自己的颜色变量），点哪一项跑哪一项，点别处或按 Esc 关闭。弹窗和菜单的参数写法对照了酒馆助手自带的类型定义（`@types/iframe/exported.sillytavern.d.ts`）。

### 图片反推标签（`tools/wd-tag.sh`）

```
tools/wd-tag.sh [-v] [-n] 图片.png     标签（逗号分隔）打到标准输出，同时复制到剪贴板；-n 不复制；-v 再给分级和每个标签的置信度（这些不复制）
```

调 [wd-tagger Space](https://huggingface.co/spaces/SmilingWolf/wd-tagger) 的 Gradio 接口（上传、调用、读事件流），默认模型是最准的 `wd-eva02-large-tagger-v3`。剪贴板按顺序试 `wl-copy`、`xclip`、`xsel`、`pbcopy`、`clip.exe`，用第一个能用的；都没有或都失败只在标准错误里说一声，标签照常打出来，不算错误；`WD_COPY=0` 等于 `-n`。环境变量：`WD_MODEL`（换模型，名字写错时接口会列出可选项）、`WD_GENERAL`（默认 0.35）、`WD_CHARACTER`（默认 0.85）、`WD_URL`（指向同一个应用的别的服务器，比如自己本地起的）、`HF_TOKEN`（可选，多一点配额）。上游忙时重试 3 次；Space 自己返回错误（比如模型名不对）不重试，退出码 3，连不上退出码 1。注意：**图片会上传到 Space**。实测每张 11 到 20 秒（和模型大小无关，主要是 Space 和网络），适合偶尔核对；要批量或放进流程里反复调，在本地跑同系列的 ONNX 模型（`wd-swinv2-tagger-v3`，CPU 上约 0.35 秒一张）。

### 提示词规则的调参结论

`STYLE`（给 sdcpp/Anima）和 `SD15_RULES`（`auto` 来源才加）里的每条规则都是实测出来的，样本都不大，看趋势。

**Anima（sdcpp，anima-turbo-v1.1）**

- 约 250 字符的上限要留：去掉后提示词长度翻倍并开始写句子，放宽到 400 也会漂。
- 发色眼色要写明：去掉后多人场景写出的发色种类变少。
- 衣着规则（颜色、剪裁、剧情里写的状态）：没有它时“洗得泛白的宽大袖口”只写成 `grey robe`；有它后磨旧、褪色一类的细节写得出来，崭新衣服的剧情没有被写成旧的。
- 场景规则（写出年代和文化）：没有它时 `city market` 被画成现代街道；有它后标签里带年代词，现代剧情没被写成古代。
- 三人及以上要单独写：`last` 的任务句不能是“两个角色作为一对”，否则 LLM 只写一对；人数标签给的是按性别和年龄分的通用写法（`3women`、`2men, 1woman`），不要只举 `2girls, 1boy`。人多时 Anima 偶尔少画一个人，标签是对的。
- 人物标签按剧情里写的年龄选：成年 `1man`/`1woman`，孩子或少年 `1boy`/`1girl`。`boy` 和 `man` 的画面差别很小，画成小孩主要是描写词（`petite`、`large eyes`、`oversized … short robe`、`small stature`）。规则只让标签跟着剧情里写的年龄，不会把剧情里写成孩子的角色改成成年人。
- 两个人的平铺和分组写法都能绑对颜色；分组保留是因为 LLM 写多人时更有条理。
- SD1.5 的四个老毛病在 Anima 上都不出现：单人横画布画成孪生、宠物被画成巨大的身体、`hawk-like eyes`/`cow print` 被当成动物、`close-up` 接吻丢场景。对应规则只放在 `SD15_RULES`。

**SD1.5（Anything V5，手机）**

- CFG 9、20 步；30 步没有可见变化。ST 渲染过背景后会把画布宽度留在 896，所以每次请求都显式传 `width=`、`height=`。
- 单人在宽画布或没有 `solo` 时常画成孪生，所以人物用竖版并加 `solo`。
- 两个人：互动标签放最前，每个人的标签成组，每人只给发色、眼色和一件衣服；亲吻用 `upper body`，不要 `close-up` 或 `from side`。
- 带动物名的词会被当成动物画（`cow print`、`hawk-like eyes`）；角色的宠物会被画坏，一律不写。这两条要同时写进 `you`/`face` 的任务句才管用。

**和生图后端无关**

- 关掉推理的小模型有时不写标签而是写分析，所以回复要校验。
- 有的上游会把部分请求误判成生图（有每日额度，用完返回 HTTP 500），"Draw …"开头的措辞会触发，所以任务用"Write the prompt for …"，并且一次只发一个请求。
- 手机是共用的：有人在生成时调 `/stop` 或改尺寸会打断别人的任务，这里没有任何地方调用 `/stop`。

## 测试

```
node merge-settings.mjs --self-test
node gateway.mjs --self-test                               对着一个假上游：覆盖、重试、流式、错误、CORS、补 user 轮
node test/story.test.mjs                                   story.js（/pic /imp /sum /more），用 ST 和酒馆助手的替身
node test/page.test.mjs                                    page.js（按键、翻页、全屏、暂停屏外动画），用假的页面
```

"更多"菜单怎么画在页面上没有测试，要在真实页面里看。某个命令没反应时按 F12 看浏览器控制台里的报错。

## 酒馆助手和提示词模板

酒馆助手就是 JS-Slash-Runner（仓库名），所以在扩展列表里搜"酒馆助手"找不到。提示词模板是 ST-Prompt-Template（https://github.com/zonde306/ST-Prompt-Template）。两个都由 `st-init` 自动装到 `$SCRATCH/st/extensions`，已存在就跳过；酒馆助手要求酒馆 1.13.0 及以上。

自动安装失败时（`docker compose logs st-init` 会显示），可以在 ST 里手动装：点顶部的积木图标（Extensions）→ Install extension，填下面任意一个地址，装完刷新页面：

- GitHub：https://github.com/N0VI028/JS-Slash-Runner
- GitLab 镜像：https://gitlab.com/novi028/JS-Slash-Runner（国内更推荐）

安装失败要重装时，先删 `$SCRATCH/st/extensions/JS-Slash-Runner`，再 `./st.sh`。手动下载 ZIP 安装的话无法一键更新，优先用链接安装。

## 许可

MIT，见 `LICENSE`。仓库里不含第三方的预设和角色卡（它们有各自作者的条款，不要放进来再公开推送）；`init.sh` 安装的酒馆助手、提示词模板、Edge TTS 插件各有自己的许可。

## 参考站点

- 酒馆助手 Tavern Helper（SillyTavern 中文教程站）：https://guide.sillytavern.one/extensions/tavern-helper/
- 安装与更新（官方文档）：https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/%E5%85%B3%E4%BA%8E%E9%85%92%E9%A6%86%E5%8A%A9%E6%89%8B/%E5%AE%89%E8%A3%85%E4%B8%8E%E6%9B%B4%E6%96%B0.html
- 酒馆常用插件合辑（Silly Wiki）：https://colerith.github.io/sillytavern-helper/tools/%E9%85%92%E9%A6%86%E5%B8%B8%E7%94%A8%E6%8F%92%E4%BB%B6/
- https://mini-tavern.com/blog/zh-cn/silly-tavern-app/cloud_silly_tavern_brain_alike
- https://down-3ud.pages.dev/
- https://awaa-col.github.io/
