// node --test story.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { story } from "./story.js";

const toastr = Object.fromEntries(["info", "warning", "error", "success"].map((name) => [name, () => {}]));
const chatOf = (...messages) => messages.map(([is_user, mes]) => ({ is_user, mes }));
const contextOf = (chat, extra = {}) => () => ({ chat, name1: "齐野", name2: "敖月", ...extra });

test("the story is the biggest block of a reply, not the reasoning, the JSON or the options", () => {
    const reply = "<think_fox~>R01 无交手</think_fox~>\n<content>敖月把灯压低，门外的脚步声停在三步之外，她没有回头，只把手按在剑柄上。</content>\n<fox_selc>一二</fox_selc>\n<UpdateVariable><JSONPatch>[{\"op\":\"replace\",\"path\":\"/a\",\"value\":1}]</JSONPatch></UpdateVariable>";
    assert.match(story.storyText(reply), /^敖月把灯压低/);
    assert.equal(story.storyText("<!-- note -->夜里很静。"), "夜里很静。");
});

test("the input of a picture is a kind or a free text, with nsfw as a flag", () => {
    assert.deepEqual(story.parseInput("pov"), { kind: "pov", subject: "", forceNsfw: false });
    assert.deepEqual(story.parseInput(""), { kind: "last", subject: "", forceNsfw: false });
    assert.deepEqual(story.parseInput("敖月 nsfw"), { kind: "free", subject: "敖月", forceNsfw: true });
});

test("the tags of a reply come with their canvas; a fixed kind keeps its own", () => {
    assert.deepEqual(story.parseReply("last", "landscape\n1girl, solo, night"), { canvas: "landscape", prompt: "1girl, solo, night" });
    assert.equal(story.parseReply("me", "landscape\n1girl, solo").canvas, "portrait");
    assert.deepEqual(story.parseReply("last", "Canvas: portrait, 1girl, solo"), { canvas: "portrait", prompt: "1girl, solo" }, "a label on the tag line is read");
    assert.equal(story.parseReply("last", "1girl, solo, standing").canvas, "landscape", "no canvas line: landscape");
});

test("choices: one per line, no numbering, no thinking or fences", () => {
    const reply = "<think>x</think>1. 我拔刀逼近\n- “你在等谁？”\n\n3) 我退半步\n```\n";
    assert.deepEqual(story.impChoices(reply), ["我拔刀逼近", "“你在等谁？”", "我退半步"]);
});

test("choices are asked from the story, and fail with a reason when there is none", async () => {
    const asked = [];
    const suggest = story.createImpChoices({ context: contextOf(chatOf([true, "我是齐野"], [false, "夜里，驿馆里很静。"])), generateRaw: async (args) => (asked.push(args), "甲\n乙\n丙\n丁") });
    assert.deepEqual(await suggest(), ["甲", "乙", "丙", "丁"]);
    assert.equal(asked[0].ordered_prompts[0].role, "system");
    assert.match(asked[0].ordered_prompts[1].content, /夜里，驿馆里很静/);
    await assert.rejects(story.createImpChoices({ context: contextOf([]), generateRaw: async () => "x" })(), /还没有剧情/);
    await assert.rejects(story.createImpChoices({ context: contextOf(chatOf([false, "夜里。"])), generateRaw: async () => " \n" })(), /没有返回内容/);
});

test("imp writes into the box; asked again over its own result it is a reroll of the first draft", async () => {
    const box = { value: "" };
    const drafts = [];
    const replies = ["第一版", "第二版"];
    const imp = story.createImp({
        context: contextOf(chatOf([true, "我是齐野"], [false, "夜里，驿馆里很静，灯火压得很低。"])),
        generateRaw: async ({ ordered_prompts }) => (drafts.push(ordered_prompts[1].content.includes("草稿：先问他")), replies.shift()),
        toastr,
        setInput: (text) => (box.value = text),
    });
    await imp("先问他");
    assert.equal(box.value, "第一版");
    await imp(box.value);
    assert.equal(box.value, "第二版");
    assert.deepEqual(drafts, [true, true], "the second time the original draft is used, not the first result");
});

test("pic puts a ready /sd command into the box, with explicit tags only when the latest reply has the terms", async () => {
    const box = { value: "" };
    const run = (reply, latest) =>
        story.createPic({ context: contextOf(chatOf([true, "我是齐野"], [false, latest])), generateRaw: async () => reply, toastr, setInput: (text) => (box.value = text) });
    await run("landscape\n1girl, solo, night street, lantern, ancient chinese town", "夜里，街上很静。")("last");
    assert.match(box.value, /^\/sd extend=false width=768 height=512 1girl, solo, night street/);
    assert.ok(!box.value.includes("nsfw"));
    await run("landscape\n1girl, 1boy, kissing, bed, bare skin, intimate", "她高潮了。")("last");
    assert.match(box.value, / nsfw, uncensored,/);
    await run("portrait\n1girl, solo, standing, smile, black hair, red eyes", "夜里，街上很静。")("me");
    assert.match(box.value, /width=512 height=768/);
});

test("pic with an empty box asks for something to draw and writes nothing", async () => {
    const told = [];
    const pic = story.createPic({ context: contextOf(chatOf([false, "夜里。"])), generateRaw: async () => assert.fail("no request"), toastr: { ...toastr, info: (text) => told.push(text) }, setInput: () => assert.fail("no input") });
    await pic("  ");
    assert.match(told[0], /输入框是空的/);
});

test("the summary goes to the window, from the whole chat", async () => {
    let shown;
    const sum = story.createSum({ context: contextOf(chatOf([true, "我是齐野"], [false, "夜里，驿馆里很静。"])), generateRaw: async ({ ordered_prompts }) => (assert.match(ordered_prompts[1].content, /Player:\n我是齐野/), "<think>x</think>时间线：夜里"), toastr, show: (text) => (shown = text) });
    await sum();
    assert.equal(shown, "时间线：夜里");
});

test("the TTS provider reads the story; a missing module is only a warning", async () => {
    const provider = { prototype: {} };
    await story.installTts(async (path) => (assert.equal(path, "/scripts/extensions/tts/edge.js"), { EdgeTtsProvider: provider }));
    assert.match(provider.prototype.processText("<think>x</think><content>敖月把灯压低，门外的脚步声停在三步之外。</content><fox_selc>一</fox_selc>"), /^敖月把灯压低/);
    await story.installTts(async () => {
        throw new Error("no such module");
    });
});
