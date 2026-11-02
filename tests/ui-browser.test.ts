/**
 * The database browser (`/datanotes/ui/`) in a real Chromium, against a real engine on a copy of the
 * test vault: sign-in, the tree, the grid and its filter, inline errors, undo, a CHECK, a token and
 * the permission matrix, the engine settings (a live change, a restart change, a hidden secret, a
 * conflict), the XSS guards of note bodies, and, in a second `describe` with an engine of its own, a
 * restart from the browser.
 *
 * The browser: `DATANOTES_UI_BROWSER`, else playwright-core's own Chromium when it is installed
 * (`npx playwright-core install chromium`), else a system Chromium or Chrome. With none the file is
 * skipped, unless `DATANOTES_UI_BROWSER_REQUIRED=1` (CI's ui-browser job): then it fails. In CI (the
 * variable CI set) it runs only with DATANOTES_UI_BROWSER_REQUIRED=1, which the ui-browser job sets.
 *
 * Every step waits for text, a role or the engine's state; none sleeps.
 */

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type ConsoleMessage, type Locator, type Page } from "playwright-core";
import { UI_CSP } from "../src/server/ui";
import { runService, type ServiceRun } from "../src/node/service";
import { copyTestVault, freePort, openTestVault, TOKEN, until, type TestVault } from "./helpers/test-vault";
import { seedStoreSettings } from "./helpers/store-settings";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NO_BROWSER = "no browser: set DATANOTES_UI_BROWSER or run npx playwright-core install chromium";

