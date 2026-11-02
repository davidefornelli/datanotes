---
title: Browse and administer the database
description: "Browse and edit rows at /datanotes/ui/, change the structure and tokens, read the history, and change the engine's settings."
sidebar:
  label: Database browser
  order: 9
---

The engine serves a web application that browses and administers the database it runs. It is a client of the [HTTP API](/develop/http-api/), so it can do only what your token allows. It ships inside the engine: there is nothing to install or turn on.

## Open the browser

Open `/datanotes/ui/` on the engine's address. For an engine on the default port, open:

```text
http://127.0.0.1:27150/datanotes/ui/
```

`npm run dev` and `datanotes serve` print the address when they start. The browser is on whenever the HTTP server is, like the [API console](/develop/http-api/) at `/datanotes/docs`.

## Sign in with a token

The sign-in page takes the owner token or a [named token](/guides/security/tokens/). Paste it and select **Sign in**. The browser then shows only the screens that token may use.

The token stays in the tab until you close it. Tick **Remember on this browser** to keep it after the tab closes. Leave it off on a shared computer: anyone who uses that browser profile can then open the database.

When the engine refuses a saved token, the browser signs you out. That happens when someone rotates or deletes the token.

## Browse tables and rows

The sidebar shows the tree of the database: each catalog and schema, then its tables and views. Bases have their own list. Type in the filter box to find a table or a view by name.

A table or a view opens as a grid of rows:

- **Pages**: the engine sends 100 rows at a time, and the pager moves through the rest.
- **Filters and sort**: the filter builder writes the `where` of `select_rows`. Click a column heading to sort by it.
- **Live changes**: when another program writes rows of the table, the grid shows `N changes: refresh`. It never reloads under you.

The search box of the header searches the notes. A link to a note outside the tables opens a read-only viewer.

## Edit rows

Open a row to edit it. The editor has a form for the front matter and a text box for the Markdown body, with a preview. Every write has these features:

- **Check first**: **Check** runs the write as a dry run and shows what would change. **Save** writes it.
- **Refusals in place**: when the engine refuses a value, its message shows next to the field.
- **Undo**: after a write, the message that confirms it has an **Undo** button.
- **Automatic links**: the browser saves the text exactly as you typed it. Tick **Link the notes this text mentions** to link the notes it names.

The browser guards against concurrent edits. A save sends the values you changed, as you read them, and the body when you changed it. When a program or a hand edit changed them since, the engine refuses the save. You then choose **Reload (discard my edits)**, **Show current** or **Save anyway**. **Save anyway** writes your values over the other change, after a confirmation.

While the editor is open, a change by someone else shows as "Changed by", with a **Reload** button.

The grid also writes many rows at once. Select rows, then use **Set a column** or **Delete selected**.

## Change the structure

Open a table's structure from the grid. Its tabs show the columns, the constraints, the relations and the table's options. The relations tab shows the links to the table as well as the links from it.

Every schema operation has a form: create, alter, rename and drop tables, columns, constraints, views and bases. Each form previews the change with a dry run before it writes. A named token needs `ddl` for them: without it, the engine refuses the change and the form shows why.

**New table** and **New view** are at the bottom of the sidebar. A view's screen shows its query and a preview of its rows.

## Manage tokens and permissions

The owner manages the named tokens on the **Tokens** screen:

- **Create**: the engine shows the new token once. Copy it before you close the dialog.
- **Edit**: change the description, the `read` and `write` patterns, `ddl`, `maintain` and `autolink`.
- **Rotate**: the old value stops working at once.
- **Delete**: the token stops working at once. The journal keeps its name on the writes it made.

Each token shows when it was last used. While you edit patterns, the screen counts the tables the token would read and write.

The **Permission matrix** screen shows every table and view against every named token. The engine works out each cell, so the matrix matches what the engine allows. It also names the pattern that grants each permission.

