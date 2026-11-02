---
title: Write a recipe
description: "A recipe is a specification an agent implements on your data: concepts, needs, constraints and acceptance checks, with a gallery of finished dishes for inspiration."
sidebar:
  order: 9
---

People keep their data their own way. Two databases rarely share table names, column names or habits, and both keep changing. So a recipe does not ship a schema. It ships a specification. Your agent implements it on the data you already have, with your names and your preferences.

A cookbook works like one for food. Each recipe tells you what you need and how to proceed. Next to it, the photo of a finished dish shows what to expect. In Datanotes the photo is a dish: a real result that someone cooked from the recipe, with its screenshots and its code.

## Know the words

- **Recipe:** a specification. It names concepts, needs, constraints and acceptance checks.
- **Dish:** a real result of a recipe, documented. It is a source of ideas, never a contract.
- **Gallery:** the dishes of a recipe.
- **Cookbook:** a git repository that holds several recipes.
- **Cook:** what an agent does with a recipe. It implements the recipe on your database, asks you what it cannot settle, and records where each concept lives.
- **Concept map:** the record of where each concept lives in your database, such as "a *Plan* is a task whose `kind` is `plan`". Apps read it, so they never write table names in their code.

## Lay out a cookbook

A cookbook holds one folder per recipe. Each recipe has its specification and its gallery.

```text
datanotes-cookbook/
  cookbook.md                # the recipes and what requires what
  recipes/
    tasks/
      recipe.md
      gallery/
        terminal-board/      # one folder per dish
          dish.md
          screenshots/
          extension/         # the code of the dish
          board-app/
    plans/
      recipe.md
      gallery/
```

Keep the recipes of one family in one cookbook. Split a recipe into its own repository only when it needs a life of its own. Another cookbook can then require it by URL.

## Write recipe.md

A recipe is Markdown with front matter. Write it for an agent that never saw your database.

```markdown
---
name: plans
version: 0.1.0
requires:
  task-runs: ">=0.1"
  task-sessions: ">=0.1"
---

## Concepts
- **Plan**: a task whose sub-tasks a planner wrote. Agents
  execute it. Extends the concept *Task* of `tasks`.

## Needs
- N1. WHEN the user opens a plan THE SYSTEM SHALL show its
  sub-tasks as waves, with who works on each.
- N2. A plan SHALL have one current session, the one executing it.

## Constraints
- C1. Only an agent writes or changes a plan.

## Acceptance
- A1. Ordering a plan into waves answers every open sub-task once.

## Ask the user
- Which of their tasks are plans today.
```

Follow these rules:

- **Concepts** carry meaning, never table or column names. A recipe may extend a concept of a recipe it requires, as *Plan* extends *Task*.
- **Needs** follow the EARS pattern: "WHEN <event> THE SYSTEM SHALL <behavior>". Number them, so plans and checks can cite them.
- **Constraints** say what must never happen.
- **Acceptance** says how the agent proves the result on real rows.
- **`requires`** names the recipes this one builds on, with a version range.
- **English** is the language of a cookbook. Quote what users say in English too, even when your users speak another language.

## Document a dish

A dish is a folder in the recipe's `gallery`. Its `dish.md` tells another cook what was made and how.

```markdown
---
recipe: plans
recipe_version: 0.1.0
cook: Claude Code
cooked_on: 2026-10-24
code: plan-view/, next to this file
---

## What it looks like
Screenshots, and what each one shows.

## Concept map
- Plan: personal.tasks.task where kind = plan
- Plan session: the last entry of task.sessions

## What was adapted, and why
## What the needs became
N1: a terminal graph of waves (plan-graph). N2: bind_session.
```

The code of the dish sits next to `dish.md`: the extension, the apps, the skills. A dish that cooks several recipes keeps its code in the dish of the first one, and the other dishes point to it.

A dish is a still copy of an app that is finished. Nothing runs from the cookbook: keep the code you use in your own repository, and copy it into the dish when it is done. Before you add it:

- Translate its strings, enum values and examples into English.
- Leave out people, places, employers and the names of your databases. Use invented names in examples.
- Capture the screenshots on an invented demo, not on your data.
- Name the dish folder after what you made, never after yourself.

A dish never constrains the next cook. It shows one way to get there.

## Cook a recipe

You ask an agent to cook a recipe. The agent works through these steps:

1. It reads the recipe and the recipes it requires. Then it reads the dishes of their galleries.
2. It looks for the concepts in your database: the tables, columns and values that already hold them. It checks them on real rows.
3. It asks you what it cannot settle, as the recipe lists.
4. It plans the implementation: schema changes with your yes, tools and apps, starting from a dish when one fits.
5. It implements and runs the acceptance checks.
6. It records the concept map and the recipe's version.

When a recipe changes, the agent compares the version you cooked with the new one. It proposes what fits your implementation, and asks you where the two disagree.
