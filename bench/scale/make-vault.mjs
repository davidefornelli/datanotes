#!/usr/bin/env node
/**
 * A synthetic vault for the scale benchmark: N notes across 50 tables of realistic shapes (tasks,
 * projects, people, journal days, events, logs, documents), about 20% plain notes without a table,
 * links between rows, wikilinks in bodies, unique columns, bases, views and CHECKs. No personal
 * data: invented English names and generated text, the same for the same seed.
 *
 *   npm run build:service
 *   node bench/scale/make-vault.mjs --notes 10000 --out <folder> [--port 27401] [--seed 7] [--force]
 *
 * The schema (metastore.yaml) is built by the engine's own operations (the built
 * `dist/datanotes.cjs serve` on the new folder, over HTTP), never by hand, with a few anchor rows
 * inserted the same way. The engine is then stopped and the rows are written as files, in the
 * format the engine writes (a bulk import, as a sync tool or a git pull would bring them): the
 * first start of the engine on the result records them. Every row is valid (ids, links, CHECKs):
 * `check_table` on the result reports no violation.
 *
 * Output: <out>/vault (the notes), <out>/store (the engine's store after the schema was built),
 * <out>/manifest.json (tables, row counts and names the benchmark uses).
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs, startEngine } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const N = Number(args.notes ?? 2500);
const OUT = path.resolve(String(args.out ?? ""));
const PORT = Number(args.port ?? 27401);
const SEED = Number(args.seed ?? 7);
const PLAIN_SHARE = Number(args.plain ?? 0.2);
if (!args.out) {
  console.error("usage: node bench/scale/make-vault.mjs --notes 10000 --out <folder> [--port 27401] [--seed 7] [--force]");
  process.exit(2);
}
if (fs.existsSync(OUT)) {
  if (!args.force) throw new Error(`${OUT} exists: pass --force to replace it`);
  fs.rmSync(OUT, { recursive: true, force: true });
}
const VAULT = path.join(OUT, "vault");
const STORE = path.join(OUT, "store");
const DATA_HOME = path.join(OUT, "datahome");
fs.mkdirSync(VAULT, { recursive: true });
fs.mkdirSync(DATA_HOME, { recursive: true });

// --- deterministic randomness ------------------------------------------------------------------

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const chance = (p) => rnd() < p;
const skewed = (xs) => xs[Math.min(xs.length - 1, Math.floor(-Math.log(1 - rnd()) * 0.9))];
function gauss() {
  const u = 1 - rnd();
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** A length with a long tail: median `median`, clipped to [lo, hi]. */
const lognormal = (median, sigma, lo, hi) => Math.max(lo, Math.min(hi, Math.round(median * Math.exp(sigma * gauss()))));
const pickN = (xs, n) => {
  const out = new Set();
  for (let i = 0; i < n * 3 && out.size < Math.min(n, xs.length); i++) out.add(pick(xs));
  return [...out];
};

/** A UUIDv7 for a time (ms): the format of the engine's `id` column. */
function uuidv7(ms) {
  const h = (n, w) => n.toString(16).padStart(w, "0");
  const ts = h(ms, 12);
  const r = () => int(0, 0xffff);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${h(int(0, 0xfff), 3)}-${h(0x8000 | (r() & 0x3fff), 4)}-${h(r(), 4)}${h(r(), 4)}${h(r(), 4)}`;
}

// --- words ------------------------------------------------------------------------------------

const WORDS = (
  "the a of and to in for on with by about from into over after before between under around " +
  "plan review draft budget team project meeting notes idea design system release report goal " +
  "metric customer service product feature roadmap issue bug test build deploy schedule week month " +
  "quarter year morning evening garden kitchen book chapter article course lesson habit routine " +
  "walk run swim ride sleep coffee lunch dinner recipe market travel train station city river " +
  "mountain forest field river light sound color shape pattern question answer reason result " +
  "change update decision option risk cost value time place person group community friend family " +
  "neighbor colleague mentor student teacher writer reader listener builder maker gardener cook " +
  "quick slow careful bright quiet steady simple clear rough early late small large open closed " +
  "new old next last first second better faster cleaner smaller stronger lighter warmer cooler " +
  "write read check fix move keep share send call ask learn teach plant water harvest prepare " +
  "measure compare improve finish start continue pause resume archive collect organize sort label " +
  "window door table chair desk shelf lamp garden fence path stone wood paper ink map compass " +
  "signal network server client cache index query table column row field record version history"
).split(/\s+/);
const NOUNS = "budget roadmap launch migration audit survey workshop interview prototype dashboard pipeline backlog checklist handbook timeline proposal estimate inventory catalog schedule benchmark".split(" ");
const VERBS = "Review Draft Update Fix Plan Prepare Check Write Send Measure Clean Move Organize Test Ship Archive Compare Outline Finish Book".split(" ");
const ADJ = "Amber Quiet Bright Northern Silver Steady Hidden Rapid Gentle Bold Crimson Golden Little Open Hollow Swift Patient Lucky Distant Clever".split(" ");
const ANIMALS = "Falcon Harbor Meadow Lantern Orchard Compass Beacon Summit Willow Cedar Comet Delta Ember Fjord Grove Horizon Island Juniper Kestrel Lagoon".split(" ");
const FIRST = "Avery Blake Casey Dana Elliot Finley Gray Harper Indigo Jordan Kai Logan Morgan Noel Oakley Parker Quinn Reese Sawyer Taylor Umber Val Wren Yael Zion Ash Brook Cody Drew Emery Frankie Hollis Jules Kendall Lane Marlow Nico Penn Rory Sage".split(" ");
const LAST = "Abbott Barlow Carver Dalton Ellison Fairley Garrison Hale Ingram Jarvis Keller Lowell Mercer Norwood Oakes Pember Quill Radford Sterling Thorne Upton Vance Whitlock Yardley Ziegler Ashby Brannon Colby Dunmore Everly Fenwick Gaskell Holloway Ives Kingsley Lockwood Merritt Prescott Rowan Sutton".split(" ");
const CITIES = "Northbridge Eastvale Westmoor Southport Lakeside Riverton Hillcrest Fairhaven Oakridge Stonebury".split(" ");
const TAGS = "reading ideas work health garden travel learning finance home people writing research".split(" ");

let SEQ = 1000;
const seq = () => ++SEQ;
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function sentence(links) {
  const n = int(6, 18);
  const ws = [];
  for (let i = 0; i < n; i++) ws.push(pick(WORDS));
  if (links.length && chance(0.6)) ws.splice(int(1, ws.length - 1), 0, `[[${links.shift()}]]`);
  if (chance(0.05)) ws.push(`#${pick(TAGS)}`);
  return cap(ws.join(" ")) + ".";
}

