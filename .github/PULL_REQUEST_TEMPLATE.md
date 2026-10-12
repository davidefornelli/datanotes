<!-- Thank you for contributing. Read CONTRIBUTING.md first. -->

## What and why

<!-- What this pull request changes, and why. Link the issue: "Closes #123". -->

## Checklist

- [ ] `npm run verify` passes on my machine.
- [ ] The public contract: nothing is removed or renamed. A new line in
      `contract/datanotes-3.txt` (`npm run contract:update`) has an approved issue, linked above.
- [ ] Docs: a new or changed operation or option has an example in `docs/examples/`, and the
      pages I changed follow the writing guidelines.
- [ ] Tests and docs use invented English names only, never real notes or personal data.
- [ ] AI use: I declare it below, and I understood and tested every change.

## AI use

<!-- Did you use AI tools to write this change? Which ones, and for what? Write "None" if not. -->

## Sensitive changes

<!--
Tick every box that applies. These files run code on maintainers' and contributors' machines or
in CI, so they get a closer review. Explain each change above.
-->

- [ ] `.claude/` (agent settings and hooks)
- [ ] `scripts/`
- [ ] The `scripts` of `package.json`
- [ ] `.github/` (workflows, templates, Dependabot)
