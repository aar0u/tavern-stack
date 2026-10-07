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
| `sdcpp` | `sdcpp_url` = `http://host.docker.internal:1234` | 宿主机上的 stable-diffusion.cpp 服务器，由 imagegen-stack 仓库的 `run_sdcpp.sh` 启动（要监听 `0.0.0.0`，容器才连得到），约 26 秒一张 |
| `comfy` | `comfy_url` = `http://host.docker.internal:8188/`、`comfy_workflow`、`comfy_type` | 宿主机的 ComfyUI（imagegen-stack 的 `run_comfyui.sh`），CPU 约 43 秒一张；步数和 CFG 写在工作流里 |
| `auto` | `auto_url` = `http://host.docker.internal:7860` | 手机（Local Dream，SD1.5），由 imagegen-stack 的 `run_localdream.sh` 启动（要设 `LOCALDREAM_HOST` 为手机的地址） |

**步数、CFG、采样器、调度器是共用的**，不分来源。seed 按 Anima-Turbo 写了 `steps: 8`、`scale: 1`、`euler`、`simple`（ST 默认的 20 步、CFG 7 会慢约 5 倍）。切到手机（SD1.5）要在界面里改成约 20 步、CFG 9、DPM++ 2M，改回来用 sdcpp 前不要忘记；`./st.sh` 重启会按 seed 还原。seed 每次启动都覆盖，在界面里手改的生图设置不保留。sdcpp 来源发给服务器的字段里没有 LoRA，所以 LoRA 无法在 ST 里选。`story.js` 里针对 SD1.5 的标签规则（标了 `[SD1.5]`）对 Anima 未必需要，没有改。

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
- **重试**：429/502/503/504 和网络错误，指数退避。Gemini（经 cpa）偶尔回 200 但 `choices` 是空的、输出 0 token（日志里是 `out=0`，`/pic` 会报"模型返回了空内容"），同样重试；用完仍是空的就原样交给 ST。流式请求不检查。
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

**朗读（TTS）过滤**在 `settings.json` 的 `extension_settings.tts.regex_pattern`：去掉注释、`<content>` 和 `<now_plot>` 以外的整段标签（预处理块、`<time>`、`<location>`、变量更新等）、自闭合标签、`#` 开头的标题行，只留这两个标签里的正文。不同的卡把正文放在不同的标签里；换了卡朗读没声音或只念一个标题，先看消息里正文在哪个标签，再改这条正则。

**页面辅助**（`seed/scripts/page.js`，酒馆助手里叫"懒人快捷键"）：

- `Alt+,` / `Alt+.` 把聊天向上 / 向下翻 0.4 屏，`Alt+/` 运行"代写"快捷回复（走 `quickReplyApi`，不需要按钮在页面上；找不到会在控制台报错）。Alt 不看焦点在哪（ST 每次发送后会把焦点放回输入框）；带 Alt 的翻页会让输入框失焦，之后单按 `,` `.` 也能翻，直到再点进输入框；按住不放只算一次。
- 快捷回复"全屏"：手机浏览器里进入 / 退出全屏。`requestFullscreen` 必须在点击本身里调用，所以脚本在页面上以捕获阶段监听点击，认出点的是"全屏"按钮（id 4 的标签）就当场处理；iPhone 的 Safari 不支持网页元素全屏，只会提示，要全屏用"添加到主屏幕"。
- 生成中的提示：停止按钮出现的那段时间（ST 在写回复时显示它），在它上方（右边对齐）显示一个小药丸：闪动的圆点，加已用时间和已经收到的字数（`23s · 2294 字`，`STREAM_TOKEN_RECEIVED` 事件给的文本长度，包括卡里不显示的预处理块）；字数超过 5 秒（`STALL_AFTER`）没有增长，就整个换成"无新内容"的计时（`无新内容 6s`，更短，不会盖到快捷回复按钮），文字又来了就换回已用时间和字数，下次卡住从 0 重新计。已用时间一直在走，只有"无新内容"那个计时会重算。第一块文字到之前、以及没开流式时，只有时间。药丸不换行、不超出屏幕宽度。定位只用 `left`/`top`（加 `translate(-100%, -100%)` 放到停止按钮右上角的左上方）：ST 的 `style.css` 给 `<html>` 加了 `transform: translateZ(0)`（修 Chrome 闪烁），于是 `fixed` 元素的包含块是 `<html>` 而不是视口；在手机上它的盒子是原点处的空盒，用 `right`/`bottom` 时药丸被放到了 (-50, -64)，完全看不见。"更多"菜单同样只用 `left`/`top`。靠观察停止按钮的 `style` 变化开关，只有生成中才有定时器，结束后自动隐藏、下次从 0 开始。它只是提示，没有超时，也不会重试。
- 暂停屏外动画：有的卡在**每条消息**的 iframe 里画动态背景（飘浮的爱心、气泡、流星），同源的 srcdoc iframe 滚出视野后动画照跑（实测一个聊天里约 100 个动画，渲染进程占满一个核）。脚本用 `IntersectionObserver` 看每个消息 iframe（`TH-message` 开头）在不在视口（上下各留 300px），不在就往里注入 `animation-play-state: paused`，滚回来就删掉。
- 消息正文是 iframe，里面的按键事件到不了页面，所以每个 iframe 的文档上也挂同一个按键监听；iframe 每次渲染都会重建，所以用 `MutationObserver` 盯着。