/** Markdown text of about `len` characters with these wikilinks in it. */
function text(len, links = []) {
  const parts = [];
  let size = 0;
  const pending = [...links];
  while (size < len || pending.length) {
    const r = rnd();
    let block;
    if (r < 0.1 && parts.length) block = `## ${cap(pick(WORDS))} ${pick(WORDS)}`;
    else if (r < 0.22) block = Array.from({ length: int(2, 5) }, () => `- ${sentence(pending).slice(0, -1)}`).join("\n");
    else if (r < 0.235) block = "```\n" + Array.from({ length: int(2, 6) }, () => `${pick(WORDS)} = ${pick(WORDS)}(${int(1, 99)})`).join("\n") + "\n```";
    else block = Array.from({ length: int(2, 5) }, () => sentence(pending)).join(" ");
    parts.push(block);
    size += block.length + 2;
    if (size > len * 3) break;
  }
  return parts.join("\n\n") + "\n";
}

// --- YAML (the engine's style) -----------------------------------------------------------------------

function scalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(s)) return s;
  if (/^[A-Za-z][A-Za-z0-9 .,'()-]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && !/[ ]$/.test(s)) return s;
  return JSON.stringify(s);
}
function frontmatter(entries) {
  const lines = ["---"];
  for (const [k, v] of entries) {
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const x of v) lines.push(`  - ${scalar(x)}`);
    } else lines.push(`${k}: ${scalar(v)}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}
const link = (name) => `[[${name}]]`;

// --- dates ------------------------------------------------------------------------------------

const TODAY = Date.UTC(2026, 9, 13);
const DAY = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoTime = (ms) => new Date(Math.floor(ms / 60000) * 60000).toISOString().slice(0, 19) + "Z";
const fileTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace(":", "");
const randomDay = (fromYearsAgo = 6, ahead = 120) => TODAY - int(-ahead, fromYearsAgo * 365) * DAY;

// --- the schema -----------------------------------------------------------------------------------

const c = (name, type, description, extra = {}) => ({ name, type, description, ...extra });
const STATUS_TASK = ["todo", "doing", "done", "waiting"];
const PRIORITY = ["low", "medium", "high", "urgent"];

/**
 * The tables: archetype, weight (share of the rows), columns. Archetypes: P project tree, H person,
 * T task, E event, L log (named by time), J journal day, D document, A entity.
 */
const T = [];
const table = (cat, sch, name, arch, w, description, cols, opts = {}) => T.push({ cat, sch, name, arch, w, description, cols, opts: arch === "L" ? { time_column: "occurred_at", ...opts } : opts, q: `${cat}.${sch}.${name}`, rows: [] });

// work.planning
table("work", "planning", "project", "P", 2, "Areas of responsibility, the projects in them and their workstreams", [
  c("name", "string", "The name of the area, project or workstream", { required: true, unique: true }),
  c("kind", "enum", "Its level in the tree", { values: ["area", "project", "workstream"], required: true }),
  c("parent", "link", "The area or project one level up", { ref: "self", hierarchy: true }),
  c("status", "enum", "Whether the work goes on, waits or is finished", { values: ["active", "paused", "done"], default: "active" }),
], { filename: "{name}" });
table("work", "planning", "task", "T", 14, "Things to do, each in a project", [], { filename: "{title}", ref: "work.planning.project" });
table("work", "planning", "milestone", "T", 1.5, "Milestones of the projects", [], { filename: "{title}", ref: "work.planning.project" });
table("work", "planning", "meeting", "E", 5, "Meetings with their attendees", [], { filename: "{title}", about: "work.planning.project" });
table("work", "planning", "decision", "D", 1, "Decisions taken and why", [], { filename: "{title}", kinds: ["technical", "process", "people", "budget"], statuses: ["proposed", "accepted", "superseded"] });
table("work", "planning", "risk", "A", 0.4, "Risks of the projects", [], { filename: "{name}", kinds: ["schedule", "budget", "quality", "people"], statuses: ["open", "mitigated", "closed"], link: { col: "project", ref: "work.planning.project" } });
table("work", "planning", "okr", "A", 0.4, "Objectives and key results", [], { filename: "{name}", kinds: ["objective", "key result"], statuses: ["on track", "at risk", "done"], link: { col: "project", ref: "work.planning.project" } });
// work.crm
table("work", "crm", "organization", "A", 1.5, "Companies and organizations we deal with", [], { filename: "{name}", kinds: ["customer", "supplier", "partner", "public body"], statuses: ["active", "former"], extra: [c("city", "string", "The city of its main office"), c("website", "string", "Its web address")] });
table("work", "crm", "person", "H", 4, "People we know or work with", [], { filename: "{name}" });
table("work", "crm", "deal", "A", 1, "Deals with organizations", [], { filename: "{name}", kinds: ["new", "renewal", "upsell"], statuses: ["lead", "proposal", "won", "lost"], link: { col: "organization", ref: "work.crm.organization", required: true }, extra: [c("amount", "number", "The value of the deal", { min: 0 })] });
table("work", "crm", "contact_log", "E", 3, "Calls and messages with organizations", [], { filename: "{title}", about: "work.crm.organization" });
table("work", "crm", "invoice", "A", 1, "Invoices sent and received", [], { filename: "{name}", kinds: ["sent", "received"], statuses: ["draft", "sent", "paid", "overdue"], link: { col: "organization", ref: "work.crm.organization", required: true }, extra: [c("amount", "number", "The amount", { min: 0 }), c("issued_on", "date", "When it was issued")] });
// work.engineering
table("work", "engineering", "repository", "A", 0.4, "Source code repositories", [], { filename: "{name}", kinds: ["service", "library", "tool", "docs"], statuses: ["active", "archived"], extra: [c("code", "string", "A short unique code", { unique: true })] });
table("work", "engineering", "service", "A", 0.4, "Running services", [], { filename: "{name}", kinds: ["api", "worker", "frontend", "database"], statuses: ["live", "deprecated"], link: { col: "repository", ref: "work.engineering.repository" }, extra: [c("code", "string", "A short unique code", { unique: true })] });
table("work", "engineering", "incident", "E", 1, "Incidents of the services", [], { filename: "{title}", about: "work.engineering.service" });
table("work", "engineering", "bug", "T", 6, "Bugs to fix", [], { filename: "{title}", ref: "work.engineering.repository" });
table("work", "engineering", "release", "A", 1, "Releases of the repositories", [], { filename: "{name}", kinds: ["major", "minor", "patch"], statuses: ["planned", "released"], link: { col: "repository", ref: "work.engineering.repository" }, extra: [c("version", "string", "The version number")] });
table("work", "engineering", "adr", "D", 1, "Architecture decision records", [], { filename: "{title}", kinds: ["storage", "api", "security", "tooling"], statuses: ["proposed", "accepted", "deprecated"] });
// life.journal
table("life", "journal", "day", "J", 6, "One note per day: how it went", [], { time_column: "date" });
table("life", "journal", "weekly_review", "D", 1, "Weekly reviews", [], { filename: "{title}", kinds: ["work", "personal"], statuses: ["draft", "done"] });
table("life", "journal", "gratitude", "L", 1, "Things to be grateful for", [], { kinds: ["people", "health", "work", "nature"] });
table("life", "journal", "dream", "L", 0.5, "Dreams remembered", [], { kinds: ["vivid", "vague", "recurring"] });
// life.health
table("life", "health", "workout", "L", 3, "Workouts", [], { kinds: ["run", "swim", "ride", "strength", "yoga"] });
table("life", "health", "meal", "L", 4, "Meals eaten", [], { kinds: ["breakfast", "lunch", "dinner", "snack"] });
table("life", "health", "measurement", "L", 4, "Body measurements", [], { kinds: ["weight", "resting heart rate", "blood pressure", "steps"] });
table("life", "health", "medication", "A", 0.4, "Medications taken", [], { filename: "{name}", kinds: ["daily", "as needed"], statuses: ["current", "stopped"] });
table("life", "health", "symptom", "L", 0.5, "Symptoms noted", [], { kinds: ["headache", "fatigue", "cough", "pain"] });
// life.home
table("life", "home", "room", "A", 0.3, "Rooms of the house", [], { filename: "{name}", kinds: ["living", "sleeping", "working", "storage"], statuses: ["in use", "to renovate"] });
table("life", "home", "chore", "T", 2, "Chores around the house", [], { filename: "{title}", ref: "life.home.room" });
table("life", "home", "purchase", "A", 2, "Things bought", [], { filename: "{name}", kinds: ["food", "tools", "clothes", "electronics"], statuses: ["kept", "returned"], extra: [c("amount", "number", "The price paid", { min: 0 }), c("bought_on", "date", "When it was bought")] });
table("life", "home", "plant", "A", 0.4, "House plants", [], { filename: "{name}", kinds: ["succulent", "fern", "herb", "tree"], statuses: ["healthy", "struggling"], link: { col: "room", ref: "life.home.room" } });
table("life", "home", "recipe", "D", 1, "Recipes", [], { filename: "{title}", kinds: ["breakfast", "main", "dessert", "drink"], statuses: ["to try", "tried", "favourite"] });
table("life", "home", "appliance", "A", 0.3, "Appliances and their manuals", [], { filename: "{name}", kinds: ["kitchen", "laundry", "heating", "garden"], statuses: ["working", "broken"], link: { col: "room", ref: "life.home.room" } });
table("life", "home", "trip", "E", 0.4, "Trips", [], { filename: "{title}", about: null });
// life.learning
table("life", "learning", "book", "D", 1, "Books read or to read", [], { filename: "{title}", kinds: ["fiction", "essay", "technical", "history"], statuses: ["to read", "reading", "read"] });
table("life", "learning", "article", "D", 4, "Articles saved", [], { filename: "{title}", kinds: ["blog", "paper", "news", "tutorial"], statuses: ["to read", "read"], url: true });
table("life", "learning", "course", "A", 0.4, "Courses taken", [], { filename: "{name}", kinds: ["online", "classroom", "workshop"], statuses: ["planned", "ongoing", "finished"] });
table("life", "learning", "flashcard", "D", 7, "Flashcards to review", [], { filename: "{title}", kinds: ["language", "science", "history", "code"], statuses: ["new", "learning", "known"], due: true });
table("life", "learning", "quote", "D", 2, "Quotes worth keeping", [], { filename: "{title}", kinds: ["wisdom", "humor", "work"], statuses: ["kept"], source: "life.learning.book" });
table("life", "learning", "podcast_episode", "D", 1, "Podcast episodes", [], { filename: "{title}", kinds: ["interview", "solo", "panel"], statuses: ["to listen", "listened"], url: true });
// lab.garden
table("lab", "garden", "crop", "A", 0.4, "Crops grown in the garden", [], { filename: "{name}", kinds: ["vegetable", "herb", "fruit", "flower"], statuses: ["growing", "resting"] });
table("lab", "garden", "sowing_log", "L", 0.5, "Sowings", [], { kinds: ["seed", "seedling", "cutting"], link: { col: "crop", ref: "lab.garden.crop" } });
table("lab", "garden", "harvest", "L", 0.5, "Harvests", [], { kinds: ["small", "medium", "large"], link: { col: "crop", ref: "lab.garden.crop" } });
// lab.misc
table("lab", "misc", "topic", "A", 0.4, "Topics notes are about", [], { filename: "{name}", kinds: ["field", "skill", "interest"], statuses: ["active", "dormant"] });
table("lab", "misc", "idea", "D", 3, "Ideas", [], { filename: "{title}", kinds: ["product", "writing", "home", "research"], statuses: ["new", "explored", "dropped"] });
table("lab", "misc", "bookmark", "D", 4, "Bookmarks", [], { filename: "{title}", kinds: ["tool", "reference", "inspiration"], statuses: ["unread", "read"], url: true });
table("lab", "misc", "habit", "A", 0.3, "Habits to keep", [], { filename: "{name}", kinds: ["daily", "weekly"], statuses: ["active", "paused"] });
table("lab", "misc", "habit_check", "L", 4, "Habit check-ins", [], { kinds: ["done", "skipped"], link: { col: "habit", ref: "lab.misc.habit", required: true } });
table("lab", "misc", "goal", "A", 0.4, "Long-term goals", [], { filename: "{name}", kinds: ["health", "career", "learning", "home"], statuses: ["open", "reached", "dropped"] });
table("lab", "misc", "snippet", "D", 2, "Code and text snippets", [], { filename: "{title}", kinds: ["shell", "sql", "regex", "text"], statuses: ["kept"] });

const byQ = new Map(T.map((t) => [t.q, t]));
const BASES = [
  { name: "dated", description: "Work that starts on a day", columns: [c("started_on", "date", "When it began"), c("summary", "string", "One line about it")], tables: ["work.planning.project", "life.learning.course", "lab.misc.goal", "life.home.trip"] },
  { name: "contact", description: "How to reach someone", columns: [c("email", "string", "Where to write to"), c("phone", "string", "A phone number")], tables: ["work.crm.person", "work.crm.organization"] },
  { name: "record", description: "A rating and a short review", columns: [c("rating", "integer", "From 1 to 5", { min: 1, max: 5 }), c("review", "string", "A short review")], tables: ["life.learning.book", "life.home.recipe", "life.learning.article", "life.learning.podcast_episode"] },
];
const basesOf = (q) => BASES.filter((b) => b.tables.includes(q));

/** The columns of a table (its own, without bases and without `id`), by archetype. */
function columnsOf(t) {
  const o = t.opts;
  switch (t.arch) {
    case "P":
      return t.cols;
    case "H":
      return [
        c("name", "string", "The person's full name", { required: true, unique: true }),
        c("role", "enum", "What the person does", { values: ["engineer", "designer", "manager", "sales", "researcher", "friend", "family"] }),
        c("organization", "link", "Where the person works", { ref: "work.crm.organization" }),
        c("birthday", "date", "The person's birthday"),
      ];
    case "T":
      return [
        c("title", "string", "The task, in a few words", { required: true, unique: true }),
        c("status", "enum", "Whether it is to do, under way, waiting or done", { values: STATUS_TASK, required: true, default: "todo" }),
        c("priority", "enum", "How soon it matters", { values: PRIORITY, ordered: true }),
        c("due", "date", "The day it must be done by"),
        c("done_on", "date", "The day it was done"),
        c(o.ref === "life.home.room" ? "room" : o.ref === "work.engineering.repository" ? "repository" : "project", "link", "Where it belongs", { ref: o.ref, required: true }),
        c("assignee", "link", "Who does it", { ref: "work.crm.person" }),
        c("estimate_h", "number", "Hours of work it should take", { min: 0, max: 80 }),
        c("labels", "list", "Free labels", { items: "string" }),
      ];
    case "E":
      return [
        c("title", "string", "What the event is", { required: true, unique: true }),
        c("starts_at", "datetime", "When it starts", { required: true }),
        c("ends_at", "datetime", "When it ends"),
        c("location", "string", "Where it takes place"),
        c("attendees", "list", "Who takes part", { items: "link", ref: "work.crm.person" }),
        ...(o.about ? [c("about", "link", "What it is about", { ref: o.about })] : []),
      ];
    case "L":
      return [
        c("occurred_at", "datetime", "When it happened", { required: true, dense: true }),
        c("kind", "enum", "The kind of entry", { values: o.kinds, dense: true }),
        c("value", "number", "A measure of it", { dense: true }),
        c("note", "string", "A few words about it"),
        ...(o.link ? [c(o.link.col, "link", "What it is about", { ref: o.link.ref, ...(o.link.required ? { required: true } : {}) })] : []),
      ];
    case "J":
      return [
        c("date", "date", "The day", { required: true, unique: true }),
        c("mood", "enum", "How the day felt", { values: ["great", "good", "okay", "low", "bad"], ordered: true }),
        c("energy", "integer", "Energy from 1 to 5", { min: 1, max: 5 }),
        c("sleep_h", "number", "Hours slept the night before", { min: 0, max: 14 }),
        c("people", "list", "People met that day", { items: "link", ref: "work.crm.person" }),
      ];
    case "D":
      return [
        c("title", "string", "The title", { required: true, unique: true }),
        c("kind", "enum", "What kind it is", { values: o.kinds }),
        c("status", "enum", "Where it stands", { values: o.statuses, default: o.statuses[0] }),
        ...(o.url ? [c("url", "string", "Its web address")] : []),
        ...(o.due ? [c("due", "date", "When to review it next")] : []),
        ...(o.source ? [c("source", "link", "Where it comes from", { ref: o.source })] : []),
        c("topics", "list", "What it is about", { items: "link", ref: "lab.misc.topic" }),
      ];
    case "A":
      return [
        c("name", "string", "The name", { required: true, unique: true }),
        c("kind", "enum", "What kind it is", { values: o.kinds }),
        c("status", "enum", "Where it stands", { values: o.statuses, default: o.statuses[0] }),
        ...(o.link ? [c(o.link.col, "link", "What it belongs to", { ref: o.link.ref, ...(o.link.required ? { required: true } : {}) })] : []),
        ...(o.extra ?? []),
      ];
  }
  throw new Error(t.arch);
}

const ANCHOR_AREAS = ["Engineering", "Operations", "Research", "Home", "Community"];

const VIEWS = [
  { name: "vw_open_tasks", query: { table: "work.planning.task", columns: ["title", "project", "assignee", "priority", "due"], where: { status: { ne: "done" } }, order_by: "due" }, description: "Tasks not done yet, the nearest due date first" },
  { name: "vw_overdue_tasks", query: { table: "work.planning.task", columns: ["title", "project", "due"], where: { status: { ne: "done" }, due: { lt: "{today}" } }, order_by: "due" }, description: "Tasks past their due date" },
  { name: "vw_open_bugs", query: { table: "work.engineering.bug", columns: ["title", "repository", "priority"], where: { status: { in: ["todo", "doing"] } }, order_by: "-priority" }, description: "Bugs to fix, the most urgent first" },
  { name: "vw_recent_meetings", query: { table: "work.planning.meeting", columns: ["title", "starts_at", "attendees"], where: { starts_at: { gte: "{today-30d}" } }, order_by: "-starts_at" }, description: "Meetings of the last 30 days" },
  { name: "vw_engineering", query: { table: "work.planning.project", columns: ["name", "kind", "parent", "status"], where: { parent: { within: "[[Engineering]]" } }, order_by: "name" }, description: "Projects and workstreams under Engineering, at any depth" },
  { name: "vw_project_tasks", query: { table: "work.planning.task", columns: ["title", "status", "assignee", "due"], where: { project: { within: "{this.link}" } }, order_by: "title" }, description: "Tasks of the project a note is about, its workstreams included" },
  { name: "vw_reading_list", query: { table: "life.learning.article", columns: ["title", "kind", "url"], where: { status: "to read" }, order_by: "title" }, description: "Articles still to read" },
  { name: "vw_due_cards", query: { table: "life.learning.flashcard", columns: ["title", "kind", "due"], where: { due: { lte: "{today}" } }, order_by: "due" }, description: "Flashcards due for review" },
  { name: "vw_people_at_customers", query: { table: "work.crm.person", columns: ["name", "role", "organization"], where: { "organization.kind": "customer" }, order_by: "name" }, description: "People who work at a customer" },
  { name: "vw_backlog", query: { union: [{ table: "work.planning.task", columns: ["title", "status", "priority"], where: { status: { ne: "done" } } }, { table: "work.engineering.bug", columns: ["title", "status", "priority"], where: { status: { ne: "done" } } }, { table: "life.home.chore", columns: ["title", "status", "priority"], where: { status: { ne: "done" } } }], order_by: "-priority", limit: 200 }, description: "Everything still to do: tasks, bugs and chores" },
];

// --- 1. the schema, through the engine ------------------------------------------------------------

const t0 = performance.now();
const TOKEN = "scale-make-vault";
const engine = await startEngine({ vault: VAULT, store: STORE, port: PORT, token: TOKEN, dataHome: DATA_HOME, settings: { fileLogEnabled: false } });
const ops = [];
let dbFolder = "datanotes";
try {
  const run = async (op, a) => {
    ops.push(op);
    return (await engine.call(op, a)).json;
  };
  await run("configure_database", { timezone: "UTC", default_catalog: "work", default_schema: "planning", history: true });
  for (const b of BASES) await run("define_base", { name: b.name, description: b.description, columns: b.columns });
  for (const t of T) t.columns = columnsOf(t);
  // referenced tables first
  const ordered = [];
  const visit = (t, stack = new Set()) => {
    if (ordered.includes(t) || stack.has(t)) return;
    stack.add(t);
    for (const col of t.columns) if (col.ref && col.ref !== "self") visit(byQ.get(col.ref), stack);
    ordered.push(t);
  };
  for (const t of T) visit(t);
  for (const t of ordered) {
    const o = t.opts;
    await run("create_table", {
      catalog: t.cat,
      schema: t.sch,
      name: t.name,
      description: t.description,
      columns: t.columns,
      ...(o.time_column ? { time_column: o.time_column } : { filename: o.filename }),
      tags: { domain: t.sch },
    });
  }
  const comments = new Set();
  for (const t of T) {
    if (!comments.has(t.cat)) {
      comments.add(t.cat);
      await run("comment_on", { catalog: t.cat, description: `The ${t.cat} catalog` });
    }
  }
  for (const t of T) {
    const bs = basesOf(t.q).map((b) => b.name);
    if (bs.length) await run("set_table_bases", { table: t.q, bases: bs });
  }
  // links in both directions: project.members <-> person.projects
  await run("add_column", { table: "work.crm.person", column: c("projects", "list", "Projects the person works on", { items: "link", ref: "work.planning.project" }) });
  await run("add_column", { table: "work.planning.project", column: c("members", "list", "People on the project", { items: "link", ref: "work.crm.person", inverse: "projects" }) });
  await run("add_constraint", { table: "work.planning.task", name: "done_has_date", check: { or: [{ status: { ne: "done" } }, { done_on: { exists: true } }] } });
  await run("add_constraint", { table: "work.planning.task", name: "project_known", check: { "project.status": { in: ["active", "paused", "done"] } } });
  await run("add_constraint", { table: "work.engineering.bug", name: "done_has_date", check: { or: [{ status: { ne: "done" } }, { done_on: { exists: true } }] } });
  // the anchor rows, written by the engine
  for (const a of ANCHOR_AREAS) await run("insert_row", { table: "work.planning.project", values: { name: a, kind: "area", summary: `Everything about ${a.toLowerCase()}` }, body: `# ${a}\n\nThe ${a.toLowerCase()} area.\n` });
  for (const v of VIEWS) await run("create_view", v);
  const db = (await run("describe_database", {})) ?? {};
  dbFolder = db.root ?? db.database_folder ?? db.folder ?? dbFolder;
  const tables = (await run("list_tables", {})).tables;
  console.log(`schema: ${tables.length} tables, ${VIEWS.length} views, ${BASES.length} bases, ${ops.length} operations in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
} finally {
  await engine.stop();
}
if (!fs.existsSync(path.join(VAULT, dbFolder, "metastore.yaml"))) {
  const found = fs.readdirSync(VAULT).find((d) => fs.existsSync(path.join(VAULT, d, "metastore.yaml")));
  if (!found) throw new Error("metastore.yaml not found");
  dbFolder = found;
}

// --- 2. the rows ----------------------------------------------------------------------------------------

const ROWS = Math.round(N * (1 - PLAIN_SHARE)) - ANCHOR_AREAS.length;
const PLAIN = N - ROWS - ANCHOR_AREAS.length;
const wsum = T.reduce((s, t) => s + t.w, 0);
for (const t of T) t.count = Math.max(3, Math.round((ROWS * t.w) / wsum));
// the journal has one row per day: at most ~11 years
byQ.get("life.journal.day").count = Math.min(byQ.get("life.journal.day").count, 4000);

const names = new Map(); // table -> names (link targets)
const plainNames = [];
for (let i = 0; i < PLAIN; i++) plainNames.push(`${cap(pick(WORDS))} ${pick(WORDS)} ${pick(NOUNS)} ${seq()}`);

function nameFor(t, i) {
  switch (t.arch) {
    case "H": {
      const k = i;
      const f = FIRST[k % FIRST.length];
      const l = LAST[Math.floor(k / FIRST.length) % LAST.length];
      const initial = String.fromCharCode(65 + (Math.floor(k / (FIRST.length * LAST.length)) % 26));
      const round = Math.floor(k / (FIRST.length * LAST.length * 26));
      return `${f} ${initial}. ${l}${round ? ` ${round + 1}` : ""}`;
    }
    case "T":
      return `${pick(VERBS)} the ${pick(WORDS)} ${pick(NOUNS)} ${seq()}`;
    case "E":
      return `${cap(t.name.replace("_", " "))} ${pick(NOUNS)} ${seq()}`;
    case "D":
      return t.name === "weekly_review" ? `Week review ${seq()}` : `${cap(pick(WORDS))} ${pick(WORDS)} ${pick(NOUNS)} ${seq()}`;
    case "A":
    case "P":
      return `${pick(ADJ)} ${pick(ANIMALS)} ${seq()}`;
    default:
      return null;
  }
}

for (const t of T) {
  if (t.arch === "L" || t.arch === "J") continue;
  const list = [];
  for (let i = 0; i < t.count; i++) list.push(nameFor(t, i));
  names.set(t.q, list);
}
const projects = []; // {name, kind, parent}
{
  const list = names.get("work.planning.project");
  for (const n of list) {
    const kind = projects.filter((p) => p.kind === "project").length < 3 || chance(0.7) ? "project" : "workstream";
    const parents = kind === "project" ? ANCHOR_AREAS : projects.filter((p) => p.kind === "project").map((p) => p.name);
    projects.push({ name: n, kind, parent: pick(parents) });
  }
}
const projectNames = projects.map((p) => p.name);
const linkTargets = () => {
  const r = rnd();
  if (r < 0.25) return pick(names.get("work.crm.person"));
  if (r < 0.4) return pick(projectNames);
  if (r < 0.55) return pick(names.get("work.planning.task"));
  if (r < 0.65) return pick(names.get("lab.misc.topic"));
  if (r < 0.72) return pick(names.get("life.learning.book"));
  if (r < 0.95) return plainNames.length ? pick(plainNames) : pick(projectNames);
  return `Missing note ${int(1, 500)}`;
};
const links = (lo, hi) => Array.from({ length: int(lo, hi) }, linkTargets);
const bodyOf = (p, median, lo, hi, l0, l1) => (chance(p) ? text(lognormal(median, 0.8, lo, hi), links(l0, l1)) : "");

const memberOf = new Map(); // person -> projects
let created = 0;
let bytes = 0;
const folders = new Set();
function writeNote(rel, content) {
  const abs = path.join(VAULT, ...rel.split("/"));
  const dir = path.dirname(abs);
  if (!folders.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    folders.add(dir);
  }
  fs.writeFileSync(abs, content);
  created++;
  bytes += content.length;
}
const tableFolder = (t) => `${dbFolder}/${t.cat}/${t.sch}/${t.name}`;

function emit(t, file, values, body) {
  const ms = TODAY - int(0, 6 * 365) * DAY - int(0, DAY);
  const entries = [["table", t.q], ["id", uuidv7(ms)], ...Object.entries(values)];
  writeNote(`${tableFolder(t)}/${file}.md`, frontmatter(entries) + body);
  t.rows.push(file);
}

const genOrder = [...T].sort((a, b) => (a.arch === "H") - (b.arch === "H")); // people last (inverse links)
const people = names.get("work.crm.person");
for (const t of genOrder) {
  const o = t.opts;
  const baseValues = () => {
    const v = {};
    for (const b of basesOf(t.q)) {
      if (b.name === "dated" && chance(0.7)) {
        v.started_on = isoDate(randomDay(4, 0));
        v.summary = sentence([]).slice(0, 60);
      }
      if (b.name === "contact" && chance(0.6)) {
        v.email = `contact${seq()}@example.com`;
        if (chance(0.5)) v.phone = `+1 555 01${int(10, 99)}`;
      }
      if (b.name === "record" && chance(0.5)) {
        v.rating = int(1, 5);
        if (chance(0.5)) v.review = sentence([]).slice(0, 80);
      }
    }
    return v;
  };
  if (t.arch === "P") {
    for (const p of projects) {
      const members = chance(0.8) ? pickN(people, int(1, 4)) : [];
      for (const m of members) {
        if (!memberOf.has(m)) memberOf.set(m, []);
        memberOf.get(m).push(p.name);
      }
      emit(t, p.name, { name: p.name, kind: p.kind, parent: link(p.parent), status: skewed(["active", "paused", "done"]), ...baseValues(), members: members.map(link) }, bodyOf(0.9, 1200, 200, 12000, 2, 6));
    }
    continue;
  }
  if (t.arch === "H") {
    const orgs = names.get("work.crm.organization");
    for (const n of names.get(t.q)) {
      emit(t, n, { name: n, role: chance(0.9) ? pick(["engineer", "designer", "manager", "sales", "researcher", "friend", "family"]) : undefined, organization: chance(0.6) ? link(pick(orgs)) : undefined, birthday: chance(0.3) ? isoDate(TODAY - int(20 * 365, 70 * 365) * DAY) : undefined, ...baseValues(), projects: (memberOf.get(n) ?? []).map(link) }, bodyOf(0.6, 400, 80, 4000, 0, 3));
    }
    continue;
  }
  if (t.arch === "T") {
    const targets = t.columns.find((x) => x.type === "link" && x.required);
    const pool = o.ref === "work.planning.project" ? projectNames : names.get(o.ref);
    for (const n of names.get(t.q)) {
      const status = skewed(["done", "todo", "doing", "waiting"]);
      const due = chance(0.6) ? isoDate(randomDay(3, 90)) : undefined;
      emit(t, n, {
        title: n,
        status,
        priority: chance(0.8) ? pick(PRIORITY) : undefined,
        due,
        done_on: status === "done" ? isoDate(randomDay(3, 0)) : undefined,
        [targets.name]: link(pick(pool)),
        assignee: chance(0.7) ? link(pick(people)) : undefined,
        estimate_h: chance(0.4) ? int(1, 40) : undefined,
        labels: chance(0.3) ? pickN(TAGS, int(1, 3)) : undefined,
      }, bodyOf(0.5, 350, 60, 6000, 0, 2));
    }
    continue;
  }
  if (t.arch === "E") {
    const about = o.about ? (o.about === "work.planning.project" ? projectNames : names.get(o.about)) : null;
    for (const n of names.get(t.q)) {
      const start = randomDay(5, 60) + int(7, 19) * 3600_000;
      emit(t, n, {
        title: n,
        starts_at: isoTime(start),
        ends_at: chance(0.8) ? isoTime(start + int(1, 8) * 1800_000) : undefined,
        location: chance(0.5) ? pick(CITIES) : undefined,
        attendees: pickN(people, int(1, 5)).map(link),
        ...(about ? { about: chance(0.8) ? link(pick(about)) : undefined } : {}),
        ...baseValues(),
      }, bodyOf(0.8, 600, 100, 8000, 1, 4));
    }
    continue;
  }
  if (t.arch === "L") {
    const target = o.link ? names.get(o.link.ref) : null;
    let ms = TODAY - Math.ceil(t.count / 3) * DAY;
    for (let i = 0; i < t.count; i++) {
      ms += int(1, 16) * 1800_000 + int(1, 29) * 60_000;
      emit(t, fileTime(ms), {
        occurred_at: isoTime(ms),
        kind: pick(o.kinds),
        value: Math.round(rnd() * 1000) / 10,
        note: chance(0.3) ? sentence([]).slice(0, 70) : undefined,
        ...(target ? { [o.link.col]: o.link.required || chance(0.7) ? link(pick(target)) : undefined } : {}),
      }, bodyOf(0.1, 120, 20, 600, 0, 1));
    }
    continue;
  }
  if (t.arch === "J") {
    for (let i = 0; i < t.count; i++) {
      const d = isoDate(TODAY - (i + 1) * DAY);
      emit(t, d, { date: d, mood: pick(["great", "good", "okay", "low", "bad"]), energy: int(1, 5), sleep_h: int(10, 18) / 2, people: chance(0.5) ? pickN(people, int(1, 3)).map(link) : undefined }, bodyOf(0.95, 1100, 150, 9000, 2, 8));
    }
    continue;
  }
  if (t.arch === "D") {
    const topics = names.get("lab.misc.topic");
    const sources = o.source ? names.get(o.source) : null;
    for (const n of names.get(t.q)) {
      const long = chance(0.02);
      emit(t, n, {
        title: n,
        kind: chance(0.9) ? pick(o.kinds) : undefined,
        status: skewed(o.statuses),
        ...(o.url ? { url: chance(0.9) ? `https://example.com/${t.name}/${seq()}` : undefined } : {}),
        ...(o.due ? { due: isoDate(randomDay(1, 60)) } : {}),
        ...(sources ? { source: chance(0.8) ? link(pick(sources)) : undefined } : {}),
        topics: chance(0.5) ? pickN(topics, int(1, 3)).map(link) : undefined,
        ...baseValues(),
      }, long ? text(lognormal(10000, 0.4, 6000, 30000), links(3, 10)) : bodyOf(t.name === "flashcard" ? 0.3 : 0.8, 600, 60, 6000, 0, 4));
    }
    continue;
  }
  if (t.arch === "A") {
    const target = o.link ? (o.link.ref === "work.planning.project" ? projectNames : names.get(o.link.ref)) : null;
    for (const n of names.get(t.q)) {
      const v = { name: n, kind: chance(0.9) ? pick(o.kinds) : undefined, status: skewed(o.statuses) };
      if (target) v[o.link.col] = o.link.required || chance(0.8) ? link(pick(target)) : undefined;
      for (const x of o.extra ?? []) {
        if (x.name === "code") v.code = `${t.name.slice(0, 3)}-${seq()}`;
        else if (x.type === "number") v[x.name] = chance(0.8) ? int(5, 50000) / 10 : undefined;
        else if (x.type === "date") v[x.name] = chance(0.8) ? isoDate(randomDay(4, 0)) : undefined;
        else if (x.name === "website") v.website = chance(0.7) ? `https://example.org/${seq()}` : undefined;
        else if (x.name === "city") v.city = chance(0.8) ? pick(CITIES) : undefined;
        else if (x.name === "version") v.version = `${int(0, 9)}.${int(0, 30)}.${int(0, 20)}`;
      }
      emit(t, n, { ...v, ...baseValues() }, bodyOf(0.5, 400, 60, 5000, 0, 3));
    }
    continue;
  }
}

