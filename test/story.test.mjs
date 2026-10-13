// node test/story.test.mjs: tests of seed/scripts/story.js (/pic and /imp) with stubs for everything SillyTavern and Tavern Helper provide.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const here = new URL("../seed/scripts/story.js", import.meta.url);
const story = createRequire(import.meta.url)(here.pathname);

// --- story text: the <content> block with inner tags removed, comments gone; other replies minus tag blocks
assert.equal(
  story.storyText("<MoshiCensor>自检</MoshiCensor>\n<content>\n<time>晨</time>\n<now_plot>\n<!-- 草稿 -->她推开门。\n</now_plot>\n</content>\n<UpdateVariable>x</UpdateVariable>"),
  "晨\n她推开门。",
);
assert.equal(story.storyText("<think>x</think>She waves.<!-- c -->"), "She waves.");
assert.equal(story.storyText("<story>\n她推开门。\n</story>"), "她推开门。", "a card whose story is inside a tag of its own is not emptied");
assert.equal(story.storyText("<status>HP 3</status>\n她推开门。"), "她推开门。", "with text outside the tags, the tag blocks are still dropped");
assert.equal(
  story.storyText("<check>格式：<content><now_plot>.........</now_plot></content></check>\n<content>\n<now_plot>他走上街头，买了一盒桂花糕。</now_plot>\n</content>\n<UpdateVariable>{\"a\": 1, \"b\": 2, \"c\": 3}</UpdateVariable>"),
  "他走上街头，买了一盒桂花糕。",
  "a template quoted in a self-check is not the story, whichever tags the card uses",
);
assert.equal(story.storyText("Honestly: \"No.\" \"Yes.\" \"Fine.\" she said, and walked out."), "Honestly: \"No.\" \"Yes.\" \"Fine.\" she said, and walked out.", "English dialogue is not JSON");
assert.equal(
  story.storyText("<think_nya~>\n规划：转场到坊市\n<rule_check>ok</rule_check>\n</think_nya~>\n<game>\n他走上街头。\n</game>\n<summary>小结</summary>\n<UpdateVariable>x</UpdateVariable>"),
  "他走上街头。",
  "a card whose story is in <game>: the planning text before it is not the story",
);

// --- gather
const chat = [
  { name: "旁白", mes: "[开局器]" },
  { is_user: true, mes: "姓名：齐野\n外貌：深棕碎发" },
  { mes: "<content>\n你推开门。\n</content>" },
  { mes: "[旁白 sends a picture that contains: 1girl, red hair]", extra: { media: [{ url: "x.png" }] } },
  { mes: "<content>\n塞芙琳点了一支烟。\n</content>" },
  { mes: "hidden reply", is_system: true },
];
const context = { chat, name1: "齐野", powerUserSettings: { persona_description: "  28岁  " } };
const material = story.gather(context);
assert.equal(material.player, "齐野");
assert.equal(material.persona, "28岁");
assert.equal(material.intro, "姓名：齐野\n外貌：深棕碎发");
assert.equal(material.story, "[开局器]\n\n你推开门。\n\n塞芙琳点了一支烟。", "picture and hidden messages are left out");
assert.equal(story.gather({ chat: [] }).player, "the player");

// --- request: the style text as system, then one user message with the sections in order
const request = story.buildRequest("me", "", material);
assert.deepEqual(request.map((m) => m.role), ["system", "user"]);
assert.equal(request[0].content, story.STYLE);
const user = request[1].content;
assert.ok(user.indexOf("Player description:") < user.indexOf("Player text") && user.indexOf("Player text") < user.indexOf("Story text:") && user.indexOf("Story text:") < user.indexOf("Task:"));
assert.match(user, /Task: Write the prompt for a full body picture of 齐野/);
assert.match(story.buildRequest("free", "me + you kissing", material)[1].content, /Subject: me \+ you kissing$/);
assert.equal(story.buildRequest("bg", "", { ...material, persona: "", intro: "" })[1].content.startsWith("Story text:"), true);
// the SD1.5 phone gets the rules its model needs; sdcpp does not
for (const kind of ["you", "face"]) {
  assert.match(story.buildRequest(kind, "", material, true)[1].content, /No pets or creatures/, "SD1.5: NPC kinds repeat the pet ban in the task");
  assert.doesNotMatch(story.buildRequest(kind, "", material)[1].content, /No pets or creatures/, "sdcpp: no pet ban");
}
assert.match(story.buildRequest("last", "", material, true)[0].content, /When two faces touch[\s\S]*Never write a pet[\s\S]*No animal words/);
assert.doesNotMatch(story.buildRequest("last", "", material)[0].content, /When two faces touch|Never write a pet|animal words/);
assert.ok(story.buildRequest("last", "", material, true)[0].content.endsWith("the second line is the tags."), "the canvas line stays last");
for (const kind of ["me", "you", "face", "bg", "last", "free"]) {
  assert.doesNotMatch(story.buildRequest(kind, "x", material)[1].content, /\bDraw\b/, "'Draw …' trips the upstream image-quota classifier");
}

