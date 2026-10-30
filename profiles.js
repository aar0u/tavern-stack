// The logic of the extension that needs no SillyTavern: profiles, which character a profile is for, and which prompts are active.
// index.js does the page and the API calls; node tests this file (profiles.test.mjs).

// SillyTavern's own numbers for setExtensionPrompt (extension_prompt_types.IN_CHAT and extension_prompt_roles); the extension context does
// not export them.
export const IN_CHAT = 1;
export const ROLES = { system: 0, user: 1, assistant: 2 };

// One line before the body of every reply, in the seven fields the 大凉龙虎传 time script reads (the first two decide the clock), and the
// update block after it. The model leaves both out half of the time when the card only says "when needed".
const HEADER = `【页眉】回复的正式正文之前（准备、草稿、思考、变量分析之外），独立输出一行时空页眉，固定七格，用全角｜连接，整行不加字段名、方括号或加粗：时间｜本轮经过｜旬｜朝昼暮夜｜天气｜地点｜当前剧情线。有明确落点时，第一格写「至」加完整年号、月、日、时辰，第二格写「—」；只有时长时，第一格照抄当前时间，第二格写实际经过；当前剧情线没有时写「—」。每轮必须输出，不得省略。页眉之后空一行再写正文。`;
const UPDATE = `【落卷】每轮正文之后必须输出一个 <UpdateVariable> 块，含 <Analysis> 和 <JSONPatch>。本轮没有变量变化时，JSONPatch 写 []，不得省略整个块。`;

export const DEFAULT_SETTINGS = {
    version: 1,
    enabled: true,
    ball: { show: true, x: null, y: null },
    tail: { show: true },
    profiles: [
        {
            id: "daliang",
            name: "大凉龙虎传",
            match: "大凉龙虎传",
            enabled: true,
            prompts: [
                { id: "header", label: "页眉", enabled: true, depth: 0, role: "system", text: HEADER },
                { id: "update", label: "落卷", enabled: true, depth: 0, role: "system", text: UPDATE },
            ],
        },
    ],
};

export const clone = (value) => JSON.parse(JSON.stringify(value));

const text = (value, fallback) => (typeof value === "string" ? value : fallback);
const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const whole = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback);

// Settings read from disk may be missing, older or edited by hand: every field gets a value of the right type. Profiles the user made are
// kept as they are; the default profile is only put back when there is no profile at all.
export function normalizeSettings(raw) {
    const base = clone(DEFAULT_SETTINGS);
    if (!raw || typeof raw !== "object") return base;
    const ball = raw.ball && typeof raw.ball === "object" ? raw.ball : {};
    const number = (value) => (Number.isFinite(value) ? value : null);
    const profiles = Array.isArray(raw.profiles) ? raw.profiles : base.profiles;
    return {
        version: 1,
        enabled: flag(raw.enabled, true),
        ball: { show: flag(ball.show, true), x: number(ball.x), y: number(ball.y) },
        tail: { show: flag(raw.tail?.show, true) },
        profiles: profiles
            .filter((profile) => profile && typeof profile === "object")
            .map((profile, index) => ({
                id: text(profile.id, `p${index}`),
                name: text(profile.name, "未命名"),
                match: text(profile.match, ""),
                enabled: flag(profile.enabled, true),
                prompts: (Array.isArray(profile.prompts) ? profile.prompts : [])
                    .filter((prompt) => prompt && typeof prompt === "object")
                    .map((prompt, number) => ({
                        id: text(prompt.id, `q${number}`),
                        label: text(prompt.label, "提示词"),
                        enabled: flag(prompt.enabled, true),
                        depth: whole(prompt.depth, 0),
                        role: prompt.role in ROLES ? prompt.role : "system",
                        text: text(prompt.text, ""),
                    })),
            })),
    };
}

// A match is a part of the character's name, or /regular expression/flags. A broken expression matches nothing.
export function nameMatches(match, name) {
    if (!match || !name) return false;
    const pattern = /^\/(.+)\/([a-z]*)$/.exec(match);
    if (pattern) {
        try {
            return new RegExp(pattern[1], pattern[2]).test(name);
        } catch {
            return false;
        }
    }
    return name.toLowerCase().includes(match.toLowerCase());
}

export const promptKey = (profile, prompt) => `tavern_stack:${profile.id}:${prompt.id}`;

// The prompts to send now: none when the extension is off, the character is unknown (a group chat), or the profile does not match it.
export function activePrompts(settings, characterName) {
    if (!settings.enabled) return [];
    const active = [];
    for (const profile of settings.profiles) {
        if (!profile.enabled || !nameMatches(profile.match, characterName)) continue;
        for (const prompt of profile.prompts) {
            if (prompt.enabled && prompt.text.trim()) active.push({ key: promptKey(profile, prompt), text: prompt.text, depth: prompt.depth, role: ROLES[prompt.role] });
        }
    }
    return active;
}

export const newId = (prefix, taken) => {
    let id;
    do id = `${prefix}${Math.random().toString(36).slice(2, 7)}`;
    while (taken.some((item) => item.id === id));
    return id;
};
