#!/usr/bin/env python3
"""Strip artifacts that other presets left in a SillyTavern chat .jsonl, keeping story text and the card's own MVU data.

Stdlib only. Run with `python3 -I clean_chat.py <command> ...`:
  inventory <chat.jsonl>             list the tags/markers found, per message range
  clean <in.jsonl> <out.jsonl>       write a cleaned copy (the input is never modified)
  verify <in.jsonl> <out.jsonl>      check the cleaned copy; exit code 1 if any check fails
  --self-test                        run the built-in checks
"""
import argparse
import collections
import fnmatch
import json
import re
import sys

# Order matters: wrappers and thinking blocks go first so stray tags inside them are removed with them.
DEFAULT_BLOCKS = ['Chain_of_Thought', 'konatan_planning~', 'erii_draft', 'parade', 'tucao', 'header',
                  'IzumiEdit', 'head1', 'details', 'erii_memo', 'scene_card', 'disclaimer', 'options',
                  'choices', 'history']
# Belong to the card (MVU variable update + status bar placeholder); never remove. Extend with --keep for other cards.
DEFAULT_KEEP = ['UpdateVariable', 'Analysis', 'JSONPatch', 'StatusPlaceHolderImpl']
DEFAULT_DROP_KEYS = ['izumiWorldNext']
# Other extensions' own state in chat_metadata (removed unless --no-drop-extension-state): LittleWhiteBox keeps a full copy of the variables for every floor
# (tens of MB in a long chat), Story Oracle its beat plan. The card's own variables are in `variables`, which stays.
EXTENSION_STATE_KEYS = ['LWB_*', 'storyOracle_*', 'extensions']
TAIL_START = re.compile(r'<UpdateVariable>|<StatusPlaceHolderImpl\s*/>')
# A markdown horizontal rule. Presets put one before their option blocks, so removing the block leaves it at the end of the story.
RULE = r'(?:-{3,}|\*{3,}|_{3,})'
# Switchable text rules; the first three are tied to specific presets and can be wrong for other cards.
RULES = ['floor_marker', 'header_line', 'comments', 'unwrap_content', 'collapse_repeat']


def load(path):
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def is_ai(row):
    return 'mes' in row and not row.get('is_user')


def collapse_repeat(text):
    """A reply the model wrote twice: story, update block, the same story again, update block. Keep the first copy and the final placeholder.
    Only when the second story starts like the first; two blocks that are not a repeat are left alone (verify reports them)."""
    open_tag, close_tag = '<UpdateVariable>', '</UpdateVariable>'
    first_open = text.find(open_tag)
    first_end = text.find(close_tag) + len(close_tag)
    second_open = text.find(open_tag, first_end) if first_open != -1 else -1
    if second_open == -1:
        return text, 0
    story, again = text[:first_open].strip(), text[first_end:second_open].strip()
    if not story or again[:40] != story[:40]:
        return text, 0
    placeholder = text.rfind('<StatusPlaceHolderImpl')
    return text[:first_end] + ('\n\n' + text[placeholder:] if placeholder > first_end else ''), 1


def clean_text(text, blocks, rules=RULES):
    removed = []
    # Prefill case: the opening tag was sent as an assistant prefill, so only the closing tag is in the text.
    for tag in blocks:
        close = f'</{tag}>'
        ci = text.find(close)
        if ci != -1 and (text.find(f'<{tag}') == -1 or text.find(f'<{tag}') > ci):
            text = text[ci + len(close):]
            removed.append(tag + '(prefill)')
    for tag in blocks:
        # (?=[\s>]) instead of \b: tag names such as konatan_planning~ end in a non-word character.
        pat = re.compile(rf'<{re.escape(tag)}(?=[\s>])[^>]*>[\s\S]*?</{re.escape(tag)}>')
        n = len(pat.findall(text))
        if n:
            text = pat.sub('', text)
            removed.append(f'{tag}x{n}')
    if 'floor_marker' in rules:
        text, k = re.subn(r'^[ \t]*[（(]第\d+楼[）)][ \t]*\n?', '', text, flags=re.M)
        if k:
            removed.append(f'floor-marker x{k}')
    if 'header_line' in rules:
        text, k = re.subn(r'\A\s*『[^』\n]*』[ \t]*\n?', '', text)
        if k:
            removed.append('header-line')
    # An output cut off mid-block leaves an unclosed <options>; drop it up to the card's own tail.
    text, k = re.subn(r'<options>[\s\S]*?(?=<UpdateVariable>|<StatusPlaceHolderImpl|\Z)', '', text)
    if k:
        removed.append(f'unclosed-options x{k}')
    if 'comments' in rules:
        text, k = re.subn(r'<!--[\s\S]*?-->', '', text)
        if k:
            removed.append(f'comment x{k}')
    if 'unwrap_content' in rules:
        text, k = re.subn(r'</?content>', '', text)
        if k:
            removed.append(f'content-unwrap x{k}')
    if 'collapse_repeat' in rules:
        text, k = collapse_repeat(text)
        if k:
            removed.append('repeated-reply')
    m = TAIL_START.search(text)
    head, tail = (text[:m.start()], text[m.start():]) if m else (text, '')
    head = re.sub(rf'^\s*(?:{RULE}\s*)+', '', head)
    head = re.sub(rf'(?:\s*{RULE})+\s*$', '', head)
    head = re.sub(r'\n{3,}', '\n\n', head).strip()
    tail = tail.strip()
    return ((head + '\n\n' + tail).strip() if head else tail), removed