## 图像生成和剧情命令

`seed/scripts/story.js`（酒馆助手运行）提供四个斜杠命令。它们都用 `generateRaw` 发一个**干净的请求**（不带角色扮演预设）：ST 自带的 `/sd me|you|…`、`/impersonate` 会带着整段聊天和预设去问模型，模型要么拒绝，要么按剧情格式回答，要么复述旧的玩家发言。

| 命令 | 入口 | 作用 |
|---|---|---|
| `/pic me｜you｜face｜bg｜last｜pov｜<名字、描述或场景>` | "更多"菜单 | 让模型写 SD 标签，再交给 ST 自己的 `/sd`；不带参数时提示用法 |
| `/imp [草稿]` | 快捷回复"代写"、`Alt+/` | 写玩家接下来的台词或动作，放进输入框，不自动发送 |
| `/sum` | "更多"菜单 | 把整个聊天总结成长期记忆，显示在弹窗里 |
| `/more` | 快捷回复"更多" | 在按钮上方弹出小菜单：画此刻、画第一人称(POV)、画我、画NPC、画特写、画景、画输入框里的…、总结 |

**不绑死卡和预设**：脚本里凡是和某张卡、某个预设有关的写法都不能写死。人称、语言、时态、台词格式一律让模型照玩家自己的发言（没有就照剧情）；`/sum` 用聊天本身的语言（指令是英文写的，写明"用聊天本身的语言，不是这段指令的语言"，否则英文聊天会被答成中文）。故事在哪个标签里：有 `<content>`（`CONFIG.storyBlock`，换了标签的卡改这里）就取它；没有就丢掉所有成对标签块（分析、状态栏、变量更新），丢完什么都不剩（卡把故事放在自己的标签里）就只去掉标签本身。

### `/pic`

```
/pic …
  1. gather：玩家第一条消息（当作他的角色档案）、最近 12 条 AI 回复、persona
  2. generateRaw：把材料和 STYLE 规则（story.js）发给聊天模型，要 SD 标签；回复第一行是画布（portrait/landscape），第二行是标签
  3. 校验：回复必须是标签列表（总长不超过 1500、每个标签不超过 80 字符），不是就重问一次，还不是就报错，不发给 /sd
  4. 画布：我/你/脸/第一人称固定竖版，背景固定横版，last 和自由文本用模型给的那行；标签原样使用，只去掉 | 和 {{（斜杠解析会当命令）
  5. /sd extend=false width= height= <标签>        交给 ST 自己的生图流程
  localdream   A1111 接口（imagegen-stack 的 run_localdream.sh）：去掉汉字、限制标签长度、画布吸附到手机支持的尺寸、断线重试
  手机（Local Dream）
```

- **脚本**知道意图（我、你、背景、情侣），负责向模型提问；怎么写标签全是 `STYLE` 那段给模型看的文字，**代码不改写标签**。手机换了模型（SDXL 等），只改这段文字；针对 SD1.5 弱点的规则都标了 `[SD1.5]`，换模型时先搜这个标记。代码只硬编码了一件事：单人和背景的画布。
- **localdream**只懂 SD1.5 和手机：约 77 个 token、不认汉字、画布最大 768、手机的模型启停。网关不认识任何客户端。
- 生图本身是 ST 的 `/sd`，后端能力（来源、放大、种子、采样器、模型切换等）更新 ST 就能拿到。拿不到的是 ST 在提示词生成层的新功能（魔杖菜单里的生图项、互动模式、函数工具模式、多模态识图、生成前的编辑弹窗）；魔杖菜单里的生图项仍用 ST 自带模板，会被拒绝，请用 `/pic`。依赖面很小：`generateRaw`、`triggerSlash('/sd …')`、`SlashCommandParser.addCommandObject`（四个命令都这样注册，带参数说明；ST 把旧的 `registerSlashCommand` 标成了弃用）。`st-init` 装酒馆助手和提示词模板用的是最新版，ST 镜像是 `latest`，需要稳定时固定版本。

