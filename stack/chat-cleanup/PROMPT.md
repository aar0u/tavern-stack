# Task: clean a SillyTavern chat history after switching presets

Paste this file into a new Claude Code session, then tell it the chat file name. Everything it needs is below.

## Context

The user keeps one character card whose story is still going, but changes the preset (preset stops being updated, or they are comparing presets). Each preset leaves its own artifacts inside the saved messages: thinking blocks, commentary, page headers, status panels, option blocks, memo cards, floor counters. The new preset has no regex that renders them, so they show as plain text, and they stay in the prompt history where the model imitates them.

Goal: write a cleaned copy of the chat `.jsonl` that keeps the story text and the card's own data, so the user can re-import it and continue under the new preset.

Reference case: a card with MVU variables and its own tavern_helper scripts, and a 74-line chat that mixed the output of three presets. AI text went from 162,246 to 74,166 characters and every check passed. The same chat was later continued under a fourth preset and cleaned a second time.

## Files

- `clean_chat.py` in this folder. Python stdlib only. Run it with `python3 -I`.
  - `inventory <chat.jsonl> [--keep t1,t2]`: lists tags/markers per message range, models per range, metadata keys.
  - `clean <in> <out> [options]`: writes the cleaned copy, `<out>.report.txt`, and `<out>.options.json` (what was used; `verify` reads it).
    - `--add-blocks a,b,c`: tags to remove in addition to the built-in list. Use this for a new preset's tags.
    - `--blocks a,b,c`: tags to remove, replacing the built-in list entirely (the tags of three presets). Only when a built-in tag is card data.
    - `--drop-empty-tail`: drop the empty AI messages at the end (a failed generation leaves one); `verify` accounts for them.
    - `--keep t1,t2`: extra tags that are card data. Added to the MVU defaults. A tag in both lists is refused.
    - `--disable-rules floor_marker,header_line,comments,unwrap_content,collapse_repeat`: turn off text rules; the first four are tied to specific presets. Turning off `unwrap_content` keeps `<content>` and adds it to the keep list automatically.
    - `--drop-keys k1,k2`: chat_metadata / extra keys to delete, `*` matches any run of characters (default `izumiWorldNext`).
    - `--no-drop-extension-state`: keep other extensions' state in `chat_metadata`. By default `LWB_*`, `storyOracle_*` and `extensions` are deleted.
  - `verify <in> <out> [--keep ...]`: exit code 1 if any check fails.
  - `--self-test`: the script's own checks; run it after changing the script.
- The chat file is wherever the user says (usually a scratch directory outside the repository).

## Rules

