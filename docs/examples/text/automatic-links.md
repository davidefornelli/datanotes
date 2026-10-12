## What the engine links

The engine knows every note by its file name and its `aliases` property, rows and plain notes alike. It looks for these names in the text you write:

- **`insert_row`**: `body`
- **`update_row`**: `body`, `body_sections`, `body_prepend` and `body_append`, and only the text you pass
- **`update_rows`**: `body`
- **`batch`**: the same operations inside it

A mention becomes a link when all of these hold:

- **Whole words on one line**: case doesn’t matter for a name of two words or more, and the link keeps your spelling, as in `[[Cary Grant|cary grant]]`.
- **A capital for one word**: a one-word name links only when you write it with a capital, such as `House` for the note `House` or `house`.
- **Inside a sentence**: a one-word name at the start of a sentence, a line, a list item or a label isn’t linked. There every word has a capital, so the capital says nothing.
- **Standing alone**: a name glued to a path, a domain, an address or a snake_case word is part of it, as in `Documents/House/bill.pdf`, `greenmart.com` or `House_new`.
- **The first mention**: the note gets one link per body, and none when the body links it already.
- **Another note**: the engine never links the note you write.
- **A link target**: a row in a table’s archive folder is never one. Neither is a row of a table that isn’t a target, as the next section explains.
- **The longest name**: `Nora Wells` links the note `Nora Wells`, not the note `Nora`.

The engine leaves these parts of the text alone:

- **The front matter**, code blocks and inline code
- **Links**, web addresses, email addresses, tags, HyperText Markup Language (HTML), comments and math
- **Headings**: a heading’s text is the anchor that `body_sections` and `[[note#heading]]` links look for
- **Dataview inline fields**: a `key:: value` line, `[key:: value]` and `(key:: value)`
- **Templater blocks**: `<% ... %>`

It also skips names that would link ordinary words:

- **Short names**: fewer than three characters, such as `Al`
- **Numbers, dates and ids**: names without a letter, or named after a date, such as `2026-09-27`
- **Common words**: names such as `The`, `Index` or `Welcome`
- **Lowercase words**: a one-word mention in lowercase, such as `will` for the note `Will`

In a Markdown table, a link with an alias escapes its bar, as in `[[Cary Grant\|cary grant]]`. The engine treats a line as a table row when it has a bar outside links and code.

Each link has the form new links take in your vault, as seen from where the note ends up. A write that renames the note links from its new path. `links_added` lists each link. The links are part of the write. `dry_run` shows them before you write, and `undo_migration` takes them back.

## Which notes a link may point to

Plain notes are always link targets. A table decides for its rows with the option `autolink_target`:

- **Absent**: the rows are targets, unless the table names them by a date or a time. A table created with `time_column` names its rows that way, as do tables of meals, readings or events.
- **`true`**: the rows are targets, whatever their file names.
- **`false`**: the rows are never targets. Set it on a table of tasks, so an old task `Call Oscar` never takes the words `call Oscar` from the person `Oscar`.

Pass it to `create_table` or `alter_table`. `alter_table` with `"default"` goes back to the default.

## Writes from sync programs

A sync program writes text it copied from elsewhere, such as tasks, calendar events or receipts. That text should stay as it came. Give the program’s token `"autolink": false`, and its writes link nothing unless a write asks with `autolink: true`. [Tokens and permissions](/guides/security/tokens/#turn-automatic-links-off-for-a-sync-program) shows how.

## When the engine asks

The engine never guesses. It leaves a mention as text and lists it in `ambiguous_mentions` for one of these reasons:

- **`same_name`**: several notes have the name.
- **`adjacent`**: names of two notes stand side by side and may form one name. With the notes `Nora` and `Wells`, the text `Nora Wells` may name neither of them.
- **`overlap`**: names of two notes overlap, such as `New York` and `York City` in `New York City`.
- **`part_of_name`**: a capitalized word next to the name suggests a longer name, such as `Philadelphia` in `The Philadelphia Story`.
- **`sentence_start`**: a one-word name starts a sentence, a line, a list item or a label, such as `House` in `House: clean the bathroom`.

Each entry gives the mention as `text` and the notes it may name as `candidates`. It adds the line around it as `context`, and a `hint`. The other mentions of that name in the same text stay as text too. A `sentence_start` mention is the exception: a later mention of the name inside a sentence is linked. To resolve one:

1. Read the candidates with `read_note`.
2. Decide from the text which note the mention names, if any.
3. Write the link with `update_row` and `autolink: false`, or leave the text as it is.