### `/imp`

- 请求只带：persona、玩家的第一条消息、最近 3 条 AI 回复、玩家第一条之后自己最近 3 条发言（标明"已经写进剧情，不要重复"）、草稿，加一条指令。第一条玩家消息在有的聊天里是角色档案，有的是第一次行动，所以只标成"第一条消息"。
- 没有草稿写主角的台词或动作；有草稿就按草稿扩写，草稿写谁（包括 NPC）就写谁，也可以是纯叙述。限制（1～3 句、80 字）在系统指令和请求末尾各写一遍，小模型只看系统指令会写成好几段。
- **重抽**：输入框里还是上次的结果、没改过时再按"代写"，照原草稿重写；改过哪怕一个字就当新草稿。结果会替换输入框里原来的内容，原草稿只存在脚本内存里。
- 结果直接赋给输入框，再触发一次 `input` 事件让 ST 知道（字数统计、草稿保存都听它），**不经过斜杠解析器**，所以文字就是模型写的样子：换行、空格、`|`、`{{` 都保留；只去掉不属于正文的东西（思考块、代码围栏、首尾空白）。早先用 `/setinput`，解析器会把 `|` 和 `{{` 当命令、换行也处理不好，只能把它们去掉或压成空格。`/pic` 交给 `/sd` 的标签仍然要去掉这两个字符，那条路径必须经过解析器。
- 已知限制：玩家一条发言都没有、剧情又用"你"称呼玩家时，写出的人称和剧情对不上（没有依据可照）。

### `/sum` 和 `/more`

- `/sum`：把整个聊天（玩家发言和剧情按顺序，最多最近 20 万字）总结成 500～800 字的长期记忆。弹窗上面是放哪儿的说明，中间是只读文本框，底部"复制"和"关闭"并排；"复制"是弹窗的自定义按钮，选中文本框再 `execCommand("copy")`（剪贴板接口只有安全来源才有，手机用 `http://192.168…` 时没有），成功弹"已复制"。
- 用法：复制进聊天的"作者注释"（输入框左边的三横菜单），保持"聊天的特定深度 4，作为系统"和"插入频率 1"，再用 `/hide 2-N` 隐藏旧楼层（别隐藏开头的开局器和角色档案）。预设自带的"大总结模式"不用：卡要求只输出它规定的结构，两边会冲突。
- 什么时候需要：上下文还装得下整个聊天时不需要。MVU 变量存的是状态（位置、数值、人物关系），`大事记` 一栏虽然有，但常常是空的，长剧情的记忆要靠这个。
- `/more`：脚本在页面上画一个浮在"更多"按钮上方的 `div`（用主题自己的颜色变量），点哪一项跑哪一项，点别处或按 Esc 关闭。弹窗和菜单的参数写法对照了酒馆助手自带的类型定义（`@types/iframe/exported.sillytavern.d.ts`）。

### SD1.5 调参结论

（Anything V5；规则都写在 `STYLE` 里让模型照做）

- CFG 9、20 步：CFG 高一点对列出的物件更贴合；30 步多花时间，画面没有可见变化。
- 单人在宽画布上，或者没有 `solo`，常画成孪生，所以人物用竖版并加 `solo`。ST 在渲染过背景后会把画布宽度留在 896，所以每次请求都显式传 `width=`、`height=`。
- 两个人：互动标签放最前；每个人的标签成组放在一起（平铺混写会串发色），每人只给发色、眼色和一件衣服（多余的标签会漏到另一个人身上）。亲吻用 `upper body`，不要 `close-up`，也不要 `from side`。剩下的串色是 SD1.5 的下限，重新生成即可。
- 带动物名的词会被当成动物画（`cow print`、`hawk-like eyes`），所以不写比喻和动物纹样；角色设定里的宠物（肩上的蜥蜴）会被画坏，一律不写，这两条要写进 `you`/`face` 的任务句里才管用。要写明发色眼色，否则模型自己乱选。
- 疤痕、胡茬、腰包、短刃等设定细节在 512x768 下没有问题，保留。
- 关掉推理的小模型有时不写标签而是写分析，所以要校验（见上面）。有的上游会把部分请求误判成生图（有每日额度，用完返回 HTTP 500），"Draw …"开头的措辞会触发，所以任务用"Write the prompt for …"，并且一次只发一个请求。
- 手机是共用的：有人在生成时调 `/stop` 或改尺寸会把别人的任务打断，这里没有任何地方调用 `/stop`。

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