// --- 3. plain notes ---------------------------------------------------------------------------------

const PLAIN_FOLDERS = [["Notes", 0.4], ["Inbox", 0.1], ["Reading", 0.15], ["Archive/2023", 0.1], ["Archive/2024", 0.1], ["Meetings", 0.1], ["Scratch", 0.05]];
for (const n of plainNames) {
  let r = rnd();
  let folder = PLAIN_FOLDERS[0][0];
  for (const [f, w] of PLAIN_FOLDERS) {
    if (r < w) {
      folder = f;
      break;
    }
    r -= w;
  }
  const fm = chance(0.5)
    ? frontmatter([
        ["tags", pickN(TAGS, int(1, 3))],
        ["created", isoDate(randomDay(5, 0))],
        ...(chance(0.2) ? [["aliases", [`${pick(WORDS)} ${pick(NOUNS)}`]]] : []),
        ...(folder === "Meetings" ? [["date", isoDate(randomDay(3, 0))], ["kind", pick(["kickoff", "review", "sync"])], ["attendees", pickN(people, int(1, 3)).map(link)]] : []),
      ])
    : "";
  const long = chance(0.02);
  writeNote(`${folder}/${n}.md`, fm + `# ${n}\n\n` + text(long ? lognormal(14000, 0.4, 8000, 40000) : lognormal(800, 0.9, 80, 12000), links(1, 8)));
}

