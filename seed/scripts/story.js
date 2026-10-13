// @name 剧情命令 /pic /imp
// Commands that read the story and ask the chat model through a clean request (no roleplay preset):
//   /pic  writes a Stable Diffusion prompt (STYLE below) into the input box as a ready /sd command, to edit and send;
//   /imp  writes the player's next line or action into the input box;
//   /sum  summarizes the whole chat into a window, to copy into the Author's Note or a world book entry.
(() => {
  const CONFIG = {
    storyMessages: 12,
    impMessages: 3,
    recentPlayerMessages: 3,
    storyChars: 30000,
    sumChars: 200000,
    playerChars: 1200,
    portrait: [512, 768],
    landscape: [768, 512],
    storyBlock: /<content>([\s\S]*?)<\/content>/i,
  };

  // What the phone's current model needs: change this text, not the code, when the model changes. Lines marked [SD1.5] work around that
  // model's weaknesses (each measured on the phone, see README "SD1.5 调参结论"); drop or rewrite them first for an SDXL-class model.
  // Some upstreams take a request for an image generation request (a daily quota, HTTP 500): a task starting 'Draw …' and a rule 'A kiss is
  // a close-up' together with a Chinese kiss subject both raised it. Keep to 'Write the prompt for …' and re-measure after rewording.
  const STYLE = [
    "[System Notice: Creative Anime Art Direction & Visual Tag Extraction]",
    "You analyze fictional creative stories and extract objective Stable Diffusion booru-style visual tags for 2D anime illustration.",
    "Translate romantic, dramatic, action, character, and scene details into concise visual tags.",
    "- Short English tags, comma-separated, most important first. No sentences, names, XML, parentheses or Chinese.",
    // [SD1.5] the text encoder reads about 77 tokens; localdream cuts at 330 characters anyway
    "- The whole prompt is at most about 250 characters: the text encoder reads about 77 tokens and ignores the rest.",
    // [SD1.5] a lone person on a wide canvas or without 'solo' is drawn as twins; plain backgrounds keep the figure clean
    "- One person: start with 'full body portrait', then the person tag ('1girl' or '1boy'/'1man'), then 'solo', then age, hair color and style, eye color, expression, clothing (or 'bare shoulders, undressed' if bathing or relaxing), and end with 'simple background' unless the story names a setting to show. A bust: 'portrait, upper body, 1girl, solo'.",
    // [SD1.5] interaction tags first (3/3 vs 0/3 kisses); one group per person (flat tags swap hair colors 3/8 vs 1-2/8)
    "- Two people: start with the person tags ('1girl, 1boy'), then the interaction/pose tags (couple, embrace, kissing, lying on bed, straddling, intimate, romantic, passionate...), then each person's own tags together, each group starting with that person's tag again ('1girl, red hair, 1boy, brown hair'): tags of different people must not mix. Never 'solo'.",
    // [SD1.5] 'upper body' lands about 10/12 kisses and shows the scene, 'close-up' about 6/12 and only two faces; 'from side' halves it
    "- When two faces touch, use 'upper body' (not 'close-up' and never 'from side') and give each person only hair, eyes and basic attire or bare skin: more tags leak onto the other person.",
    "- A background: start with 'scenery', no people: the place type, landscape and weather, time of day and light, two or three signature objects, color palette and mood words.",
    "- Intimate / romantic scenes: describe physical proximity, poses (embrace, on bed, straddling), facial expressions (blush, heavy breathing, parted lips, closed eyes), and skin / attire state (bare skin, undressed, disheveled clothes, cleavage). Do not invent heavy jackets, coats, or armor if the scene is relaxed, bedroom, or intimate.",
    "- First-person POV: start with 'pov, 1girl, looking at viewer', her facial expression, her exact body posture/pose from the latest scene, her attire from the scene, then hair and eye color.",
    // [SD1.5] pets become giant body parts (a lizard on a shoulder drew a lizard tail and a snake body); the same sentence is in TASKS.you/face because this line alone left 2/10
    "- Never write a pet, creature or animal, even when the story puts one on the person: 'lizard on shoulder' is drawn as a giant lizard body and ruins the picture. Leave it out; write only the person, what they wear and what they hold.",
    // [SD1.5] animal words are drawn literally: 'hawk-like eyes' drew a hawk, 'cow print' grew horns and cow ears in 4 of 6 pictures
    "- Name hair color and eye color for every person. No similes or animal words, not even in a pattern ('sharp eyes', not 'hawk-like eyes'; 'black and white spotted', not 'cow print': the model draws the animal).",
    "- Replace fictional place names with what the place looks like ('sea of sand' is 'desert dunes', never 'sea' or 'water'). No synonyms, no repeated tags.",
    "- The first line of your answer is the canvas, 'portrait' (one standing person) or 'landscape' (scenes, backgrounds, couples); the second line is the tags.",
  ].join("\n");

  const NPC = "the non-player character who speaks or acts the most in the latest scene (never the player's character, and not someone who has only just arrived)";

  // [SD1.5] the same rules in STYLE alone were ignored for the character's signature details (pets in 2/10, 'cow print' in 12/12);
  // repeated at the end of the task they were followed (0/24 pets)
  const NO_PETS = " No pets or creatures, and no animal words even in a pattern ('black and white spotted', not 'cow print').";

  const TASKS = {
    me: (player) => `Write the prompt for a full body picture of ${player}, the player's character. Take the looks from the player text if it describes them, otherwise from the story text. Reflect their current appearance and attire.`,
    you: (player, character) => {
      const hint = character && !/[vV]\d|\.png$/i.test(character) && character !== NPC ? ` (${character})` : "";
      return `Write the prompt for a full body picture of the non-player character (NPC)${hint} interacting with ${player} in the story text: identify the NPC from the story text, take their gender, looks, hair, eye color, and attire from the story text. Do NOT draw ${player} (${player} is the player, not the NPC).${NO_PETS}`;
    },
    face: (player, character) => {
      const hint = character && !/[vV]\d|\.png$/i.test(character) && character !== NPC ? ` (${character})` : "";
      return `Write the prompt for a bust portrait of the non-player character (NPC)${hint} interacting with ${player} in the story text: identify the NPC from the story text, take their gender, looks, hair, eye color, and facial expression from the story text. Do NOT draw ${player} (${player} is the player, not the NPC).${NO_PETS}`;
    },
    bg: () => "Write the prompt for a background picture of the setting of the latest scene, with no people, matching its mood.",
    last: (player) =>
      `Write the prompt for one picture of the latest scene in the story text: identify the people present (if ${player} is interacting with another character, always include both characters together as a pair, never solo), their looks, pose/interaction, and state of dress. If the scene is intimate or romantic, faithfully describe their physical proximity, embrace, bare skin, and facial expressions; otherwise describe their setting and attire.`,
    pov: (player) =>
      `Write the prompt for a first-person point-of-view (POV) anime illustration of the female character interacting with ${player} in the latest scene. The camera/viewer IS ${player}. Identify the female character present in the latest scene (her hair color, eyes, facial expression, her pose, body posture, and attire from the story text), and depict HER facing the viewer/camera (1girl, looking at viewer). Do not include any male characters, male appearance, or ${player}'s traits.`,
    free: (player, subject) =>
      `Write the prompt for one clean anime picture of the subject below. In the subject, 'me' means ${player}, the player's character, and 'you' means ${NPC}. The subject is a character's name, a description, or two people: for a name take that character's looks from the story text (earlier parts count too) and ignore everyone else; for a description use it as given. Subject: ${subject}`,
  };

  const isPictureMessage = (message) =>
    (Array.isArray(message.extra?.media) && message.extra.media.length > 0) ||
    Boolean(message.extra?.image) ||
    /sends a picture|!\[.*?\]\(.*?\)/i.test(message.mes ?? "");

  // The story is in CONFIG.storyBlock when the card has one. Otherwise tag blocks are taken for analysis, status panels and variable updates and
  // dropped; when that leaves nothing, the card keeps its story inside a tag of its own, so only the tags are removed.
  function storyText(mes) {
    const tidy = (text) => text.replace(/\n{2,}/g, "\n").trim();
    const block = CONFIG.storyBlock.exec(mes);
    if (block) return tidy(block[1].replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[\w-]+[^>]*>/g, ""));
    const plain = mes.replace(/<!--[\s\S]*?-->/g, "");
    return tidy(plain.replace(/<([\w-]+)\b[^>]*>[\s\S]*?<\/\1>|<[\w-]+\s*\/>/g, "")) || tidy(plain.replace(/<\/?[\w-]+[^>]*>/g, ""));
  }

  function gather(context, messages = CONFIG.storyMessages) {
    const chat = (context.chat ?? []).filter((message) => !message.is_system && !isPictureMessage(message));
    const intro = chat.find((message) => message.is_user)?.mes?.trim().slice(0, CONFIG.playerChars) ?? "";
    const story = chat
      .filter((message) => !message.is_user)
      .slice(-messages)
      .map((message) => storyText(message.mes ?? ""))
      .filter(Boolean)
      .join("\n\n")
      .slice(-CONFIG.storyChars);
    const recent = chat
      .filter((message) => message.is_user)
      .slice(1) // the first one is the intro
      .slice(-CONFIG.recentPlayerMessages)
      .map((message) => (message.mes ?? "").trim().slice(0, CONFIG.playerChars))
      .filter(Boolean);
    const persona = context.powerUserSettings?.persona_description?.trim() ?? "";
    const character = context.name2 || context.characters?.[context.characterId]?.name || "";
    const card = (context.characters?.[context.characterId]?.description ?? "").trim().slice(0, CONFIG.playerChars);
    return { player: context.name1 || "the player", character, intro, recent, story, persona, card };
  }

  // Sentences with either are removed from what the model reads. Only EXPLICIT_TERMS also add the explicit tags: each of its terms appeared
  // only inside explicit scenes in the saved chats. SCRUB_TERMS also appear alone in plain scenes ('鼻尖耸动', a childlike face), where tags
  // for sex would be wrong; they are still kept from the model, which can take them for sexual content.
  const EXPLICIT_TERMS = /(?:做爱|性交|自慰|手淫|抽插|插进|肉棒|阴茎|鸡巴|阴道|小穴|骚穴|肉缝|阴唇|阴蒂|阴阜|内射|高潮|潮吹|射精|精液|淫水|白浆|骚逼|母狗|内裤|底裤|cock|penis|dick|pussy|vagina|cunt|fuck|orgasm|cum|semen|clitoris|anal)/i;
  const SCRUB_TERMS = /(?:稚嫩|耸动|乳头|爱液)/i;
  const SCRUBBED_TERMS = new RegExp(`${EXPLICIT_TERMS.source}|${SCRUB_TERMS.source}`, "i");

  function sanitizeStory(text) {
    if (!text) return "";
    return text
      .split("\n")
      .map((line) =>
        line
          .split(/(?<=[。！？；\n])/)
          .filter((sentence) => !SCRUBBED_TERMS.test(sentence))
          .join("")
      )
      .filter((line) => line.trim().length > 0)
      .join("\n\n");
  }

  const materialSections = (kind, material) => [
    !["you", "face", "pov"].includes(kind) && material.persona && `Player description:\n${material.persona}`,
    material.card && `${material.character ? `${material.character} description` : "Character card description"}:\n${material.card}`,
    !["you", "face", "pov"].includes(kind) && material.intro && `Player text (the player's own intro or character sheet):\n${material.intro}`,
    material.story && `Story text:\n${sanitizeStory(material.story)}`,
  ];

  function buildRequest(kind, subject, material) {
    const target = subject || material.character || "";
    const sections = [...materialSections(kind, material), `Task: ${TASKS[kind](material.player, target)}`];
    return [
      { role: "system", content: STYLE },
      { role: "user", content: sections.filter(Boolean).join("\n\n") },
    ];
  }

  // The roleplay preset made this request copy older player lines (4 of 4 replays): its own rules say to reproduce <user_input>,
  // which holds the previous player turn, and the instruction was 127 characters at the end of 129K.
  const impTask = (player) =>
    `写最新剧情之后接下来发生的1到3句，不超过80字（英文不超过50词）。语言、人称、时态、文风和台词格式都与玩家自己的发言一致（第一条消息也算，除非它是角色档案），还没有发言就与剧情一致。可以是台词、动作或纯叙述，也可以是其他角色的行动。输出里不要带任何标签。必须直接接在最新剧情的结尾之后，不要重复已发生的内容。如果给了草稿，就按草稿的意思扩写成成品，草稿写谁就写谁；没有草稿则写${player}接下来的台词或动作。`;

  // The limits in impTask alone were ignored by a small model (replies of several paragraphs, first person); repeated last they hold.
  const impReminder = (player, hasDraft) =>
    `${hasDraft ? "请按草稿写接下来发生的内容" : `请写${player}接下来的台词或动作`}：只写一段，最多3句话，不超过80字（英文不超过50词），人称和文风与玩家发言一致，不要续写成一整幕。`;

  // The first player message is a character sheet in some chats and the first action in others, so it is labelled as neither. The
  // player's later messages come after the story: the story replies alone never say what the player did last.
  function buildImpRequest(material, draft) {
    const sections = [
      material.persona && `Player description:\n${material.persona}`,
      material.intro && `The player's first message:\n${material.intro}`,
      material.story && `Story text:\n${material.story}`,
      material.recent.length > 0 && `What the player recently said or did (oldest first; already told in the story, do not repeat it):\n${material.recent.join("\n---\n")}`,
      draft && `草稿：${draft}`,
      impReminder(material.player, Boolean(draft)),
    ];
    return [
      { role: "system", content: impTask(material.player) },
      { role: "user", content: sections.filter(Boolean).join("\n\n") },
    ];
  }

  const stripReply = (reply) => reply.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[a-z]*/gi, "");

  // The model's text for the input box, as it wrote it: line breaks, spaces, '|' and '{{' stay, since it is put into the box directly and
  // does not pass the slash parser. Only what is no part of the text is removed (thinking, code fences, the blank ends).
  const impText = (reply) => stripReply(reply).replace(/\r\n?/g, "\n").trim();

  // [SD1.5] The canvas is fixed for single-subject kinds (the model picked a wide one for a lone character in 5 of 8 runs, which draws twins);
  // for last/free the model's first line decides. Only what the slash parser acts on ('|' and '{{') is removed from the prompt.
  const FIXED_CANVAS = { me: "portrait", you: "portrait", face: "portrait", bg: "landscape", pov: "portrait" };

  function parseReply(kind, reply) {
    const lines = stripReply(reply).split("\n").map((l) => l.trim()).filter(Boolean);
    // 'Canvas: portrait, tags…' on one line is how some models answer; a bare 'portrait, upper body…' is a tag list, not a canvas line.
    const labelled = /^canvas\s*:\s*(portrait|landscape)\b[\s,.:]*/i.exec(lines[0] ?? "");
    if (labelled) lines.splice(0, 1, labelled[1], ...[lines[0].slice(labelled[0].length)].filter(Boolean));
    const canvasOf = (line) => {
      const word = line?.toLowerCase().replace(/[^a-z]/g, "");
      return word === "portrait" || word === "landscape" ? word : undefined;
    };
    const clean = (list) => list.join(", ").replace(/^(tags|prompt)\s*:/i, "").replace(/[|{}]+/g, " ").replace(/\s+/g, " ").trim();
    let given = canvasOf(lines[0]);
    let prompt = clean(given ? lines.slice(1) : lines);
    if (!isTagList(prompt)) {
      // Some replies decline the scene and then give a milder tag list anyway ('I cannot… Alternative Prompt: landscape / 1girl, …'): take that line.
      const at = lines.findIndex(isTagLine);
      if (at >= 0) {
        prompt = clean([lines[at]]);
        given = canvasOf(lines[at - 1]);
      }
    }
    return { canvas: FIXED_CANVAS[kind] ?? given ?? "landscape", prompt };
  }

  // Without a reasoning channel a small model sometimes writes its analysis instead of tags (about 1 in 5 for /pic you, 2824 characters
  // of 'Let me analyze…' went to the phone once). Tags are short; prose is not.
  const isTagLine = (line) => {
    const cleaned = line.trim().replace(/[.;]+$/, "");
    return cleaned.split(",").length >= 5 && !/\*\*|[!?:]$/.test(cleaned) && isTagList(cleaned);
  };
  const isTagList = (prompt) => prompt.length > 0 && prompt.length <= 1500 && prompt.split(",").every((tag) => tag.trim().length <= 80);

  function parseInput(input) {
    const text = input.trim();
    const forceNsfw = /\bnsfw\b/i.test(text);
    const rest = text.replace(/\bnsfw\b/gi, "").trim();
    const kind = (rest || "last").toLowerCase();
    return ["me", "you", "face", "bg", "last", "pov"].includes(kind) ? { kind, subject: "", forceNsfw } : { kind: "free", subject: rest, forceNsfw };
  }

  const MALE_TERMS = /\b(1boy|1man|2boys|male|men)\b/i;

  function stripMale(prompt) {
    return prompt
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag && !MALE_TERMS.test(tag))
      .join(", ");
  }

  const NSFW_BASE = "nsfw, uncensored, explicit, sex, intercourse, making love, intimate, passionate, heavy breathing, flushed face, blush, parted lips, saliva, sweat, bare skin, cleavage, bare breasts, nipples, areolae, pussy, penis";

  // Asks the model for tags; null (after a toast) when there is nothing to draw or the model failed.
  function createCompose({ context, generateRaw, toastr }) {
    return async function compose(input, usage) {
      if (!input.trim()) {
        toastr.info(`${usage} me | you | face | bg | last | pov | <名字、描述或场景>`);
        return null;
      }
      const { kind, subject, forceNsfw } = parseInput(input);
      const material = gather(context());
      if (!material.story && !material.intro) {
        toastr.warning("聊天里还没有剧情可画");
        return null;
      }
      try {
        toastr.info("正在写提示词…");
        let reply;
        let parsed;
        for (let attempt = 0; attempt < 2 && !(parsed && isTagList(parsed.prompt)); attempt += 1) {
          const reqMaterial = attempt === 1 && !reply?.trim() ? { ...material, story: kind === "me" ? "" : (material.recent.join("\n") || "") } : material;
          reply = String(await generateRaw({ ordered_prompts: buildRequest(kind, subject, reqMaterial), should_silence: true }));
          parsed = parseReply(kind, reply);
        }
        if (!isTagList(parsed.prompt)) throw new Error(reply.trim() ? `模型没有按格式返回标签: ${reply.slice(0, 80)}` : "模型返回了空内容");
        let prompt = parsed.prompt;
        // The story is checked before sanitizeStory removes those sentences from the model's request: the model never sees them, so the tags come from here.
        const isIntimate = forceNsfw || EXPLICIT_TERMS.test(material.story || "");
        if (kind === "pov") {
          const cleanPrompt = stripMale(prompt)
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t && !/^(1girl|looking at viewer|eye contact|pov|pov hands)$/i.test(t))
            .join(", ");
          prompt = isIntimate
            ? `pov, looking at viewer, eye contact, pov hands, 1girl, ${NSFW_BASE}, ${cleanPrompt}`
            : `pov, looking at viewer, 1girl, ${cleanPrompt}`;
        } else if (isIntimate && (kind === "last" || kind === "free" || forceNsfw)) {
          prompt = `${NSFW_BASE}, ${prompt}`;
        }
        return { kind, canvas: parsed.canvas, prompt };
      } catch (error) {
        console.error("[pic]", error);
        toastr.error(`画图失败: ${error?.message ?? error}`);
        return null;
      }
    };
  }

  // The model's tags are not drawn but put into the box as a ready /sd command: the user edits them and presses Enter.
  function createPic({ setInput, focusInput = () => {}, toastr, ...deps }) {
    const compose = createCompose({ toastr, ...deps });
    return async function pic(input) {
      const result = await compose(input, "/pic");
      if (!result) return;
      const [width, height] = CONFIG[result.canvas];
      console.info("[pic]", result.kind, `${width}x${height}`, result.prompt);
      setInput(`/sd extend=false width=${width} height=${height} ${result.prompt}`);
      focusInput();
      toastr.info("标签已放进输入框，改完回车出图");
    };
  }

  // setInput only fills the box; after a mouse click on the button the focus is elsewhere, so Enter would not send: focusInput moves it.
  // Asked again while the box still holds the previous result (unedited), it is no draft: the original draft is used again, a reroll.
  function createImp({ context, generateRaw, toastr, setInput, focusInput = () => {} }) {
    let last = null;
    return async function imp(input) {
      const draft = last && input.trim() === last.text ? last.draft : input.trim();
      const material = gather(context(), CONFIG.impMessages);
      if (!material.story) {
        toastr.warning("聊天里还没有剧情可接");
        return;
      }
      try {
        toastr.info("正在写下一步…");
        const reply = String(await generateRaw({ ordered_prompts: buildImpRequest(material, draft), should_silence: true }));
        const text = impText(reply);
        if (!text) throw new Error(`模型没有返回内容: ${reply.slice(0, 80)}`);
        await setInput(text);
        last = { draft, text };
        focusInput();
      } catch (error) {
        console.error("[imp]", error);
        toastr.error(`代写失败: ${error?.message ?? error}`);
      }
    };
  }

  // A summary needs what the player did as much as the replies, so this is the whole chat in order, the newest part when it is too long.
  function transcript(context) {
    const parts = [];
    for (const message of (context.chat ?? []).filter((m) => !m.is_system && !isPictureMessage(m))) {
      const text = message.is_user ? (message.mes ?? "").trim() : storyText(message.mes ?? "");
      if (text) parts.push(`${message.is_user ? "Player" : "Story"}:\n${text}`);
    }
    return parts.join("\n\n").slice(-CONFIG.sumChars);
  }

  const SUM_TASK =
    // In Chinese this was answered in Chinese for an English chat (the language of the instruction won), hence English with the rule spelled out.
    "Summarize the chat below (lines starting with Player are the player's messages, lines starting with Story are the story) into a long-term memory for continuing the story later. " +
    "Write it in the language the chat itself is written in, not in the language of these instructions, and name the characters and the player the way the story does. " +
    "About 500 to 800 Chinese characters or 350 to 550 English words; only facts that have happened, no commentary. " +
    "Sections, with their headings translated into that language: timeline (with times and places), how relationships progressed, foreshadowing that has been revealed, unresolved conflicts and suspense, the player's current situation. " +
    "If the first Player message is a character sheet, take it as background, not as something that happened. No tags or code blocks.";

  // Shown above the text box of the /sum window. The Author's Note belongs to the chat it is written in and is sent with every request,
  // wherever the preset puts its own prompts, so it is the least invasive place; a world book entry would be a second option.
  const SUM_GUIDE =
    '<div style="text-align:left"><b>长期记忆</b>：点下面的“复制”，然后放进这个聊天的作者注释：' +
    "<ol><li>输入框左边的三横菜单（☰） → <b>作者注释</b></li>" +
    "<li>粘贴进文本框；下面保持“聊天的特定深度 4，作为系统”和“插入频率 1”（默认就是这样，不一样就改成这样）</li>" +
    "<li>作者注释只对当前聊天生效；以后再总结，用新的整段覆盖</li></ol>" +
    "旧楼层想隐藏：输入 <code>/hide 2-N</code>（N 是要隐藏到第几条；开头的开局器和角色档案别隐藏）。</div>";

  // Own read-only box instead of the popup's input type: that one grabs the focus and the caret, which scrolled the text to its end, and
  // its large size left a gap between the instructions and the text. The copy button is a custom button of the popup, next to 关闭.
  const SUM_TEXT_ID = "st-sum-text";
  const sumPopupHtml = (text) =>
    `${SUM_GUIDE}<textarea readonly id="${SUM_TEXT_ID}" rows="20" class="text_pole" style="width:100%;box-sizing:border-box;margin-top:10px">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>`;

  // The text goes to a window to read and copy (into the Author's Note or a world book entry), not into the input box.
  function createSum({ context, generateRaw, toastr, show }) {
    return async function sum() {
      const chat = transcript(context());
      if (!chat) {
        toastr.warning("聊天里还没有内容可总结");
        return;
      }
      try {
        toastr.info("正在总结，内容多时要等一会儿…");
        const reply = stripReply(String(await generateRaw({ ordered_prompts: [{ role: "system", content: SUM_TASK }, { role: "user", content: chat }], should_silence: true }))).trim();
        if (!reply) throw new Error("模型返回了空内容");
        await show(reply);
      } catch (error) {
        console.error("[sum]", error);
        toastr.error(`总结失败: ${error?.message ?? error}`);
      }
    };
  }

  // A small menu above the quick reply button that opened it, in the theme's own colours. Resolves with the index of the chosen item, or
  // null when the user clicks anywhere else or presses Escape.
  function chooseFromMenu(page, anchor, texts) {
    return new Promise((resolve) => {
      const menu = page.createElement("div");
      Object.assign(menu.style, {
        position: "fixed",
        zIndex: "9999",
        padding: "6px",
        borderRadius: "10px",
        background: "var(--SmartThemeBlurTintColor)",
        color: "var(--SmartThemeBodyColor)",
        border: "1px solid var(--SmartThemeBorderColor)",
        boxShadow: "0 4px 16px var(--SmartThemeShadowColor)",
      });
      const outside = (event) => {
        if (!menu.contains(event.target)) close(null);
      };
      const escape = (event) => {
        if (event.key === "Escape") close(null);
      };
      const close = (index) => {
        page.removeEventListener("pointerdown", outside, true);
        page.removeEventListener("keydown", escape, true);
        menu.remove();
        resolve(index);
      };
      texts.forEach((text, index) => {
        const item = page.createElement("div");
        item.textContent = text;
        Object.assign(item.style, { padding: "8px 16px", cursor: "pointer", whiteSpace: "nowrap", borderRadius: "6px" });
        item.addEventListener("pointerenter", () => (item.style.background = "rgba(128,128,128,0.25)"));
        item.addEventListener("pointerleave", () => (item.style.background = ""));
        item.addEventListener("click", () => close(index));
        menu.append(item);
      });
      page.body.append(menu);
      const view = page.defaultView;
      const box = anchor?.getBoundingClientRect();
      // By left/top and a translate, not by bottom: SillyTavern's style.css puts a transform on <html>, which makes <html> the containing
      // block of fixed elements, and on the phone bottom/right then landed off screen (see page.js).
      menu.style.left = `${Math.max(8, Math.min(box?.left ?? 8, view.innerWidth - menu.getBoundingClientRect().width - 8))}px`;
      menu.style.top = `${(box?.top ?? view.innerHeight / 2) - 6}px`;
      menu.style.transform = "translateY(-100%)";
      page.addEventListener("pointerdown", outside, true);
      page.addEventListener("keydown", escape, true);
    });
  }

  // One quick reply for everything not used every turn: a menu of choices, each running a command.
  function createMore({ items, choose }) {
    return async function more() {
      const index = await choose(items.map((item) => item.text));
      if (index !== null && items[index]) await items[index].run();
    };
  }

  // What the 更多 menu offers. The picture items are left out where there is nothing to draw with: the seed's settings.story.pictures is false.
  const moreItems = ({ pictures, pic, sum, inputText }) => [
    ...(pictures
      ? [
          { text: "画此刻", run: () => pic("last") },
          { text: "画第一人称(POV)", run: () => pic("pov") },
          { text: "画我", run: () => pic("me") },
          { text: "画NPC", run: () => pic("you") },
          { text: "画特写", run: () => pic("face") },
          { text: "画景", run: () => pic("bg") },
          { text: "画输入框里的…", run: () => pic(inputText()) },
        ]
      : []),
    { text: "总结", run: () => sum() },
  ];

  const api = { CONFIG, STYLE, NSFW_BASE, storyText, gather, transcript, sumPopupHtml, buildRequest, buildImpRequest, impText, parseReply, parseInput, stripMale, sanitizeStory, createPic, createImp, createSum, createMore, moreItems };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  const runtime = { context: () => SillyTavern.getContext(), generateRaw, toastr };
  const page = window.parent.document;
  // `argument` says what the one optional text after the command is, for the autocomplete and /help. (Not the context's
  // registerSlashCommand: SillyTavern marks it deprecated in favour of SlashCommandParser.addCommandObject.)
  const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = SillyTavern.getContext();
  const register = (name, help, run, argument) =>
    SlashCommandParser.addCommandObject(
      SlashCommand.fromProps({
        name,
        helpString: help,
        unnamedArgumentList: argument ? [SlashCommandArgument.fromProps({ description: argument, typeList: [ARGUMENT_TYPE.STRING] })] : [],
        callback: async (_named, text) => {
          await run(String(text ?? ""));
          return "";
        },
      }),
    );

  // Assigned, and an input event for SillyTavern to notice (its counters and draft saving listen to it).
  const inputBox = {
    setInput: (text) => {
      const box = page.getElementById("send_textarea");
      box.value = text;
      box.dispatchEvent(new page.defaultView.Event("input", { bubbles: true }));
    },
    focusInput: () => {
      const box = page.getElementById("send_textarea");
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    },
  };
  const imp = createImp({ ...runtime, ...inputBox });
  // Runs inside the click of the popup's button, which a copy needs. Selecting the text box and copying also works where the clipboard API
  // does not exist (a page opened as http://192.168… on the phone).
  function copyText() {
    try {
      page.getElementById(SUM_TEXT_ID).select();
      if (!page.execCommand("copy")) throw new Error("浏览器拒绝了复制");
      toastr.success("已复制");
    } catch (error) {
      toastr.error(`复制失败，请在文本框里全选复制: ${error?.message ?? error}`);
    }
  }
  const sum = createSum({
    ...runtime,
    show: (text) => {
      const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
      // A custom button without a result does not close the popup.
      return callGenericPopup(sumPopupHtml(text), POPUP_TYPE.TEXT, "", {
        wide: true,
        okButton: "关闭",
        allowVerticalScrolling: true,
        customButtons: [{ text: "复制", appendAtEnd: true, action: copyText }],
      });
    },
  });
  const pic = createPic({ ...runtime, ...inputBox });
  const more = createMore({
    items: moreItems({
      pictures: SillyTavern.getContext().extensionSettings?.story?.pictures !== false,
      pic,
      sum,
      inputText: () => page.getElementById("send_textarea")?.value ?? "",
    }),
    choose: (texts) => {
      // The menu opens above the 更多 button. The quick replies are known by their ids in seed/QuickReplies/quick-replies.json (3 is 更多);
      // a button on the page carries only its label, which is looked up from the id.
      const label = window.parent.quickReplyApi?.getQrByLabel("quick-replies", 3)?.label;
      const anchor = [...page.querySelectorAll(".qr--button-label")].find((element) => element.textContent.trim() === label)?.closest(".qr--button");
      return chooseFromMenu(page, anchor, texts);
    },
  });
  register("imp", "代写：按最新剧情写接下来发生的内容（默认是主角的台词或动作），放进输入框，不自动发送；输入框里是上次的结果时重抽", imp, "草稿（可以不写；草稿写谁就写谁，可以是 NPC）");
  register("sum", "总结：把整个聊天总结成一份长期记忆，显示在弹窗里，方便复制", sum);
  register("pic", "画图：让模型写 SD 标签，作为 /sd 命令放进输入框，不自动出图；改完回车出图", pic, "me | you | face | bg | last | pov，或者名字、描述、“A和B热吻”");
  register("more", "更多：弹出菜单：画此刻、画第一人称(POV)、画我、画NPC、画特写、画景、画输入框里的内容、总结", more);
})();