1. Never modify the input file. Always write a new file next to it, named `<card> - cleaned.jsonl`.
2. The chat and its cleaned copy hold the user's story: keep them outside this repository, never commit them, and never paste their text into a report beyond a few words to name a row.
3. Keep, byte for byte: user messages, every `<UpdateVariable>` block (with `Analysis` and `JSONPatch`), `<StatusPlaceHolderImpl/>`, the per-message `variables` field (MVU state per floor), `swipes`, `chat_metadata.variables`, `is_ejs_processed`, and the card greeting trigger (in the reference card it is the card's title in brackets plus the placeholder in the first AI message).
4. Remove: thinking and planning blocks, commentary blocks, page headers, status or beautifier panels (`<details>` stacks), option blocks, memo and scene cards, completion seals, floor counters like `（第N楼）`, a leading `『…』` header line, HTML comments, horizontal rules (`---`, `***`, `___`) left next to removed blocks, a reply the model wrote twice (keep the first copy), and the `<content>` wrapper (unwrap it, keep the text inside).
5. Delete preset-private keys: `chat_metadata.izumiWorldNext` and `extra.izumiWorldNext` by default; add others with `--drop-keys` after looking at the inventory.
6. Other extensions' state in `chat_metadata` (`LWB_*`, `storyOracle_*`, `extensions`) is deleted by default: the user wants only the chat. `LWB_SNAP` alone can be half the file (a full copy of the variables per floor). The card's own `variables` and `integrity` stay. Leave `extra.reasoning` and the rest of `extra` alone, and say so in the report so the user can decide.

## Procedure

1. Run `inventory`. Read it as eras: the models/dates list shows where a preset changed, the tag table shows which preset left what.
2. Decide the block list. The default list covers three presets. For any other preset, add its tags with `--add-blocks` (they run after the defaults). Pass `--blocks` only to replace the defaults, which also drops every built-in tag you do not repeat. Tags that only appear nested inside a block you remove (for example `time` and `location` inside `header`) need no action.
3. If a tag is unfamiliar and could be card data, check the card first (its regex scripts, world book, tavern_helper scripts) before deleting. Ask the user only in that case.
4. Run `clean`, then `verify`. Do not report success unless `verify` prints `OK`.
5. Eyeball three messages from different eras (head and tail) and the greeting row. Check that the story text starts at the story, not at a separator or marker.
6. Report to the user in Chinese: output path, characters before and after, what was removed per era, what was kept, what was left alone (item 6 above), and the import steps below.

## Pitfalls found in the reference run

- Tag names can end with a non-word character (`konatan_planning~`). `\b` after the tag name then fails and the block silently survives. The script uses `(?=[\s>])`. `verify` catches this as leftover tags.
- Prefill: the opening tag may have been sent as an assistant prefill, so only `</erii_draft>` is in the text. The script drops everything from the start through the closing tag.
- Truncated output leaves an unclosed `<options>`. The script removes it up to `<UpdateVariable>` or the placeholder.
- A stray `<options>` can sit inside a planning block. Remove the planning block first (the default order does).
- Floor counters can be prepended to the card greeting (`（第0楼）`). Remove the counter, keep the greeting trigger.
- `swipes[swipe_id]` must equal `mes` after cleaning. The script syncs it.
- JSON must stay one object per line. The script writes with `ensure_ascii=False`.
- The input may already have been cleaned once. Then `inventory` shows only the newer preset's leftovers (a header line, an option block, a card-extension tag); do not be surprised that the default list finds almost nothing.
- Presets put a horizontal rule before their option blocks. Removing the block leaves it at the end of the story. The script strips `---`, `***` and `___` at the start and at the end of the story text, and `verify` fails on one that is left.
- A failed or cancelled generation leaves an AI message with empty text at the end. Pass `--drop-empty-tail`, or the import brings an empty message into the new chat.
- Some models write the whole reply twice (story, update block, the same story, update block). Cleaning keeps the first copy (rule `collapse_repeat`, on by default). `verify` fails on a message that still has two update blocks: it was not a plain repeat, so read it before deciding.
- `--blocks` replaces the whole built-in list. Passing only the new tags with it silently turns the defaults off; use `--add-blocks`.

## Import (tell the user)

SillyTavern: open the character, open chat management, import the cleaned `.jsonl`. It appears as a new chat; the old one is untouched. Send one message under the new preset and check that the first reply has no leftover blocks. If the card renders HTML panels from code blocks, make sure only one renderer is on (the card's own helper script, with any other extension's rendering off), or panels render twice.

## Using it with a different card or different presets

The engine is generic. The defaults are not: they were written for one card and three presets. Do this first when the card or the presets are new:

1. Run `inventory`. Do not run `clean` with the defaults before you have read it.
2. Find what the card itself relies on: its regex scripts (find patterns and the tags in their replacements), world book entries that tell the model to output a tag, and its tavern_helper scripts. Any tag it renders, parses, or stores state in goes into `--keep`.
3. Generic names are the risk: `details`, `header`, `history`, `choices`, `content`, and HTML comments are preset leftovers in the reference case but can be card data elsewhere. If the card uses one, pass your own `--blocks` list without it and add it to `--keep`; if comments or the `<content>` wrapper are the card's, use `--disable-rules`.
4. The text rules `floor_marker` (`（第N楼）`) and `header_line` (a leading `『…』` line) come from two of the three presets. Turn them off if the card does not produce them.
5. Cards without MVU: the `UpdateVariable` and `StatusPlaceHolderImpl` defaults simply never match, which is harmless; the narrative/tail split then treats the whole message as story text.
6. For a tag you cannot classify, ask the user. Do not guess a deletion.

Verified so far: the defaults on the reference chat; one alternate configuration on the same chat (one preset's panels, comments, and the `<content>` wrapper treated as card data); and a second pass over the already cleaned chat with `--add-blocks` and `--drop-empty-tail`, which gave the same result as the first pass plus manual fixes. No second card has been tried.