// --- reply parsing: the first line may be the canvas; the fixed kinds ignore it
assert.deepEqual(story.parseReply("free", "Landscape\n```\nTags: 1girl, 1boy, kissing\n```"), { canvas: "landscape", prompt: "1girl, 1boy, kissing" });
assert.deepEqual(story.parseReply("free", "portrait\n1girl, red hair"), { canvas: "portrait", prompt: "1girl, red hair" });
assert.deepEqual(story.parseReply("last", "1girl, red hair"), { canvas: "landscape", prompt: "1girl, red hair" }, "no canvas line: landscape");
assert.deepEqual(story.parseReply("free", "Canvas: portrait, full body portrait, 1girl, solo"), { canvas: "portrait", prompt: "full body portrait, 1girl, solo" }, "a labelled canvas on the tag line");
assert.deepEqual(story.parseReply("free", "canvas: landscape\n1girl, 1boy"), { canvas: "landscape", prompt: "1girl, 1boy" });
assert.deepEqual(story.parseReply("free", "portrait, upper body, 1girl, solo"), { canvas: "landscape", prompt: "portrait, upper body, 1girl, solo" }, "an unlabelled bust tag list keeps its first tag");
assert.equal(story.parseReply("you", "landscape\n1girl, solo").canvas, "portrait", "a lone character is never drawn wide");
assert.equal(story.parseReply("bg", "portrait\nscenery, desert").canvas, "landscape");
assert.equal(story.parseReply("me", "<think>hm</think>portrait\n1boy, brown hair").prompt, "1boy, brown hair");
assert.equal(story.parseReply("free", "landscape\na | /echo x, {{user}} hair").prompt, "a /echo x, user hair", "no pipe or macro survives for the slash parser");

// --- a refusal that still carries a milder tag list: the list is used, the prose around it is not
const refusal = "I cannot generate visual tags or descriptive prompts depicting explicit sexual acts.\n\nI can, however, provide visual tags in a non-explicit composition.\n\n**Alternative Prompt (Non-explicit):**\n\nlandscape\n1girl, 1boy, couple, on bed, intimate, embrace, 1girl, long black hair, blue eyes, blush";
assert.deepEqual(story.parseReply("last", refusal), { canvas: "landscape", prompt: "1girl, 1boy, couple, on bed, intimate, embrace, 1girl, long black hair, blue eyes, blush" });

// --- input
assert.deepEqual(story.parseInput(" me "), { kind: "me", subject: "", forceNsfw: false });
assert.deepEqual(story.parseInput(" BG "), { kind: "bg", subject: "", forceNsfw: false });
assert.deepEqual(story.parseInput(" POV "), { kind: "pov", subject: "", forceNsfw: false });
assert.deepEqual(story.parseInput("nsfw"), { kind: "last", subject: "", forceNsfw: true });
assert.deepEqual(story.parseInput("pov NSFW"), { kind: "pov", subject: "", forceNsfw: true }, "nsfw next to a bare kind forces the explicit tags for that kind");
assert.deepEqual(story.parseInput("齐野和塞芙琳热吻"), { kind: "free", subject: "齐野和塞芙琳热吻", forceNsfw: false });

