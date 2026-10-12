/**
 * The relevance set of search_docs: questions an agent asks, each with the sections that answer it
 * (tests/docs-search-quality.test.ts runs them on the real docs). `top` is how high one of
 * `expect` must rank: 3 unless the case says otherwise.
 */
export interface SearchCase {
  query: string;
  expect: string[];
  top?: number;
}

export const SEARCH_CASES: SearchCase[] = [
  { query: "undo an agent's changes", expect: ["guides/agents/how-agents-use-datanotes#undo-what-an-agent-did", "guides/agents/prompts#undo-the-agents-last-change"], top: 2 },
  { query: "revert what the agent did", expect: ["guides/agents/how-agents-use-datanotes#undo-what-an-agent-did", "guides/agents/prompts#undo-the-agents-last-change"], top: 2 },
  { query: "filter rows by date", expect: ["guides/read-and-write/read-and-filter#filter-by-relative-dates", "guides/read-and-write/read-and-filter"] },
  { query: "rename a column", expect: ["guides/database-objects/columns#rename-a-column", "reference/operations/schema#rename_column"], top: 1 },
  { query: "allowed values of an enum", expect: ["guides/database-objects/columns#turn-an-enum-into-an-ordered-scale", "guides/database-objects/columns#describe-what-each-enum-value-means", "guides/database-objects/relations#take-allowed-values-from-another-table"] },
  { query: "check a rule across tables", expect: ["guides/data-quality/check-constraints#write-a-check-rule-that-follows-links", "guides/data-quality/check-constraints#enforce-rules-with-check-constraints"] },
  { query: "time travel a view", expect: ["guides/history/restore#time-travel-and-restore-the-whole-database", "guides/history/table-history#read-a-table-as-it-was"] },
  { query: "give my phone its own token", expect: ["guides/security/tokens#create-a-token", "start/connect-agents#give-each-agent-its-own-token", "guides/security/tokens"] },
  { query: "connect claude desktop", expect: ["start/connect-agents#connect-an-agent-on-your-computer"] },
  { query: "read the docs offline", expect: ["guides/agents/docs-offline", "start/connect-agents#read-the-docs-offline", "guides/agents/docs-offline#the-agent-reads-the-docs-of-its-version"], top: 1 },
  { query: "why was my write refused", expect: ["guides/agents/how-agents-use-datanotes#a-refusal-tells-the-agent-what-to-fix", "guides/data-quality/validation#see-how-the-engine-refuses-bad-values", "guides/agents/reading-errors", "guides/agents/reading-errors#every-error-has-a-message-a-hint-and-a-docs-link"] },
  { query: "undo a batch", expect: ["guides/read-and-write/batch#group-several-writes-with-batch", "guides/history/journal-and-undo#undo-a-write", "guides/history/restore#time-travel-and-restore-the-whole-database"] },
  { query: "import a folder of notes", expect: ["guides/agents/prompts#turn-a-folder-of-notes-into-a-table", "guides/read-and-write/import-notes#infer-a-table-from-notes", "guides/read-and-write/import-notes"] },
  { query: "add a CHECK constraint", expect: ["guides/data-quality/check-constraints#enforce-rules-with-check-constraints", "reference/operations/schema#add_constraint", "guides/agents/prompts#add-the-check-rated_when_watched"] },
  { query: "see what changed today", expect: ["guides/agents/prompts#ask-what-the-agent-changed-today"] },
  { query: "restore the database before the agent started", expect: ["guides/agents/prompts#put-everything-back-as-it-was-before-the-agent-started", "guides/history/restore#time-travel-and-restore-the-whole-database"], top: 2 },
  { query: "delete a row that other notes link to", expect: ["guides/database-objects/relations#delete-a-row-that-other-notes-link-to"], top: 1 },
  { query: "remove a column", expect: ["guides/database-objects/columns#drop-a-column-and-undo-the-drop", "reference/operations/schema#drop_column"] },
  { query: "save a query as a view", expect: ["guides/database-objects/views#store-a-query-as-a-view"], top: 1 },
  { query: "group rows and sum totals", expect: ["guides/read-and-write/joins-and-aggregates#group-rows-and-compute-totals"], top: 1 },
  { query: "run the engine in docker", expect: ["administration/docker#start-the-engine", "administration/docker"] },
  { query: "call a web address when a row changes", expect: ["guides/history/change-data-feed#push-changes-to-a-web-address-with-webhooks", "guides/history/change-data-feed"] },
  { query: "which token made a change", expect: ["guides/security/who-did-what#see-which-token-made-a-change"], top: 1 },
  { query: "default a date column to today", expect: ["guides/database-objects/columns#default-to-todays-date-or-the-current-time"] },
  { query: "insert or update a row", expect: ["guides/read-and-write/write-rows#insert-or-update-rows-with-merge_rows", "reference/operations/rows#merge_rows"] },
  { query: "rollback the agent's last change", expect: ["guides/agents/prompts#undo-the-agents-last-change", "guides/agents/how-agents-use-datanotes#undo-what-an-agent-did"], top: 2 },
  { query: "edit many rows at once", expect: ["guides/read-and-write/write-rows#update-many-rows"] },
  { query: "list the previous versions of a table", expect: ["guides/history/table-history#list-the-versions-of-a-table"], top: 1 },
  { query: "undo a dropped column", expect: ["guides/database-objects/columns#drop-a-column-and-undo-the-drop"], top: 1 },
  { query: "remove rows", expect: ["guides/read-and-write/write-rows#delete-rows-into-the-archive", "reference/operations/rows#delete_rows"] },
  { query: "copy a table to experiment", expect: ["guides/database-objects/tables#copy-a-table-to-try-changes", "reference/operations/schema#clone_table"], top: 1 },
  { query: "where clause operators", expect: ["guides/read-and-write/read-and-filter#compare-values-with-operators"] },
  { query: "creating tables with typed columns", expect: ["guides/database-objects/tables#create-a-table-with-typed-columns"], top: 1 },
  { query: "renaming tables", expect: ["guides/database-objects/tables#rename-or-move-a-table"] },
  { query: "check the engine status from a shell", expect: ["administration/status#check-the-status-from-a-shell", "administration/status"] },
  { query: "sync the vault with git", expect: ["administration/git-sync", "administration/git-sync#turn-on-git-sync"] },
  { query: "verify a webhook signature", expect: ["develop/change-feed-and-webhooks#receive-changes-with-a-webhook"] },
  { query: "what is in the first release", expect: ["release-notes#300", "release-notes"] },
  { query: "what is a base", expect: ["reference/glossary#base", "guides/database-objects/bases", "guides/database-objects/bases#share-columns-between-tables-with-bases"] },
];
