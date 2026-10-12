# datanote

Renamed: use [`datanotes`](https://www.npmjs.com/package/datanotes).

This package holds the former name of Datanotes on npm. It has no code.

```sh
npm install datanotes
```

Docs: https://datanotes.dev

## Publishing this placeholder

The owner publishes it by hand, once, from this folder. Never from the release workflow.

1. Sign in to npm as the owner of `datanotes`: `npm login`.
2. Check the contents: `npm pack --dry-run` lists only `package.json` and `README.md`.
3. Publish it: `npm publish --access public`.
4. Deprecate it: `npm deprecate datanote "Renamed: use datanotes"`.