// --- /pic: what goes to the model and what goes to /sd
function harness(replyOrError, ctx = context) {
  const log = { raw: [], slash: [], toasts: [] };
  const toastr = Object.fromEntries(["info", "warning", "error"].map((level) => [level, (text) => log.toasts.push([level, text])]));
  const run = story.createPic({
    context: () => ctx,
    generateRaw: async (config) => {
      log.raw.push(config);
      const reply = Array.isArray(replyOrError) ? replyOrError[Math.min(log.raw.length, replyOrError.length) - 1] : replyOrError;
      if (reply instanceof Error) throw reply;
      return reply;
    },
    setInput: (text) => log.slash.push(text),
    toastr,
  });
  return { run, log };
}

let h = harness("portrait\nfull body portrait, 1girl, solo, red hair, green eyes, simple background");
await h.run("you");
assert.equal(h.log.raw.length, 1);
assert.equal(h.log.raw[0].should_silence, true);
assert.equal(h.log.slash[0], "/sd extend=false width=512 height=768 full body portrait, 1girl, solo, red hair, green eyes, simple background");

h = harness("landscape\nupper body, 1girl, 1boy, kissing, 1girl, red hair, green eyes, 1boy, dark brown hair, brown eyes");
await h.run("齐野和塞芙琳热吻");
assert.equal(h.log.slash[0], "/sd extend=false width=768 height=512 upper body, 1girl, 1boy, kissing, 1girl, red hair, green eyes, 1boy, dark brown hair, brown eyes");
assert.match(h.log.raw[0].ordered_prompts[1].content, /Subject: 齐野和塞芙琳热吻$/);
assert.equal(h.log.raw.length, 1, "one model call per picture");

// explicit tags: only from an explicit story or an explicit 'nsfw', never from the model's own tags (a kiss, a bed, a blush)
const explicitContext = { ...context, chat: [...chat, { mes: "<content>\n她握住他的阴茎。\n</content>" }] };
h = harness("landscape\n1girl, 1boy, kissing, on bed, blush", explicitContext);
await h.run("last");
assert.ok(h.log.slash[0].includes(`${story.NSFW_BASE}, 1girl, 1boy, kissing`), "an explicit story adds the base tags");
assert.doesNotMatch(h.log.raw[0].ordered_prompts[1].content, /阴茎/, "and the model never sees the explicit sentence");
h = harness("landscape\n1girl, 1boy, kissing, on bed, blush");
await h.run("last");
assert.ok(!h.log.slash[0].includes("nsfw"), "a kiss on a bed is not explicit");
await h.run("last nsfw");
assert.ok(h.log.slash[1].includes(story.NSFW_BASE), "nsfw forces the base tags");

// an explicit scene a few replies back does not make the latest, plain reply explicit
const afterwards = { ...context, chat: [...chat, { mes: "<content>\n她握住他的阴茎。\n</content>" }, { mes: "<content>\n天亮了，两人在桌边吃早饭。\n</content>" }] };
h = harness("landscape\n1girl, 1boy, eating, table, morning", afterwards);
await h.run("last");
assert.ok(!h.log.slash[0].includes("nsfw"), "only the latest reply decides");

// the style follows SillyTavern's image source
h = harness("landscape\n1girl, 1boy", { ...context, extensionSettings: { sd: { source: "auto" } } });
await h.run("last");
assert.match(h.log.raw[0].ordered_prompts[0].content, /Never write a pet/, "source 'auto' is the SD1.5 phone");
h = harness("landscape\n1girl, 1boy", { ...context, extensionSettings: { sd: { source: "sdcpp" } } });
await h.run("last");
assert.doesNotMatch(h.log.raw[0].ordered_prompts[0].content, /Never write a pet/, "sdcpp gets the plain style");

// the toast says why the explicit tags were added
{
  const toasts = [];
  const pic = story.createPic({ context: () => explicitContext, generateRaw: async () => "landscape\n1girl, 1boy", setInput: () => {}, toastr: { info: (t) => toasts.push(t), warning() {}, error() {} } });
  await pic("last");
  assert.match(toasts.at(-1), /已加露骨标签：阴茎/);
  await pic("me");
  assert.doesNotMatch(toasts.at(-1), /已加露骨标签/, "no explicit tags for a kind that does not get them");
}