// --- 4. the manifest -------------------------------------------------------------------------------------

const tables = T.map((t) => ({ table: t.q, arch: t.arch, rows: t.rows.length + (t.q === "work.planning.project" ? ANCHOR_AREAS.length : 0), folder: tableFolder(t) })).sort((a, b) => b.rows - a.rows);
const manifest = {
  notes: created + ANCHOR_AREAS.length,
  rows: tables.reduce((s, t) => s + t.rows, 0),
  plain: PLAIN,
  bytes,
  seed: SEED,
  databaseFolder: dbFolder,
  views: VIEWS.map((v) => v.name),
  bases: BASES.map((b) => b.name),
  anchors: ANCHOR_AREAS,
  tables,
  samples: {
    person: people.slice(0, 20),
    project: projectNames.slice(0, 20),
    task: names.get("work.planning.task").slice(0, 20),
    plain: plainNames.slice(0, 20).map((n) => n),
  },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`vault: ${manifest.notes} notes (${manifest.rows} rows in ${tables.length} tables, ${PLAIN} plain), ${(bytes / 1e6).toFixed(1)} MB, in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(`biggest: ${tables.slice(0, 5).map((t) => `${t.table} ${t.rows}`).join(", ")}; smallest: ${tables.slice(-3).map((t) => `${t.table} ${t.rows}`).join(", ")}`);