A view whose tables are known only when it runs shows no read for a token with limited `read`. The answer marks such a view with `reads_complete: false`. Listings and the matrix hide that view from the token. [See what each token can reach](/guides/security/tokens/#see-what-each-token-can-reach) explains the rule.

## See users, sessions and tool calls

The users are the owner and the named tokens. The **Users and sessions** screen lists the agent sessions of each one. It reads them from the change feed of the last 7 days.

Each session shows its harness, model, tool calls, failed tool calls and row changes. Open a session to see its tool calls, with their arguments and results. A user's page also lists the user's writes from the journal.

## Read the history and undo

The history screens read the journal, the change feed and the transaction log:

- **Journal**: every write, newest first, with who made it: the token, the session and the model. Undo a write from here.
- **Change feed**: every change and tool call, filtered by table, kind, credential or session.
- **Table history**: the versions of a table. Compare two versions, browse the rows at a version, or restore one.
- **Database history**: restore every table to an earlier moment.

A restore is a new version. History is kept, and you can undo the restore from the journal.

## Administer the engine

The administration screens cover the database's configuration, webhooks, extensions, the engine's status and the semantic index. The **Status** screen is the owner's only.

The **Maintenance** screen checks tables, recomputes columns, aligns relations, and packs or unpacks rows. Two of its sections delete or rewind for good, so they work only after a preview:

- **Vacuum history** deletes transaction-log files older than a version.
- **Restore the database** brings every table with a log back to an earlier moment.

Each section works the same way:

1. Fill in the form: a table and an optional version, or a moment.
2. Select **Preview (dry run)**. The preview says what Apply would do.
3. Select **Apply**. It works only after a preview of the same table and version, or the same moment.

Any change to the form clears the preview. A preview that finds nothing to do leaves **Apply** off.

The confirmation of a vacuum names the number of log files and the version that time travel then starts at. Apply keeps exactly that version, even when a write came in after the preview. The confirmation of a restore names the moment, the tables and the rows that change.

You can undo a restore from the journal. A vacuum can't be undone.

## Change the engine's settings

The **Engine settings** screen is the owner's only. It lists every setting of the engine's settings file, with its value and default. Each setting has one of two badges:

- **at once**: the change applies from the next request or background job.
- **after a restart**: the engine saves the change now and uses it at its next start.

Change the values you want, then select **Check** to see what would change, or **Save**. The engine checks each value with the rules it uses to load the settings file. A refused value shows its reason next to the setting. **Default** puts one setting back to its default value.

Some changes ask for a confirmation first. A setting with a warning shows it in the dialog. An address that receives data asks you to type its host. These are `telemetryEndpoint`, `semanticBaseUrl` and `storeBackupRemote`.

### Secrets

You can replace a secret, but the browser never shows it:

- **The owner token**: **Replace the owner token** generates a new one, or takes one you type. Tick the box that says you copied it, then save.
- **Telemetry headers**: the screen shows each header's name, never its value.
- **Credentials in an address**: the screen shows the address without them. Keep the text as it is to keep them.

### Changes waiting for a restart

A banner lists the settings that wait for a restart. The **Restart the engine** panel applies them. Before you restart, the panel shows:

- **What the restart applies**: the settings that changed since the start, and hand edits of the settings file.
- **What still overrides a setting**: a start option of `datanotes serve`, such as `--port`, keeps winning over the setting.
- **The checks**: the engine refuses to restart when the next start would fail. A missing folder, a broken settings file, no owner token or a busy port stop it.

**Restart the engine** opens a dialog that says what happens, with the warnings. It also says what a failed start means for the way you run the engine.

After **Restart now**, the panel waits while requests under way finish, then while the engine starts again. When the engine is back, the page reloads the settings. A restart that changes the port shows the new address instead: open it to go on. A restart that changes the owner token signs you out: sign in with the new token.

The engine cancels a restart when a request still runs after 30 seconds. The panel then says why, and the engine goes on with its current settings. When the engine doesn't come back within 3 minutes, the panel says so and offers **Keep waiting**. [Restart the engine](/administration/run-the-service/#restart-the-engine) explains what a failed start does.

### Two editors at once

When someone else saved first, the screen shows a banner. Choose **Reload and keep my edits** or **Discard my edits**. When someone edited the settings file by hand while the engine runs, the screen can't save. Restart the engine to read those edits.

### Settings you change in the file only

`tableKey` and `transactionLogFormat` can't change over HTTP. The screen shows why and how to change each one. [Settings that need a restart](/administration/configuration/#settings-that-need-a-restart) lists them.

### The history of changes

Every change is a journal entry with the operation `set_engine_settings`, who made it, and the values before and after. **Changes of the settings** opens the journal on those entries. **Recent changes**, at the bottom of the screen, lists the last ones.

## Browse as another token

The owner can see the database as a named token sees it. Pick the token in **View as**, in the header. The engine then answers every read with that token's permissions.

A bar says `Viewing as <name>: read only.` The browser hides every write control, and the engine refuses every write. Select **Stop** to browse as the owner again.

[Browse as another token](/guides/security/tokens/#browse-as-another-token) explains the header the browser sends.

## Keep the browser safe

The browser's page is public, but it holds no data. Every call it makes needs a token. Follow these rules:

- **Where the token lives**: in the tab, or in the browser when you tick **Remember on this browser**. It never goes in a link or a cookie.
- **No cross-site request forgery**: the engine reads only the `Authorization` header and sets no cookies. Another site's page can't call the engine with your token.
- **Use a named token for daily browsing**: keep the owner token for administration.
- **Use HTTPS on another device**: publish the engine through a reverse proxy or `tailscale serve`.

Over plain HTTP from another machine, the browser isn't in a secure context. The **Copy** button can't reach the clipboard there: it selects the text, and you copy it yourself.

The page loads nothing from other hosts. It shows the HTML of a note as text, and blocks images from other hosts. [Security](/guides/security/security-model/) explains what the engine exposes on the network.

## Known limits

The browser has these limits:

- **One version**: a restart runs the same version of Datanotes. To update, stop the engine and start the new version.
- **File-only settings**: `tableKey` and `transactionLogFormat` change only in the settings file.
- **No file browser**: links to notes outside the tables open a read-only viewer. Attachments, such as images and PDFs, don't show.
- **No raw HTML or remote images**: a note's HTML shows as text, and images from other hosts are blocked.
- **No import wizard**: to adopt notes as rows, use `infer_table` and `adopt_rows` in the **Operations** console.
- **No offline use**: the browser needs the engine, and its layout targets a computer's screen.
- **Live updates by polling**: the browser asks the change feed for news, waiting up to 25 seconds. It doesn't use the change stream.