def csv(value):
    return [x for x in (value or '').split(',') if x]


def merge_blocks(blocks, add):
    return list(dict.fromkeys((csv(blocks) or DEFAULT_BLOCKS) + csv(add)))


def key_matches(key, patterns):
    return any(fnmatch.fnmatchcase(key, p) for p in patterns)


def cmd_inventory(args):
    KEEP = set(DEFAULT_KEEP) | set(csv(args.keep))
    rows = load(args.src)
    meta = rows[0].get('chat_metadata', {})
    print('chat_metadata keys (chars):')
    for k, v in meta.items():
        print(f'  {k:34} {len(json.dumps(v, ensure_ascii=False)):8}')
    tags = collections.defaultdict(list)
    extras = collections.Counter()
    for i, r in enumerate(rows):
        if not is_ai(r):
            continue
        for k in (r.get('extra') or {}):
            extras[k] += 1
        for tag in set(re.findall(r'</?([^\s<>/!]+)', r['mes'])):
            tags[tag].append(i)
        if re.search(r'^[（(]第\d+楼[）)]', r['mes'], re.M):
            tags['<floor-marker>'].append(i)
        if re.search(r'^『', r['mes'], re.M):
            tags['<header-line>'].append(i)
        if re.search(r'<!--', r['mes']):
            tags['<html-comment>'].append(i)
    print('\ntags in AI messages (n = messages, rows first..last)  [* = kept]')
    for k, v in sorted(tags.items(), key=lambda kv: -len(kv[1])):
        print(f'  {k[:34]:36} n={len(v):3} rows {v[0]}..{v[-1]} {"*" if k in KEEP else ""}')
    print('\nmodels / dates by row (to tell which preset produced which range):')
    last = None
    for i, r in enumerate(rows):
        if is_ai(r):
            key = (r.get('extra') or {}).get('model')
            if key != last:
                print(f'  row {i:3} {r.get("send_date", "")[:16]} model={key}')
                last = key
    print('\nextra keys on AI messages:', dict(extras))
    unknown = [t for t in tags if t not in KEEP and t not in DEFAULT_BLOCKS and not t.startswith('<')]
    print('\ntags NOT in the default block list (decide for each: --add-blocks to remove, --keep if card data):', unknown)


