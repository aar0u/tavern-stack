// node --test extension/profiles.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, ROLES, activePrompts, clone, nameMatches, newId, normalizeSettings } from "./profiles.js";

test("a match is part of the name, or a regular expression", () => {
    assert.equal(nameMatches("大凉", "大凉龙虎传v4.15"), true);
    assert.equal(nameMatches("ALICE", "alice smith"), true);
    assert.equal(nameMatches("/v4\\.1[0-9]$/", "大凉龙虎传v4.15"), true);
    assert.equal(nameMatches("/v3/", "大凉龙虎传v4.15"), false);
    assert.equal(nameMatches("/(/", "anything"), false, "a broken expression matches nothing");
    assert.equal(nameMatches("", "name"), false);
    assert.equal(nameMatches("name", null), false, "no character, as in a group chat");
});

test("the default settings send the two prompts to the default character only", () => {
    const active = activePrompts(DEFAULT_SETTINGS, "大凉龙虎传v4.11");
    assert.deepEqual(active.map((p) => p.key), ["tavern_stack:daliang:header", "tavern_stack:daliang:update"]);
    assert.ok(active.every((p) => p.depth === 0 && p.role === ROLES.system && p.text.length > 20));
    assert.deepEqual(activePrompts(DEFAULT_SETTINGS, "空姐卡"), []);
    assert.deepEqual(activePrompts(DEFAULT_SETTINGS, null), []);
});

test("switches turn prompts off, and an empty text is not sent", () => {
    const off = clone(DEFAULT_SETTINGS);
    off.enabled = false;
    assert.deepEqual(activePrompts(off, "大凉龙虎传"), []);

    const profile = clone(DEFAULT_SETTINGS);
    profile.profiles[0].enabled = false;
    assert.deepEqual(activePrompts(profile, "大凉龙虎传"), []);

    const prompt = clone(DEFAULT_SETTINGS);
    prompt.profiles[0].prompts[0].enabled = false;
    prompt.profiles[0].prompts[1].text = "   ";
    assert.deepEqual(activePrompts(prompt, "大凉龙虎传"), []);
});

test("settings from disk are completed, and the user's profiles are kept", () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings("junk"), DEFAULT_SETTINGS);

    const mine = normalizeSettings({
        enabled: "yes",
        ball: { x: 10, y: "no" },
        profiles: [{ id: "a", name: "A", match: "/x/", prompts: [{ id: "p", text: "hi", depth: -1, role: "tool" }, null] }, 7],
    });
    assert.equal(mine.enabled, true, "a wrong type falls back to the default");
    assert.deepEqual(mine.ball, { show: true, x: 10, y: null });
    assert.equal(normalizeSettings({ tail: { show: false } }).tail, undefined);
    assert.equal(mine.profiles.length, 1, "the default profile does not come back next to the user's");
    assert.deepEqual(mine.profiles[0].prompts, [{ id: "p", label: "提示词", enabled: true, depth: 0, role: "system", text: "hi" }]);

    assert.deepEqual(normalizeSettings({ profiles: [] }).profiles, [], "no profile at all is the user's choice");
});

test("the social format rule upgrades only the unchanged default prompt", () => {
    const old = clone(DEFAULT_SETTINGS);
    const update = old.profiles[0].prompts[1];
    update.text = "【落卷】每轮正文之后必须输出一个 <UpdateVariable> 块，含 <Analysis> 和 <JSONPatch>。本轮没有变量变化时，JSONPatch 写 []，不得省略整个块。";
    const upgraded = normalizeSettings(old);
    const rule = activePrompts(upgraded, "大凉龙虎传v4.15").find((prompt) => prompt.key.endsWith(":update")).text;
    assert.match(rule, /kind 必须在 value 顶层/);
    assert.match(rule, /禁止用.*signature.*包装待办/);
    assert.match(rule, /同一事实不得重复登记/);
    update.text = "My custom prompt";
    assert.equal(normalizeSettings(old).profiles[0].prompts[1].text, "My custom prompt");
    assert.doesNotMatch(activePrompts(upgraded, "其他角色").map((prompt) => prompt.text).join(""), /好感待办格式/);
});

test("new ids do not repeat", () => {
    const taken = [{ id: "pabcde" }];
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
        const id = newId("p", taken);
        assert.ok(!ids.has(id) && id !== "pabcde");
        ids.add(id);
        taken.push({ id });
    }
});
