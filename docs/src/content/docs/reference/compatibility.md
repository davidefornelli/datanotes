---
title: Compatibility
description: "What Datanotes 3 promises: every 3.x version adds to what you use and never takes it away."
sidebar:
  order: 5
---

Datanotes 3 keeps working with your programs, scripts and vaults in every 3.x version. The number after the 3 only says how recent a release is: 3.1, 3.2, and on.

## The promise

What works in Datanotes 3 keeps working the same way in every 3.x version:

- Operations, their arguments and their answer fields
- HTTP routes and headers
- Violation codes
- Commands, their options and their exit codes
- Environment variables and settings
- The words of `metastore.yaml`

A new version can add to these. It never removes or renames them, and a name never changes meaning. When Datanotes needs a different behavior, it adds a new name. The old name keeps doing what it did.

For example, a program that calls `insert_row` with `table` and `values`, then reads `planned_creates`, works with every 3.x version. A later version can add an optional argument, a new answer field or a new operation, and the program doesn't notice.

These cases fall outside the promise:

- **Security fixes**: a fix can change a behavior. The release notes say so.
- **Bugs**: Datanotes fixes behavior that contradicts the documentation.
- **Undocumented behavior**: only what the docs describe is covered.
- **Messages**: the text of refusals and hints can improve in any version.
- **Node.js versions**: support follows the Node.js long-term support releases.

## Write tolerant clients

Answers can gain fields, and enums can gain values. Write your client to accept them:

- Ignore fields you don't know.
- Handle an enum value you don't know, for example as "other".
- Read refusals by their HTTP status, not by their text.

```ts
import { DatanotesClient } from "datanotes/client";

const db = new DatanotesClient({
  url: "http://127.0.0.1:27150",
  token: process.env.DATANOTES_TOKEN ?? "",
});

type Created = { planned_creates: string[] };

const r = await db.call("insert_row", {
  table: "film",
  values: { title: "Metropolis" },
});
// read the fields you need: new ones may appear
if (r.ok) console.log((r.value as Created).planned_creates);
```

## How Datanotes keeps it

The repository keeps the whole public contract in `contract/datanotes-3.txt`. It has one line for every operation, argument, answer field, route, command option, environment variable, setting and violation code.

The test suite fails when a line goes or changes, so a machine checks the promise. A second test checks every new name against the naming rules before it ships.