// a scrub-only term is kept from the model but does not add the explicit tags
const plainContext = { ...context, chat: [...chat, { mes: "<content>\n鼻尖微微耸动。她的脸庞稚嫩清秀。\n</content>" }] };
h = harness("landscape\n1girl, solo, smile", plainContext);
await h.run("last");
assert.ok(!h.log.slash[0].includes("nsfw"), "SCRUB_TERMS alone add no explicit tags");
assert.doesNotMatch(h.log.raw[0].ordered_prompts[1].content, /稚嫩|耸动/, "but the model does not read them");

assert.equal(story.stripMale("1girl, 1boy, green eyes, brown hair"), "1girl, green eyes, brown hair");

h = harness("landscape\n1girl, 1boy, inside military vehicle, purple coat, green eyes, brown vest, brown hair");
await h.run("last");
assert.equal(h.log.slash[0], "/sd extend=false width=768 height=512 1girl, 1boy, inside military vehicle, purple coat, green eyes, brown vest, brown hair", "last with regular scene preserves clothes and setting");

h = harness("landscape\n1girl, 1boy, kissing, lying on bed, purple coat, green eyes, brown vest, brown hair");
await h.run("last");
assert.equal(h.log.slash[0], "/sd extend=false width=768 height=512 1girl, 1boy, kissing, lying on bed, purple coat, green eyes, brown vest, brown hair", "last preserves model tags faithfully without forcing nudity or stripping clothes");

h = harness("portrait\n1girl, smiling, looking at viewer, purple coat, green eyes");
await h.run("pov");
assert.equal(h.log.slash[0], "/sd extend=false width=512 height=768 pov, looking at viewer, 1girl, smiling, purple coat, green eyes", "pov with regular scene preserves clothes");

h = harness("portrait\n1girl, 1boy, lying on bed, lifted skirt, blush, green eyes, brown hair");
await h.run("pov");
assert.equal(h.log.slash[0], "/sd extend=false width=512 height=768 pov, looking at viewer, 1girl, lying on bed, lifted skirt, blush, green eyes, brown hair", "pov preserves story pose and clothed attire while stripping male tags");

const prose = "Let me analyze the latest scene to determine who speaks or acts the most. The latest scene is the ongoing journey east along the merchant road.";
h = harness([prose, "portrait\nfull body portrait, 1girl, solo, red hair"]);
await h.run("you");
assert.equal(h.log.raw.length, 2, "prose instead of tags is asked for once more");
assert.equal(h.log.slash[0], "/sd extend=false width=512 height=768 full body portrait, 1girl, solo, red hair");

h = harness([prose]);
await h.run("you");
assert.equal(h.log.raw.length, 2, "one retry, not a loop");
assert.equal(h.log.slash.length, 0, "prose never reaches /sd");
assert.match(h.log.toasts.at(-1)[1], /^画图失败: 模型没有按格式返回标签/);

h = harness(new Error("upstream down"));
await h.run("bg");
assert.equal(h.log.slash.length, 0, "no image request after a failed model call");
assert.deepEqual(h.log.toasts.at(-1), ["error", "画图失败: upstream down"]);

h = harness(["", "portrait\nfull body portrait, 1boy, solo, brown hair"]);
await h.run("me");
assert.equal(h.log.raw.length, 2, "an empty reply (safety filter) retries with clean material and succeeds");
assert.doesNotMatch(h.log.raw[1].ordered_prompts[1].content, /Story text:/, "retry drops story text to bypass safety filter");
assert.equal(h.log.slash[0], "/sd extend=false width=512 height=768 full body portrait, 1boy, solo, brown hair");

h = harness("   ");
await h.run("me");
assert.equal(h.log.slash.length, 0, "an empty reply is an error, not an empty /sd");
assert.deepEqual(h.log.toasts.at(-1), ["error", "画图失败: 模型返回了空内容"], "an empty reply says so instead of a blank after the colon");

h = harness("1girl", { chat: [], name1: "x" });
await h.run("me");
assert.deepEqual(h.log.toasts.at(-1), ["warning", "聊天里还没有剧情可画"]);
assert.equal(h.log.raw.length, 0);

h = harness("1girl");
await h.run("  ");
assert.equal(h.log.toasts.at(-1)[0], "info", "no argument prints the usage");

