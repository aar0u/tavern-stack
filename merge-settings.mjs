// Applies the seed directory to the user's settings.json: seed/settings.json is deep-merged over it (keys in the seed win,
// everything else is kept; arrays and scalars are replaced, objects merged), and every seed/scripts/*.js becomes a Tavern Helper
// global script, replacing the one of the same name.
// usage: merge-settings.mjs <seed dir> <settings.json> [defaults.json] | --self-test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

// The name comes from a `// @name …` line, else the file name. The id only has to be stable, so it is derived from the name.
export function scriptEntry(file, content) {
  const name = /^\/\/ @name (.+)$/m.exec(content)?.[1].trim() ?? basename(file, ".js");
  const hex = createHash("sha1").update(`seed-script:${name}`).digest("hex");
  const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
  return { type: "script", enabled: true, name, id, content, info: "", button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true } };
}

// Scripts the user made themselves stay; a seed script replaces any script with its name or id.
export function injectScripts(settings, entries) {
  const holder = (((settings.extension_settings ??= {}).tavern_helper ??= {}).script ??= {});
  const replaced = (script) => entries.some((entry) => entry.name === script.name || entry.id === script.id);
  holder.scripts = [...(holder.scripts ?? []).filter((script) => !replaced(script)), ...entries];
  return settings;
}

if (process.argv.includes("--self-test")) {
  assert.deepEqual(merge({ a: { x: 1, y: [1] }, keep: 1 }, { a: { y: [2], z: 3 }, b: 2 }), { a: { x: 1, y: [2], z: 3 }, keep: 1, b: 2 });
  assert.deepEqual(merge({ a: 1 }, { a: { b: 1 } }), { a: { b: 1 } });

  const named = scriptEntry("x/pic.js", "// @name 画图 /pic\ncode();\n");
  assert.equal(named.name, "画图 /pic");
  assert.equal(scriptEntry("x/other.js", "code();").name, "other");
  assert.equal(named.id, scriptEntry("y/pic.js", "// @name 画图 /pic\nother();").id, "the id follows the name");
  assert.match(named.id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

  const user = { type: "script", name: "mine", id: "u1", content: "x" };
  const old = { type: "script", name: "画图 /pic", id: "old-id", content: "stale" };
  const settings = injectScripts({ extension_settings: { tavern_helper: { script: { enabled: { global: true }, scripts: [user, old] } } } }, [named]);
  assert.deepEqual(settings.extension_settings.tavern_helper.script.scripts, [user, named], "same name replaced, user's own script kept");
  assert.equal(settings.extension_settings.tavern_helper.script.enabled.global, true);
  assert.equal(injectScripts({}, [named]).extension_settings.tavern_helper.script.scripts.length, 1, "works on empty settings");
  console.log("merge-settings self-test passed");
} else {
  const [seedDir, target, fallback] = process.argv.slice(2);
  const load = (path) => (path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
  // The image's own defaults are the base when no settings.json exists yet, so other keys stay complete.
  const base = load(target) ?? load(fallback) ?? {};
  const scriptDir = join(seedDir, "scripts");
  const scripts = (existsSync(scriptDir) ? readdirSync(scriptDir).filter((file) => file.endsWith(".js")).sort() : [])
    .map((file) => scriptEntry(file, readFileSync(join(scriptDir, file), "utf8")));
  const seed = load(join(seedDir, "settings.json"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(injectScripts(merge(base, seed), scripts), null, 4)}\n`);
  console.log(`settings: merged ${seedDir} into ${target} (${scripts.length} scripts: ${scripts.map((s) => s.name).join(", ")})`);
}