function findBrowser(): string | null {
  // a browser named by the variable is the only one tried: a wrong path means no browser
  const fromEnv = process.env.DATANOTES_UI_BROWSER;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  let own: string | null = null;
  try {
    own = chromium.executablePath();
  } catch {
    own = null;
  }
  for (const p of [own, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const executablePath = findBrowser();
const required = process.env.DATANOTES_UI_BROWSER_REQUIRED === "1";
// In CI only the ui-browser job runs this file (it sets DATANOTES_UI_BROWSER_REQUIRED=1): GitHub's
// Ubuntu runners also have Google Chrome, which would run it again in coverage and test-node
const otherCiJob = !!process.env.CI && process.env.CI !== "false" && !required;

if (!executablePath && required) {
  describe("database browser", () => {
    it("has a browser", () => {
      throw new Error(NO_BROWSER);
    });
  });
}

const run = executablePath && !otherCiJob ? describe : describe.skip;

const TASK = "work.planning.task";
const BUTTON_TASK = "datanotes/work/planning/task/Build the button component.md";

/**
 * The 4xx answers the main scenario asks for on purpose: refused writes (3.4, 3.5), a stale settings
 * version (3.7.5), and the restart route of an engine that cannot restart (3.7.6). A wrong token (3.2)
 * gets a 200 with `authenticated: false`, so any 401 fails "logged no console error, page error or CSP
 * violation", like any other 4xx.
 */
const EXPECTED_4XX: readonly RegExp[] = [
  /^422 \/datanotes\/operations\/(update_row|insert_row)\/$/,
  /^409 \/datanotes\/settings\/update\/$/,
  /^404 \/datanotes\/restart\/$/,
];

/** What the page reported that a test must never see. */
interface Problems {
  console: string[];
  page: string[];
  csp: string[];
}

function watch(page: Page, ignoreConsole: (m: ConsoleMessage) => boolean = () => false): Problems {
  const p: Problems = { console: [], page: [], csp: [] };
  page.on("console", (m) => {
    const text = m.text();
    if (text.includes("Content Security Policy")) p.csp.push(text);
    else if (m.type() === "error" && !ignoreConsole(m)) p.console.push(`${text} (${m.location().url})`);
  });
  page.on("pageerror", (e) => p.page.push(String(e)));
  return p;
}

/** An owner call to one of the engine's routes (POST /datanotes<route>). */
async function ownerFetch(url: string, route: string, body: Record<string, unknown> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/datanotes${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function settingValue(url: string, name: string): Promise<unknown> {
  const s = await ownerFetch(url, "/settings/");
  return (s.json.settings as { name: string; value: unknown }[]).find((v) => v.name === name)?.value;
}

/** The row of the settings table of one setting. */
function settingRow(page: Page, name: string): Locator {
  return page.locator("tr", { has: page.locator("th code", { hasText: new RegExp(`^${name}$`) }) });
}

async function signIn(page: Page, token: string): Promise<void> {
  await page.getByLabel("Token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Save on the settings screen; the confirmation's Save when one opens. */
async function saveSettings(page: Page, expectConfirm: boolean): Promise<void> {
  await page.locator(".settings-footer").getByRole("button", { name: "Save" }).click({ timeout: 5_000 });
  if (expectConfirm) {
    const dialog = page.getByRole("dialog", { name: "Change the engine's settings" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Save" }).click({ timeout: 5_000 });
  }
}

run("database browser in Chromium", () => {
  let v: TestVault;
  let url: string;
  let browser: Browser;
  let page: Page;
  let problems: Problems;
  const settingsBodies: string[] = [];
  const answers4xx: string[] = [];

  beforeAll(async () => {
    v = await openTestVault("service");
    url = v.client.url;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    page = await browser.newPage();
    page.on("response", (r) => {
      const status = r.status();
      if (status >= 400 && status < 500) answers4xx.push(`${status} ${new URL(r.url()).pathname}`);
    });
    // a refused call (a wrong token, a refused write, a stale settings version) is logged by
    // Chromium as "Failed to load resource: ... status of 4xx": the UI asks for those on purpose
    problems = watch(page, (m) => /^Failed to load resource: the server responded with a status of 4\d\d/.test(m.text()));
    page.on("response", async (r) => {
      if (!r.url().includes("/datanotes/settings")) return;
      try {
        settingsBodies.push(await r.text());
      } catch {
        // a redirect or a body already gone: nothing to keep
      }
    });
  });

  afterAll(async () => {
    // the browser first, then the engine: one failed step never skips the next ones
    try {
      await page?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        await v?.stop();
      }
    }
  });

  it("serves the page with its CSP, and the login form shows the version", async () => {
    const res = await page.goto(`${url}/datanotes/ui/`);
    expect(res?.status()).toBe(200);
    expect(res?.headers()["content-security-policy"]).toBe(UI_CSP);
    const version = (await (await fetch(`${url}/`)).json()) as { version: string };
    await page.getByRole("heading", { name: `Datanotes ${version.version}` }).waitFor();
  });

  it("refuses a wrong token, then opens the tree with the owner token", async () => {
    await signIn(page, "not-the-token");
    await page.getByText("The engine refused this token.").waitFor();
    await signIn(page, TOKEN);
    const tree = page.locator(".shell-tree");
    await tree.locator("summary", { hasText: /^work/ }).first().waitFor();
    await tree.locator("summary", { hasText: /^planning$/ }).waitFor();
    await tree.getByRole("link", { name: "task", exact: true }).waitFor();
  });

  it("opens the task grid and filters it like select_rows", async () => {
    const all = await v.ok<{ total: number }>("select_rows", { table: TASK, limit: 1 });
    await page.locator(".shell-tree").getByRole("link", { name: "task", exact: true }).click();
    await page.locator(".rows-total").filter({ hasText: `${all.total} rows` }).waitFor();

    const where = { status: { eq: "todo" } };
    const todo = await v.ok<{ total: number }>("select_rows", { table: TASK, where, limit: 1 });
    expect(todo.total).toBeGreaterThan(0);
    expect(todo.total).toBeLessThan(all.total);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("button", { name: "Add condition" }).click();
    await page.getByLabel("Column", { exact: true }).selectOption("status");
    await page.getByLabel("Operator").selectOption("eq");
    await page.getByLabel("Value").fill("todo");
    await page.locator(".rows-filter").getByRole("button", { name: "Apply" }).click();
    await page.locator(".rows-total").filter({ hasText: new RegExp(`^${todo.total} rows?$`) }).waitFor();
    expect(await page.locator(".ui-table tbody tr").count()).toBe(todo.total);
  });

  it("shows the engine's refusal next to the field, saves, and undoes", async () => {
    await page.goto(`${url}/datanotes/ui/#/row/${encodeURIComponent(TASK)}?path=${encodeURIComponent(BUTTON_TASK)}`);
    const field = page.locator(".rows-field", { has: page.locator(".rows-field-name", { hasText: /^estimate_h$/ }) });
    const input = field.locator("input");
    await expect.poll(() => input.inputValue()).toBe("12");
    const link = page.getByLabel("Link the notes this text mentions");
    expect(await link.isChecked()).toBe(false);

    await input.fill("200");
    const first = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/datanotes/operations/update_row/");
    await page.locator(".rows-form-buttons").getByRole("button", { name: "Save" }).click();
    expect(JSON.parse((await first).postData() ?? "{}")).toMatchObject({ autolink: false });
    await field.locator(".ui-field-error", { hasText: "must be <= 80" }).waitFor();
    expect(v.read(BUTTON_TASK)).toContain("estimate_h: 12");

    await input.fill("10");
    await page.locator(".rows-form-buttons").getByRole("button", { name: "Save" }).click();
    const toast = page.locator(".ui-toast", { hasText: "Saved" });
    await toast.waitFor();
    await until(() => v.read(BUTTON_TASK).includes("estimate_h: 10"), 5000, "estimate_h 10 written");
    await toast.getByRole("button", { name: "Undo" }).click();
    await page.locator(".ui-toast", { hasText: "Undone" }).waitFor();
    const row = await v.ok<{ rows: { estimate_h: number }[] }>("select_rows", { table: TASK, where: { path: BUTTON_TASK } });
    expect(row.rows[0]!.estimate_h).toBe(12);
  });

  it("names the CHECK a new row breaks, and writes nothing", async () => {
    const before = v.files();
    await page.goto(`${url}/datanotes/ui/#/new-row/${encodeURIComponent(TASK)}`);
    const link = page.getByLabel("Link the notes this text mentions");
    expect(await link.isChecked()).toBe(false);
    const field = (name: string) => page.locator(".rows-field", { has: page.locator(".rows-field-name", { hasText: new RegExp(`^${name}$`) }) });
    await field("title").locator("input").fill("A browser task without a date");
    await field("project").locator("input").fill("[[Design system]]");
    await field("status").locator("select").selectOption("done");
    const isInsert = (r: { method(): string; url(): string }) =>
      r.method() === "POST" && new URL(r.url()).pathname === "/datanotes/operations/insert_row/";
    const first = page.waitForRequest(isInsert);
    await page.locator(".rows-form-buttons").getByRole("button", { name: "Insert" }).click();
    expect(JSON.parse((await first).postData() ?? "{}")).toMatchObject({ autolink: false });
    await page.locator(".rows-checks", { hasText: "done_has_date" }).waitFor();

    await link.check();
    const second = page.waitForRequest(isInsert);
    await page.locator(".rows-form-buttons").getByRole("button", { name: "Insert" }).click();
    expect(JSON.parse((await second).postData() ?? "{}")).toMatchObject({ autolink: true });
    await (await second).response();
    await page.locator(".rows-checks", { hasText: "done_has_date" }).waitFor();
    expect(v.files()).toEqual(before);
  });

  it("creates a token and shows what it may do in the matrix", async () => {
    await page.goto(`${url}/datanotes/ui/#/tokens`);
    await page.getByRole("button", { name: "New token" }).click();
    const form = page.getByRole("dialog", { name: "New token" });
    await form.getByLabel("Name").fill("browser-test");
    await form.getByLabel("Description").fill("The browser test's token");
    await form.getByLabel("Only these").check();
    await form.getByLabel("Read patterns, one per line").fill("work.planning.*");
    await form.getByLabel("Write patterns, one per line").fill(TASK);
    await form.getByRole("button", { name: "Create" }).click();
    const secret = page.getByRole("dialog", { name: "Token browser-test" });
    await secret.getByText("Copy it now.").waitFor();
    await secret.getByRole("button", { name: "I copied it" }).click();
    await page.getByRole("link", { name: "browser-test", exact: true }).waitFor();

    await page.goto(`${url}/datanotes/ui/#/matrix`);
    await page.getByLabel("Token", { exact: true }).selectOption("browser-test");
    const cell = async (object: string): Promise<string | null> => {
      const row = page.locator("tr", { has: page.locator("td code", { hasText: new RegExp(`^${object}$`) }) });
      if ((await row.count()) === 0) return null;
      // the cells: owner, then browser-test
      return (await row.locator("button.tokens-cell").last().innerText()).trim();
    };
    await page.locator("td code", { hasText: /^task$/ }).waitFor();
    expect(await cell("task")).toBe("RW");
    expect(await cell("person")).toBe("R");
    expect(await cell("vw_open_tasks")).toBe("R");
    // views whose reads are known only when they run: the engine hides them from limited tokens
    for (const view of ["vw_engineering", "vw_project_tasks"]) expect(await cell(view)).not.toBe("R");
  });

  describe("engine settings", () => {
    it("never shows the owner token: Replace… and no value", async () => {
      await page.goto(`${url}/datanotes/ui/#/settings`);
      const row = settingRow(page, "httpServerToken");
      await row.getByRole("button", { name: "Replace…" }).waitFor();
      expect(await row.innerText()).not.toContain(TOKEN);
      expect(await page.locator("body").innerText()).not.toContain(TOKEN);
    });

    it("applies a live setting at once and journals it as the UI", async () => {
      await settingRow(page, "logRetentionDays").locator("input").fill("45");
      await page.locator(".settings-footer").getByRole("button", { name: "Check" }).click();
      await page.getByText("Applies at once: logRetentionDays").waitFor();
      await saveSettings(page, false);
      await page.locator(".ui-toast", { hasText: "Saved:" }).waitFor();
      // a new edit while the toast shows: the footer's Save stays reachable (the toasts sit above it)
      await settingRow(page, "logRetentionDays").locator("input").fill("44");
      expect(await page.locator(".ui-toast", { hasText: "Saved:" }).isVisible()).toBe(true);
      await page.locator(".settings-footer").getByRole("button", { name: "Save" }).click({ trial: true, timeout: 2_000 });
      await page.locator(".settings-footer").getByRole("button", { name: "Discard" }).click();
      expect(await settingValue(url, "logRetentionDays")).toBe(45);
      const journal = await v.ok<{ migrations: { actor?: { harness?: string } }[] }>("list_migrations", { op: "set_engine_settings" });
      expect(journal.migrations.some((m) => m.actor?.harness === "datanotes-ui")).toBe(true);
    });

    it("shows a restart setting as waiting, until it is set back", async () => {
      const select = settingRow(page, "vaultIndexEnabled").locator("select");
      await select.selectOption("false");
      await saveSettings(page, true);
      const banner = page.locator(".settings-info", { hasText: "Waiting for a restart" });
      await banner.filter({ hasText: "vaultIndexEnabled" }).waitFor();
      await select.selectOption("true");
      await saveSettings(page, true);
      await banner.waitFor({ state: "detached" });
    });

    it("never sends a header's value back", async () => {
      const row = settingRow(page, "telemetryHeaders");
      await row.getByRole("button", { name: "Add header" }).click();
      await row.getByLabel("Header name").fill("X-Api-Key");
      await row.getByLabel("Header value").fill("SENTINEL-UI-H");
      await saveSettings(page, false);
      await page.locator(".ui-toast", { hasText: "Saved: 1 apply at once" }).first().waitFor();
      await until(async () => JSON.stringify(await settingValue(url, "telemetryHeaders")).includes("X-Api-Key"), 5000, "the header saved");
      await page.reload();
      await settingRow(page, "telemetryHeaders").locator("code", { hasText: "X-Api-Key" }).waitFor();
      expect(await page.locator("body").innerText()).not.toContain("SENTINEL-UI-H");
      expect(await page.content()).not.toContain("SENTINEL-UI-H");
      expect(settingsBodies.length).toBeGreaterThan(0);
      for (const body of settingsBodies) expect(body).not.toContain("SENTINEL-UI-H");
    });

    it("keeps my edits after someone else's change, and names the one dropped", async () => {
      // the page is open (since the reload above); someone changes the setting meanwhile
      await settingRow(page, "logRetentionDays").locator("input").waitFor();
      const s = await ownerFetch(url, "/settings/");
      const changed = await ownerFetch(url, "/settings/update/", { expect_version: s.json.settings_version, changes: { logRetentionDays: 50 } });
      expect(changed.status).toBe(200);

      await settingRow(page, "logRetentionDays").locator("input").fill("60");
      await saveSettings(page, false);
      await page.getByText("Someone changed the settings since you opened this page.").waitFor();
      await page.getByRole("button", { name: "Reload and keep my edits" }).click();
      await page.locator(".settings-info", { hasText: "your edit was dropped: logRetentionDays" }).waitFor();
      expect(await settingValue(url, "logRetentionDays")).toBe(50);
    });

    it("says this engine cannot restart itself from here", async () => {
      await page.locator(".settings-restart").getByText("This engine cannot restart itself from here").waitFor();
    });
  });

  it("renders a hostile note body without running any of it", async () => {
    const body = ['<img src=x onerror="window.__xss=1">', "", "[c](javascript:window.__xss=2)", "", '[[x" onmouseover="window.__xss=3]]', ""].join("\n");
    const inserted = await v.ok<{ planned_creates: string[] }>("insert_row", {
      table: TASK,
      values: { title: "A hostile body", project: "[[Design system]]", status: "todo" },
      body,
      autolink: false,
    });
    const path = inserted.planned_creates[0]!;
    await page.goto(`${url}/datanotes/ui/#/row/${encodeURIComponent(TASK)}?path=${encodeURIComponent(path)}`);
    await page.getByRole("heading", { name: "A hostile body" }).waitFor();
    await page.getByRole("tab", { name: "Preview" }).click();
    const md = page.locator(".markdown");
    await md.waitFor();
    for (const a of await md.locator("a").all()) {
      await a.hover();
      await a.click();
    }
    // a click on an in-app link may leave the row: whatever it opened, nothing ran
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
    await page.goto(`${url}/datanotes/ui/#/row/${encodeURIComponent(TASK)}?path=${encodeURIComponent(path)}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    await md.waitFor();
    expect(await md.locator("a").count()).toBeGreaterThan(0);
    expect(await page.locator("[onerror], [onmouseover]").count()).toBe(0);
    const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    expect(hrefs.filter((h) => /^\s*javascript:/i.test(h))).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  });

  it("logged no console error, page error or CSP violation", () => {
    expect(problems).toEqual({ console: [], page: [], csp: [] });
    expect(answers4xx.filter((a) => !EXPECTED_4XX.some((re) => re.test(a)))).toEqual([]);
  });
});

run("database browser in Chromium: restart from the browser", () => {
  let root: string;
  let svc: ServiceRun;
  let url: string;
  let browser: Browser;
  let page: Page;
  let problems: Problems;

  beforeAll(async () => {
    root = copyTestVault();
    const port = await freePort();
    seedStoreSettings(root, { httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false, autoRecompute: false });
    svc = await runService({ vault: root, watch: "poll", pollMs: 200, httpWaitMs: 10_000 }, {}, { startedBy: "unknown" });
    url = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    page = await browser.newPage();
    // while the engine is down, every call fails to load: expected here, and only here
    problems = watch(page, (m) => m.text().startsWith("Failed to load resource"));
    await page.goto(`${url}/datanotes/ui/`);
    await signIn(page, TOKEN);
    await page.locator(".shell-tree").getByRole("link", { name: "task", exact: true }).waitFor();
    await page.goto(`${url}/datanotes/ui/#/settings`);
  });

  afterAll(async () => {
    // the browser first, then the engine, then the vault copy: one failed step never skips the next ones
    try {
      await page?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await svc?.stop();
        } finally {
          if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    }
  });

  it("shows a restart setting as waiting", async () => {
    await settingRow(page, "vaultIndexEnabled").locator("select").selectOption("false");
    await saveSettings(page, true);
    await page.locator(".settings-restart").getByText("Waiting for a restart: vaultIndexEnabled.", { exact: true }).waitFor();
  });

  it("restarts the engine and comes back to the same process", async () => {
    const before = await ownerFetch(url, "/status/");
    await page.getByRole("button", { name: "Restart the engine…" }).click();
    const dialog = page.getByRole("dialog", { name: "Restart the engine" });
    await dialog.getByText("It applies: vaultIndexEnabled.", { exact: true }).waitFor();
    await dialog.getByText("Whatever started it decides whether it starts again").waitFor();
    // the waiting text may last less than a poll of Playwright's (a fast restart): an observer in the
    // page records whether it was shown
    await page.evaluate(() => {
      const w = window as unknown as { __sawProgress?: boolean };
      w.__sawProgress = false;
      new MutationObserver(() => {
        if (document.querySelector(".settings-progress")?.textContent?.includes("Restarting the engine")) w.__sawProgress = true;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await dialog.getByRole("button", { name: "Restart now" }).click();
    await page.locator(".ui-toast", { hasText: "The engine restarted" }).waitFor({ timeout: 60_000 });
    expect(await page.evaluate(() => (window as unknown as { __sawProgress?: boolean }).__sawProgress)).toBe(true);
    await page.locator(".settings-info", { hasText: "Waiting for a restart" }).waitFor({ state: "detached" });
    expect(svc.restarts).toBe(1);
    const after = await ownerFetch(url, "/status/");
    expect(after.json.engine.started_at).not.toBe(before.json.engine.started_at);
    expect(after.json.engine.pid).toBe(before.json.engine.pid);
  });

  it("loads the grid from the new engine without a reload", async () => {
    const all = (await ownerFetch(url, "/operations/select_rows/", { table: TASK, limit: 1 })).json as { total: number };
    await page.locator(".shell-tree").getByRole("link", { name: "task", exact: true }).click();
    await page.locator(".rows-total").filter({ hasText: `${all.total} rows` }).waitFor();
  });

  it("logged no page error or CSP violation", () => {
    expect(problems).toEqual({ console: [], page: [], csp: [] });
  });
});
