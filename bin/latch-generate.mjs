#!/usr/bin/env node
// @ts-check
/**
 * latch-generate (LAT-77): writes a TypeScript file of a project's flag keys,
 * kinds and value types, for teams that want static checks. Optional: the SDK
 * works without it.
 *
 *   LATCH_API_TOKEN=lat_… npx github:inkress/latch-node latch-generate \
 *     --project <key> --out src/latch-flags.generated.ts --api <your Latch URL>
 *
 * The token needs flags:read. --check exits 1 if the file is out of date.
 */
import { readFile, writeFile } from "node:fs/promises";
import { renderTypes } from "./render-types.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const project = arg("project");
const out = arg("out");
const api = (arg("api") ?? process.env.LATCH_API_URL ?? "").replace(/\/+$/, "");
const token = process.env.LATCH_API_TOKEN;
const check = process.argv.includes("--check");
if (!project || !out || !token || !api) {
  console.error("usage: LATCH_API_TOKEN=lat_… latch-generate --project <key> --out <file.ts> --api <url> [--check]   (or LATCH_API_URL)");
  process.exit(2);
}

async function get(path) {
  const res = await fetch(`${api}/api/v1/projects/${encodeURIComponent(project)}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Latch answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const flags = [];
let cursor = null;
do {
  const page = await get(`/flags?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  for (const row of page.data) {
    // Allowed values live on the flag itself; on/off flags have none.
    const values = row.kind === "boolean" ? [] : (await get(`/flags/${encodeURIComponent(row.key)}`)).values ?? [];
    flags.push({ key: row.key, kind: row.kind, values });
  }
  cursor = page.next_cursor ?? null;
} while (cursor);

const text = renderTypes(project, flags);
if (check) {
  const current = await readFile(out, "utf8").catch(() => "");
  if (current !== text) {
    console.error(`${out} is out of date with Latch project "${project}"; run latch-generate.`);
    process.exit(1);
  }
  console.log(`${out} matches Latch (${flags.length} flags).`);
} else {
  await writeFile(out, text);
  console.log(`Wrote ${out}: ${flags.length} flags from Latch project "${project}".`);
}