// --- /imp: a clean request from the latest replies only, the answer goes to the input box as one safe line
const impMaterial = story.gather({ chat: [{ is_user: true, mes: "档案" }, ...Array.from({ length: 5 }, (_, i) => ({ mes: `<content>第${i}段</content>` }))], name1: "齐野" }, story.CONFIG.impMessages);
assert.equal(impMaterial.story, "第2段\n\n第3段\n\n第4段", "only the latest replies");
const impRequest = story.buildImpRequest(impMaterial, "去看看");
assert.match(impRequest[1].content, /The player's first message:\n档案\n\nStory text:/, "the first message is passed on, labelled as neither a sheet nor an action");
const lateMaterial = story.gather({ chat: [{ is_user: true, mes: "早" }, { mes: "<content>甲</content>" }, { is_user: true, mes: "二" }, { is_user: true, mes: "三" }, { is_user: true, mes: "四" }, { is_user: true, mes: "五" }, { mes: "<content>乙</content>" }], name1: "齐野" }, story.CONFIG.impMessages);
assert.deepEqual(lateMaterial.recent, ["三", "四", "五"], "the latest player messages, oldest first, never the first one again");
assert.match(story.buildImpRequest(lateMaterial, "")[1].content, /Story text:\n甲\n\n乙\n\nWhat the player recently said or did[^\n]*\n三\n---\n四\n---\n五/, "after the story, so the model sees what not to repeat");
assert.doesNotMatch(story.buildImpRequest(story.gather({ chat: [{ mes: "<content>甲</content>" }], name1: "齐野" }, 3), "")[1].content, /recently said/, "no section when the player has said nothing");
assert.deepEqual(impRequest.map((m) => m.role), ["system", "user"]);
assert.match(impRequest[0].content, /没有草稿则写齐野接下来的台词或动作/);
assert.match(impRequest[0].content, /草稿写谁就写谁/, "a draft about another character stays about them");
assert.match(impRequest[1].content, /Story text:\n第2段[\s\S]*草稿：去看看\n\n请按草稿写接下来发生的内容：只写一段，最多3句话，不超过80字/, "the limits are repeated at the end");
assert.doesNotMatch(impRequest[0].content + impRequest[1].content, /第三人称|「/, "no person or quote style of one particular card is imposed: the player's own messages set it");
assert.match(impRequest[0].content, /与玩家自己的发言一致/);
assert.match(story.buildImpRequest(impMaterial, "")[1].content, /请写齐野接下来的台词或动作：只写一段/, "no draft: the player is the subject again");
assert.doesNotMatch(story.buildImpRequest(impMaterial, "")[1].content, /草稿/, "no draft section when the draft is empty");
assert.equal(story.impText("<think>x</think>```\n「走。」|{{user}}\n\n  他起身。\r\n```"), "「走。」|{{user}}\n\n  他起身。", "as the model wrote it: line breaks, spaces, a pipe and a macro stay; thinking, fences and the blank ends go");
{
  const log = { raw: [], set: [], toasts: [] };
  const imp = story.createImp({
    context: () => context,
    generateRaw: async (config) => (log.raw.push(config), "「走吧。」"),
    setInput: async (text) => log.set.push(text),
    toastr: Object.fromEntries(["info", "warning", "error"].map((level) => [level, (text) => log.toasts.push([level, text])])),
  });
  await imp("");
  assert.deepEqual(log.set, ["「走吧。」"]);
  assert.equal(log.raw[0].should_silence, true);
  let focused = 0;
  const focusing = story.createImp({ context: () => context, generateRaw: async () => "「走。」", setInput: async () => {}, toastr: { info() {}, warning() {}, error() {} }, focusInput: () => (focused += 1) });
  await focusing("");
  assert.equal(focused, 1, "the input box gets the focus once the text is in it");
  const failing = story.createImp({ context: () => context, generateRaw: async () => { throw new Error("down"); }, setInput: async () => {}, toastr: { info() {}, warning() {}, error() {} }, focusInput: () => (focused += 1) });
  await failing("");
  assert.equal(focused, 1, "no focus change when nothing was written");
  const prompts = [];
  const warned = [];
  const rerolling = story.createImp({ context: () => context, generateRaw: async (config) => (prompts.push(config.ordered_prompts[1].content), "「甲。」"), setInput: async () => {}, toastr: { info() {}, warning: (t) => warned.push(t), error() {} } });
  await rerolling("去看看");
  await rerolling("「甲。」 ");
  await rerolling("「甲。」");
  assert.deepEqual(prompts.map((p) => /草稿：去看看/.test(p)), [true, true, true], "the unchanged result in the box is rerolled from the original draft");
  await rerolling("「甲。」改了");
  assert.match(prompts.at(-1), /草稿：「甲。」改了/, "an edited result is a new draft");
  await rerolling("");
  await rerolling("「甲。」");
  assert.doesNotMatch(prompts.at(-1), /草稿/, "an empty original draft stays empty when rerolled");
  const empty = story.createImp({ context: () => ({ chat: [] }), generateRaw: async () => "x", setInput: async () => assert.fail("nothing to continue"), toastr: { info() {}, warning: (t) => log.toasts.push(["warning", t]), error() {} } });
  await empty("");
  assert.deepEqual(log.toasts.at(-1), ["warning", "聊天里还没有剧情可接"]);
}

// --- /sum: the whole chat in order, both sides, shown in a window
const sumChat = { chat: [{ is_user: true, mes: " 档案 " }, { mes: "<content>甲</content>" }, { is_system: true, mes: "[图]" }, { is_user: true, mes: "二" }, { mes: "<!-- x --><content>乙</content>" }, { is_user: true, mes: "  " }] };
assert.equal(story.transcript(sumChat), "Player:\n档案\n\nStory:\n甲\n\nPlayer:\n二\n\nStory:\n乙", "both sides in order; system messages and empty ones left out");
assert.equal(story.transcript({ chat: Array.from({ length: 3 }, () => ({ mes: `<content>${"字".repeat(150000)}</content>` })) }).length, story.CONFIG.sumChars, "capped, keeping the end");
{
  const shown = [];
  const sent = [];
  const toasts = [];
  const summarize = (generateRaw, context = sumChat) => story.createSum({ context: () => context, generateRaw, toastr: { info() {}, warning: (t) => toasts.push(["warning", t]), error: (t) => toasts.push(["error", t]) }, show: async (text) => shown.push(text) });
  await summarize(async (config) => (sent.push(config.ordered_prompts), "<think>x</think>```\n时间线：……\n```\n"))();
  assert.deepEqual(shown, ["时间线：……"], "the cleaned answer goes to the window");
  assert.deepEqual(sent[0].map((m) => m.role), ["system", "user"]);
  assert.match(sent[0][1].content, /^Player:\n档案/, "the transcript is the user message");
  await summarize(async () => "  ")();
  await summarize(async () => { throw new Error("down"); })();
  await summarize(async () => "x", { chat: [] })();
  assert.deepEqual(toasts, [["error", "总结失败: 模型返回了空内容"], ["error", "总结失败: down"], ["warning", "聊天里还没有内容可总结"]]);
  assert.equal(shown.length, 1, "nothing is shown for an empty reply, an error or an empty chat");
}

// --- the Tavern Helper side: with no `module`, the script registers /pic and /imp using the runtime's globals
const registered = [];
const popups = [];
const box = { value: "「走。」", events: [], focus() { this.focused = true; }, setSelectionRange(from, to) { this.range = [from, to]; }, dispatchEvent(event) { this.events.push(event); } };
const summaryBox = { select() { this.selected = true; } };
const clipboard = [];
const toastsSeen = [];
const pageDocument = {
  defaultView: { Event: class { constructor(type, init) { Object.assign(this, { type }, init); } } },
  getElementById: (id) => ({ send_textarea: box, "st-sum-text": summaryBox })[id] ?? null,
  execCommand: (command) => (clipboard.push(`exec:${command}:${summaryBox.selected}`), true),
};
runInNewContext(readFileSync(here, "utf8"), {
  console,
  window: { parent: { document: pageDocument } },
  SillyTavern: {
    getContext: () => ({
      ...context,
      SlashCommandParser: { addCommandObject: (commandObject) => registered.push(commandObject) },
      SlashCommand: { fromProps: (props) => props },
      SlashCommandArgument: { fromProps: (props) => props },
      ARGUMENT_TYPE: { STRING: "string" },
      POPUP_TYPE: { TEXT: "text" },
      callGenericPopup: async (...args) => popups.push(args),
    }),
  },
  generateRaw: async () => "portrait\n1boy, brown hair",
  toastr: { info() {}, warning() {}, error: (text) => toastsSeen.push(["error", text]), success: (text) => toastsSeen.push(["success", text]) },
});
assert.deepEqual(registered.map((registeredCommand) => registeredCommand.name).sort(), ["imp", "more", "pic", "sum"]);
const command = (name) => registered.find((registeredCommand) => registeredCommand.name === name).callback;
assert.deepEqual(registered.map((c) => [c.name, c.unnamedArgumentList.length]).sort(), [["imp", 1], ["more", 0], ["pic", 1], ["sum", 0]], "/imp and /pic take one optional text, the others none");
assert.ok(registered.every((c) => c.helpString), "every command has help text");
assert.equal(await command("pic")({}, "me"), "", "a slash command returns no text for the chat");
assert.equal(box.value, "/sd extend=false width=512 height=768 1boy, brown hair", "/pic fills the box with a ready /sd command and draws nothing");
box.value = "「走。」";
box.events.length = 0;
assert.equal(await command("imp")({}, ""), "");
assert.equal(box.value, "portrait\n1boy, brown hair", "the text is assigned to the box as it is, not sent through the slash parser");
assert.deepEqual(box.events.map((event) => [event.type, event.bubbles]), [["input", true]], "with an input event for SillyTavern to notice");
assert.equal(box.focused, true, "in the page, the real input box is focused after /imp");
assert.deepEqual(box.range, [box.value.length, box.value.length], "with the caret at the end");
assert.equal(await command("sum")({}), "");
const [html, popupType, , popupOptions] = popups.at(-1);
assert.equal(popupType, "text", "a plain window; the text box is part of its content");
assert.equal(popupOptions.wide, true);
assert.match(html, /^<div[^]*作者注释[^]*<textarea readonly[^>]*>portrait\n1boy, brown hair<\/textarea>$/, "where to put it, then the summary in a read-only box, once");
assert.equal(story.sumPopupHtml("a <b> & c</textarea>").split("<textarea")[1].split("</textarea>")[0].split(">")[1], "a &lt;b&gt; &amp; c&lt;/textarea&gt;", "the summary cannot break out of its box");
const [copyButton] = popupOptions.customButtons;
assert.deepEqual([copyButton.text, copyButton.appendAtEnd, copyButton.result], ["复制", true, undefined], "a copy button next to the close button that does not close the window");
copyButton.action();
assert.deepEqual(clipboard, ["exec:copy:true"], "the text box is selected and copied, which also works on http://192.168… where the clipboard API does not exist");
assert.deepEqual(toastsSeen.at(-1), ["success", "已复制"]);

// --- /more: the one quick reply for the rest
// The menu itself is drawn on the page and not tested here; what is chosen runs the item.
{
  const ran = [];
  const items = ["甲", "乙"].map((text) => ({ text, run: async () => ran.push(text) }));
  let answer = 1;
  const more = story.createMore({ items, choose: async (texts) => (ran.push(texts), answer) });
  await more();
  assert.deepEqual(ran, [["甲", "乙"], "乙"], "the texts are offered, the chosen one runs");
  answer = null;
  await more();
  assert.equal(ran.length, 3, "dismissed: nothing runs");

  const used = [];
  const parts = { pic: (kind) => used.push(`pic ${kind}`), sum: () => used.push("sum"), inputText: () => "桥边的老人" };
  const withPictures = story.moreItems({ pictures: true, ...parts });
  assert.deepEqual(withPictures.map((item) => item.text), ["画此刻", "画第一人称(POV)", "画我", "画NPC", "画特写", "画景", "画输入框里的…", "总结"]);
  for (const item of withPictures) await item.run();
  assert.deepEqual(used, ["pic last", "pic pov", "pic me", "pic you", "pic face", "pic bg", "pic 桥边的老人", "sum"], "each item does what its name says; the input box's text is what 画输入框里的… draws");
  assert.deepEqual(story.moreItems({ pictures: false, ...parts }).map((item) => item.text), ["总结"], "without pictures only the summary is left");
}

console.log("story.js tests passed");
