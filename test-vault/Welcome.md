# Test vault

A small vault for developing Datanotes. It is not a row of any table: a plain note.

The database is in `datanotes/metastore.yaml`: the catalog `work`, schema `planning`, with the
tables `person`, `project` (areas, projects and workstreams in a tree) and `task`, the base
`dated` and the views `vw_open_tasks`, `vw_engineering` and `vw_project_tasks` (for a project's
note). `Meetings/` holds notes that are not rows yet.

Regenerate it with `node scripts/make-test-vault.mjs` (after `npm run build:service`); never edit
the rows or the metastore by hand. See [[Website relaunch]] for a project.
