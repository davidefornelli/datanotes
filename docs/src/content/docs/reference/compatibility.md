---
title: Compatibility
description: "How Datanotes numbers its versions, what counts as its public interface, and how to write clients that keep working."
sidebar:
  order: 5
---

Datanotes follows [semantic versioning](https://semver.org). The version number tells you what an update can change.

## Versions

- **Major** (4.0.0): can change or remove parts of the public interface. The release notes list those changes first, with what to do.
- **Minor** (3.1.0): adds to the public interface without breaking what works.
- **Patch** (3.0.1): fixes bugs and changes nothing you rely on.

The [release notes](/release-notes/) describe every version.

## The public interface

These parts of Datanotes follow the version rules:

- Operations, their arguments and their answer fields
- HTTP routes and headers
- Violation codes
- The commands the package installs (`datanotes` and `dnotes`), their options and their exit codes
- Environment variables and settings
- The words of `metastore.yaml`

These cases fall outside them:

- **Security fixes**: a fix can change a behavior. The release notes say so.
- **Bugs**: Datanotes fixes behavior that contradicts the documentation.
- **Undocumented behavior**: only what the docs describe is covered.
- **Messages**: the text of refusals and hints can improve in any version.
- **Node.js versions**: support follows the Node.js long-term support releases.

## Downgrade to 3.0

From 3.1, the engine writes the transaction log in segments by default. Datanotes 3.0 can’t read segments, so convert the log before you downgrade:

1. Stop the engine.
2. Convert every table’s log to one file per version:

   ```bash
   datanotes store convert-log --to files --vault ~/notes
   ```

3. Install Datanotes 3.0 and start it.

The command also sets `transactionLogFormat` to `files`, so a 3.1 engine started on the store again keeps writing files. [How the engine writes the log](/start/how-it-works/#how-the-engine-writes-the-log) describes both formats.

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

## How the tests check it

The repository keeps the public interface in `contract/datanotes-3.txt`. It has one line for every operation, argument, answer field, route, installed command, command option, environment variable, setting and violation code.

The test suite fails when a line goes or changes within a major version, so a breaking change cannot ship by accident. A second test checks every new name against the naming rules.