def cmd_clean(args):
    rows = load(args.src)
    blocks = merge_blocks(args.blocks, args.add_blocks)
    drop = csv(args.drop_keys) or DEFAULT_DROP_KEYS
    if args.drop_extension_state:
        drop = list(dict.fromkeys(drop + EXTENSION_STATE_KEYS))
    keep = sorted(set(DEFAULT_KEEP) | set(csv(args.keep)))
    rules = [r for r in RULES if r not in csv(args.disable_rules)]
    if 'unwrap_content' not in rules and 'content' not in keep:
        keep = sorted(set(keep) | {'content'})  # the wrapper stays, so verify must accept it
    clash = set(blocks) & set(keep)
    if clash:
        sys.exit(f'refusing: {sorted(clash)} are in both the block list and the keep list')
    report = []
    meta = rows[0].get('chat_metadata', {})
    for key in [k for k in meta if key_matches(k, drop)]:
        size = len(json.dumps(meta.pop(key), ensure_ascii=False))
        report.append(f'chat_metadata.{key} removed ({size} chars)')
    dropped = 0
    while args.drop_empty_tail and len(rows) > 1 and is_ai(rows[-1]) and not rows[-1]['mes'].strip():
        rows.pop()
        dropped += 1
    if dropped:
        report.append(f'{dropped} empty AI message(s) at the end dropped')
    for i, r in enumerate(rows):
        if not is_ai(r):
            continue
        before = r['mes']
        after, removed = clean_text(before, blocks, rules)
        r['mes'] = after
        if r.get('swipes'):
            r['swipes'][r.get('swipe_id', 0)] = after
        for key in [k for k in (r.get('extra') or {}) if key_matches(k, drop)]:
            r['extra'].pop(key)
            removed.append(f'extra.{key}')
        report.append(f'{i} | {len(before)} -> {len(after)} | {", ".join(removed)}')
    with open(args.dst, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    with open(args.dst + '.report.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(report) + '\n')
    # verify reads this so the keep list and rules used by clean are checked, not the defaults
    with open(args.dst + '.options.json', 'w', encoding='utf-8') as f:
        json.dump({'keep': keep, 'blocks': blocks, 'rules': rules, 'drop_keys': drop, 'dropped_tail': dropped}, f, ensure_ascii=False)
    print(f'written {args.dst} ({len(rows)} lines), {args.dst}.report.txt and {args.dst}.options.json')


def narrative(text):
    m = TAIL_START.search(text)
    return (text[:m.start()] if m else text).strip()


def cmd_verify(args):
    a, b = load(args.src), load(args.dst)
    try:
        with open(args.dst + '.options.json', encoding='utf-8') as f:
            used = json.load(f)
    except FileNotFoundError:
        used = {'keep': DEFAULT_KEEP, 'rules': RULES}
    KEEP = set(used['keep']) | set(csv(args.keep))
    check_comments = 'comments' in used['rules']
    problems = []
    for key in b[0].get('chat_metadata', {}):
        if key_matches(key, used.get('drop_keys', [])):
            problems.append(f'chat_metadata.{key} should have been removed')
    dropped = used.get('dropped_tail', 0)
    if len(a) - dropped != len(b):
        problems.append(f'line count {len(a)} - {dropped} dropped != {len(b)}')
    update = re.compile(r'<UpdateVariable>[\s\S]*?</UpdateVariable>')
    for i, (x, y) in enumerate(zip(a, b)):
        if i == 0:
            for k in ('user_name', 'character_name'):
                if x.get(k) != y.get(k):
                    problems.append(f'line 0 {k} changed')
            continue
        if 'mes' not in x:
            continue
        if x.get('is_user'):
            if x['mes'] != y['mes']:
                problems.append(f'row {i}: user message changed')
            continue
        left = set(re.findall(r'</?([^\s<>/!]+)', y['mes'])) - KEEP
        has_comment = check_comments and '<!--' in y['mes']
        if left or has_comment:
            problems.append(f'row {i}: leftover {sorted(left)} {"comment" if has_comment else ""}')
        ux, uy = update.search(x['mes']), update.search(y['mes'])
        if (ux.group(0) if ux else None) != (uy.group(0) if uy else None):
            problems.append(f'row {i}: UpdateVariable block changed')
        if 'collapse_repeat' in used['rules'] and y['mes'].count('<UpdateVariable>') > 1:
            problems.append(f'row {i}: more than one UpdateVariable block (a reply written twice that is not a plain repeat?)')
        if x['mes'].count('<StatusPlaceHolderImpl') != y['mes'].count('<StatusPlaceHolderImpl'):
            problems.append(f'row {i}: StatusPlaceHolderImpl count changed')
        if x.get('variables') != y.get('variables'):
            problems.append(f'row {i}: per-message variables changed')
        if y.get('swipes') and y['swipes'][y.get('swipe_id', 0)] != y['mes']:
            problems.append(f'row {i}: swipes[swipe_id] != mes')
        if re.match(rf'\s*{RULE}', y['mes']) or re.search(rf'{RULE}\s*$', narrative(y['mes'])):
            problems.append(f'row {i}: a horizontal rule at the start or at the end of the story')
        na, nb = len(narrative(x['mes'])), len(narrative(y['mes']))
        if (nb < 0.2 * na) or (nb < 300 <= na):
            problems.append(f'row {i}: narrative shrank suspiciously {na} -> {nb}')
    ta = sum(len(r['mes']) for r in a if is_ai(r))
    tb = sum(len(r['mes']) for r in b if is_ai(r))
    print(f'AI text chars {ta} -> {tb}')
    if problems:
        print('FAILED:')
        for p in problems:
            print('  -', p)
        sys.exit(1)
    print('OK: all checks passed')


def self_test():
    # Only the branches that fail silently: a block that survives, or story text that is cut.
    blocks = DEFAULT_BLOCKS + ['small']
    story = '她抬起头。'
    tail = '<UpdateVariable>***\n--- x</UpdateVariable>'

    def clean(text):
        return clean_text(text, blocks)[0]

    assert clean(f'<konatan_planning~>plan</konatan_planning~>{story}\n\n{tail}') == f'{story}\n\n{tail}', 'tag ending in a non-word character; the card tail is kept byte for byte'
    assert clean(f'thinking</erii_draft>{story}') == story, 'prefill: only the closing tag is in the text'
    assert clean(f'{story}\n\n***\n\n<StatusPlaceHolderImpl/>') == f'{story}\n\n<StatusPlaceHolderImpl/>', 'a * rule before the tail'
    assert clean(f'---\n{story}\n___') == story, 'rules at the start and at the end'
    assert clean(f'{story}\n<options>1. a{tail}') == f'{story}\n\n{tail}', 'unclosed options run up to the card tail'
    assert clean(f'『更启二年』\n\n{story}') == story, 'header line'
    assert clean(f'{story}<small>pick</small>') == story, 'a block added by --add-blocks'
    twice = f'{story}\n\n<UpdateVariable>a</UpdateVariable>{story}\n\n<UpdateVariable>b</UpdateVariable>\n\n<StatusPlaceHolderImpl/>'
    assert clean(twice) == f'{story}\n\n<UpdateVariable>a</UpdateVariable>\n\n<StatusPlaceHolderImpl/>', 'a reply written twice: the first copy stays'
    other = f'{story}\n\n<UpdateVariable>a</UpdateVariable>另一段完全不同的故事文字\n\n<UpdateVariable>b</UpdateVariable>'
    assert clean(other).count('<UpdateVariable>') == 2, 'two blocks that are not a repeat are left alone'
    assert merge_blocks(None, 'small')[-1] == 'small' and 'header' in merge_blocks(None, 'small'), '--add-blocks extends the defaults'
    assert merge_blocks('a', 'b') == ['a', 'b'], '--blocks replaces them'
    assert key_matches('LWB_SNAP', EXTENSION_STATE_KEYS) and key_matches('storyOracle_seq', EXTENSION_STATE_KEYS), 'extension state keys'
    assert not key_matches('variables', EXTENSION_STATE_KEYS) and not key_matches('integrity', EXTENSION_STATE_KEYS), 'the card variables stay'
    print('self-test passed')


def main():
    if '--self-test' in sys.argv:
        return self_test()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    keep_help = 'comma list of extra tag names that are card data and must be kept (added to the MVU defaults)'
    p = sub.add_parser('inventory'); p.add_argument('src'); p.add_argument('--keep', help=keep_help)
    p.set_defaults(fn=cmd_inventory)
    p = sub.add_parser('clean'); p.add_argument('src'); p.add_argument('dst')
    p.add_argument('--blocks', help='comma list of tag names to remove (replaces the built-in list; to extend it use --add-blocks)')
    p.add_argument('--add-blocks', help='comma list of tag names to remove in addition to the built-in (or --blocks) list')
    p.add_argument('--drop-empty-tail', action='store_true', help='drop the empty AI messages at the end (a failed generation leaves one)')
    p.add_argument('--keep', help=keep_help)
    p.add_argument('--disable-rules', help=f'comma list of text rules to turn off, from: {",".join(RULES)}')
    p.add_argument('--drop-keys', help='comma list of chat_metadata / extra keys to delete, * matches any run of characters (default: izumiWorldNext)')
    p.add_argument('--drop-extension-state', action=argparse.BooleanOptionalAction, default=True,
                   help=f'delete other extensions\' own state in chat_metadata: {",".join(EXTENSION_STATE_KEYS)} (default: on; --no-drop-extension-state keeps it)')
    p.set_defaults(fn=cmd_clean)
    p = sub.add_parser('verify'); p.add_argument('src'); p.add_argument('dst'); p.add_argument('--keep', help=keep_help)
    p.set_defaults(fn=cmd_verify)
    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
