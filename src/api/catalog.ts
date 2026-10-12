/**
 * The operations of the HTTP API, described for their callers: name, description, input schema
 * and hints. The MCP server (`datanotes mcp`, src/mcp) offers each one as a tool of the same name
 * (the shape is MCP's tool definition); the OpenAPI document and the docs are generated from it. The route and body each
 * one sends: `requests.ts`.
 */

export interface OperationDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCP tool hints (not part of the Datanotes 3 contract). `destructiveHint` is true for every
   * write that may overwrite or remove existing data (values, names, definitions, settings, history)
   * or send it out of the engine (webhooks); false only for reads and purely additive writes
   * (tests/api-mcp.test.ts holds the list).
   */
  annotations: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** JSON Schema of the successful (2xx) response body, for the OpenAPI document; not sent to MCP clients. */
  responseSchema?: Record<string, unknown>;
  /**
   * Secrets in the call: the argument names and result keys never recorded (the change feed's
   * `tool_call` events, which the store backup commits). `redactToolCall` (redact.ts) applies it.
   */
  sensitive?: { args?: string[]; result?: string[] };
}

export const OPERATIONS: OperationDef[] = [
  {
    "name": "read_note",
    "description": "Read a note or another file of the vault: `{path, content, front_matter, tags, modified_at,\ncreated_at, size}`. `content` is the whole text, front matter included; `tags` are without `#`,\nfrom the text and the front matter; the times are in the database's time zone. A missing file is\nan error. `path`: vault-relative, forward slashes.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "path": {
          "type": "string",
          "description": "The file's vault path, with its extension (\"Films/Metropolis.md\")."
        }
      },
      "required": [
        "path"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Read Note",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "description": "A file of the vault with its front matter and tags.",
      "properties": {
        "path": {
          "type": "string",
          "description": "Vault path."
        },
        "content": {
          "type": "string",
          "description": "The whole text, front matter included."
        },
        "front_matter": {
          "type": "object",
          "description": "Parsed front matter (empty without one).",
          "additionalProperties": true
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags (without #), in the text and in the front matter."
        },
        "modified_at": {
          "type": [
            "string",
            "null"
          ],
          "description": "Last change, in the database's time zone."
        },
        "created_at": {
          "type": [
            "string",
            "null"
          ],
          "description": "Creation, in the database's time zone."
        },
        "size": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Size in bytes."
        }
      },
      "required": [
        "path",
        "content",
        "front_matter",
        "tags",
        "modified_at",
        "created_at",
        "size"
      ]
    }
  },
  {
    "name": "list_folder",
    "description": "The direct children of a vault folder: `{folder, folders, files}`, each a vault path, sorted;\ndot-files and dot-folders are left out. `folder` \"\" is the vault root. A missing folder is an\nerror.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "folder": {
          "default": "",
          "type": "string",
          "description": "Vault-relative folder; \"\" is the vault root."
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "List Folder",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "folder": {
          "type": "string",
          "description": "The folder listed (\"\" is the vault root)."
        },
        "folders": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Its sub-folders, as vault paths, sorted."
        },
        "files": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Its files, as vault paths, sorted."
        }
      },
      "required": [
        "folder",
        "folders",
        "files"
      ]
    }
  },
  {
    "name": "search_notes",
    "description": "Plain-text search: every word of `query` must occur, case- and accent-insensitive, in the\nnote's path or text; there are no operators. Returns `{query, results: [{path, score, matches:\n[{start, end, context}]}], total}`, best first: at most 200 notes (`total` counts them all) and 20\nmatches per note. `context_length`: characters of context on each side (default 100, max 1000).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "query": {
          "type": "string"
        },
        "context_length": {
          "default": 100,
          "type": "integer",
          "description": "Characters of context on each side of a match (at most 1000)."
        }
      },
      "required": [
        "query"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Search Notes",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string"
        },
        "results": {
          "type": "array",
          "description": "Matching notes, best first (at most 200).",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path of the note."
              },
              "score": {
                "type": "number",
                "description": "Matches plus 5 per query word in the path."
              },
              "matches": {
                "type": "array",
                "description": "Up to 20 matches.",
                "items": {
                  "type": "object",
                  "properties": {
                    "start": {
                      "type": "integer",
                      "description": "Where the words start in the text."
                    },
                    "end": {
                      "type": "integer"
                    },
                    "context": {
                      "type": "string",
                      "description": "Text around the match."
                    }
                  },
                  "required": [
                    "start",
                    "end",
                    "context"
                  ]
                }
              }
            },
            "required": [
              "path",
              "score",
              "matches"
            ]
          }
        },
        "total": {
          "type": "integer",
          "description": "Notes that match, all of them."
        }
      },
      "required": [
        "query",
        "results",
        "total"
      ]
    }
  },
  {
    "name": "list_tables",
    "description": "List every table: `name`, `catalog`, `schema`, `qualified` (`personal.metrics.mood` — use it\nwherever a table is expected; `metrics.mood` or `mood` also work when unambiguous), `path` and,\nwhen declared, `description`, `aliases` (other words for what it records) and `tags`. Tables are\ndefined in `metastore.yaml` (catalog → schema → table): read it freely, but it is read-only for\nagents and changes only through the schema operations (create_table, add_column, …). Returns `{tables, views}`: `views` lists the stored views (same fields, no\npath): select them like tables. `system.information_schema` is read with `select_rows`.\n\nCall this first to find the table for what the user reports (match their words against\nname, description and aliases), and before creating tables or columns so you reuse existing\nones instead of creating duplicates.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "annotations": {
      "title": "List Tables",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "tables": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "catalog": {
                "type": "string"
              },
              "schema": {
                "type": "string"
              },
              "qualified": {
                "type": "string",
                "description": "Unambiguous name: catalog.schema.table."
              },
              "description": {
                "type": "string",
                "description": "What the table records."
              },
              "aliases": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "tags": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                },
                "description": "Key/value labels of the table (alter_table `tags`), when it has any."
              }
            },
            "required": [
              "name",
              "catalog",
              "schema",
              "qualified"
            ]
          },
          "description": "Every table."
        },
        "views": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "catalog": {
                "type": "string"
              },
              "schema": {
                "type": "string"
              },
              "qualified": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "aliases": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "name",
              "catalog",
              "schema",
              "qualified"
            ]
          },
          "description": "Every view."
        }
      },
      "required": [
        "tables",
        "views"
      ]
    }
  },
  {
    "name": "describe_table",
    "description": "Describe a table (`catalog.schema.table` or a shorter unambiguous name): `qualified`, `name`,\n`catalog`, `schema`, `description`, `aliases`, `layout` (`folder`, `row_folder`: the folder pattern\nof new rows, `archive`), `options` (`partition`, `filename`, `archive`, `exclude`), typed `columns`\nwith label/aliases/description and the dense flag, `untyped_fields`, `row_count`, and when set:\n`tags`, `bases` (the bases it inherits from, in order), `constraints` (its CHECKs, name → where), `row_template`, `history`,\n`autolink_target`, `fields` (their values).\n\nBefore adding a column (e.g. a new metric), read `columns` and match your concept against\n`name`, `label`, `aliases` and `description`; reuse an existing column when it means the same.\n\n`missing_descriptions` (`{table, columns}`), present only when something has no description (a table\ndefined before descriptions were required), names what lacks one: write them with alter_table\n`description` and alter_column `changes.description`, asking the user when the meaning is unclear.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Describe Table",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "description": "The table's definition with its qualified name and row count.",
      "properties": {
        "name": {
          "type": "string"
        },
        "schema": {
          "type": "string"
        },
        "catalog": {
          "type": "string"
        },
        "description": {
          "type": "string",
          "description": "What a row of the table records."
        },
        "aliases": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Other words for what the table records, for agents."
        },
        "layout": {
          "type": "object",
          "properties": {
            "folder": {
              "type": "string",
              "description": "Folder of the table's rows."
            },
            "row_folder": {
              "type": "string",
              "description": "Folder pattern of new rows: the table folder, plus its partition."
            },
            "archive": {
              "type": "string",
              "description": "Archive folder."
            }
          },
          "required": [
            "folder",
            "row_folder",
            "archive"
          ],
          "additionalProperties": true
        },
        "options": {
          "type": "object",
          "description": "The table options set on it: partition, filename, archive, exclude.",
          "additionalProperties": true
        },
        "columns": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "type": {
                "type": "string",
                "description": "Column type (string, number, integer, boolean, date, datetime, enum, link, list, …)."
              },
              "items": {
                "type": "string",
                "description": "Element type of a list column."
              },
              "required": {
                "type": "boolean"
              },
              "default": {
                "description": "Default value."
              },
              "min": {
                "type": "number"
              },
              "max": {
                "type": "number"
              },
              "step": {
                "type": "number"
              },
              "values": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Allowed values of an enum."
              },
              "value_descriptions": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                }
              },
              "ref": {
                "type": "string",
                "description": "Target table of a link column."
              },
              "inverse": {
                "type": "string"
              },
              "ref_where": {
                "type": "object",
                "description": "Link column: the where filter every linked row must match.",
                "additionalProperties": true
              },
              "ref_by": {
                "type": "object",
                "description": "Link column: the row's column that picks the targets' level: {column, target_column?, levels?, map} (map always expanded: value -> null for a top level, or the allowed target values).",
                "additionalProperties": true
              },
              "description": {
                "type": "string"
              },
              "aliases": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "unique": {
                "type": "boolean"
              },
              "identity": {
                "type": "string",
                "enum": [
                  "filename",
                  "uuid",
                  "created"
                ]
              },
              "generated": {
                "type": "string",
                "description": "Expression of a generated column."
              },
              "dense": {
                "type": "boolean",
                "description": "Written on every row (with its default)."
              }
            },
            "required": [
              "name",
              "type",
              "required",
              "aliases",
              "dense"
            ],
            "additionalProperties": true
          },
          "description": "Declared columns."
        },
        "untyped_fields": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Table defaults without a column (written on every new row), and the `table` front matter key."
        },
        "qualified": {
          "type": "string",
          "description": "catalog.schema.table"
        },
        "row_count": {
          "type": "integer",
          "description": "Rows in the table."
        },
        "tags": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "description": "Key/value labels of the table (alter_table `tags`), when it has any."
        },
        "missing_descriptions": {
          "title": "MissingDescriptions",
          "type": "object",
          "description": "What has no description, when something has none (a table defined before descriptions were required): fill them with alter_table and alter_column.",
          "properties": {
            "table": {
              "type": "boolean",
              "description": "True when the table itself has no description."
            },
            "columns": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "The columns without a description."
            }
          },
          "required": [
            "table",
            "columns"
          ]
        },
        "bases": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "The bases it inherits columns from, in order."
        },
        "constraints": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "additionalProperties": true
          },
          "description": "Its CHECK constraints: name → the where every row must match."
        },
        "row_template": {
          "type": "string",
          "description": "The text of every new row's note."
        },
        "history": {
          "type": "boolean",
          "description": "Its own history setting (absent: the database's)."
        },
        "autolink_target": {
          "type": "boolean",
          "description": "Its own autolink_target setting (absent: the default)."
        },
        "fields": {
          "type": "object",
          "additionalProperties": true,
          "description": "Front matter keys every new row gets, with their values."
        }
      },
      "required": [
        "name",
        "schema",
        "layout",
        "options",
        "columns",
        "untyped_fields",
        "qualified",
        "row_count"
      ],
      "additionalProperties": true
    }
  },
  {
    "name": "create_table",
    "description": "Create a table: `name`, in `catalog` and `schema` (default: the database's defaults); the definition\ngoes in metastore.yaml, the rows in `<root>/<catalog>/<schema>/<name>/`. Names: lowercase letters,\ndigits, `_` (no dots: pass the catalog and the schema as their own arguments).\n- `description` (required): what a row of the table records. Every column needs its own `description`\n  too, what it holds: the table is refused otherwise, with every missing one listed. Descriptions are how\n  agents and people understand the schema, so write them for a reader who never saw the notes. The\n  engine writes those of `id` and of `identity` \"uuid\" / \"created\" columns.\n- `columns`: specs like `{\"name\": \"kind\", \"type\": \"enum\", \"values\": [\"a\",\"b\"], \"required\": true,\n  \"description\": \"What kind of entry the row is\"}`.\n  Types: string, integer, number, boolean, date, datetime, enum, link, list (+ `items`), json.\n  Attributes: required, default (`\"{now}\"`/`\"{today}\"`), min, max, step, values, `ordered` (enum in\n  order: filters/avg use the position), ref (link target, full `catalog.schema.table` or \"self\"),\n  unique, label, description, aliases, `generated` (e.g. `\"date(occurred_at)\"`, `\"{name} {surname}\"`),\n  `identity` (\"filename\" | \"created\"), `vocabulary` (allowed values = names of another table's rows),\n  `hierarchy: true` (one parent link to its own table), `dense` (written on every row),\n  `inverse` on a link column: the column of the `ref` table that links back (`friends` ↔\n  `friends`, `children` ↔ `parents`, `partner` ↔ `partner`); writes keep both sides in step.\n- `time_column`: rows named by that date/datetime; otherwise `filename` (e.g. `\"{name}\"`).\n- The table's options, as alter_table names them: `aliases` (how agents find it, with the\n  description), `partition`, `exclude`, `archive`, `history` (keep its versions; default: the\n  database's setting), `autolink_target` (true / false: may automatic links link its rows? default:\n  yes, unless its rows are named by a date or a time, as with `time_column`).\n- `row_template`: markdown body of new rows. Shared columns come from bases: `set_table_bases`.\n- `tags`: key/value labels of the table, strings (`{\"domain\": \"health\"}`); list_tables and\n  describe_table return them, alter_table changes them.\nEnum columns: `values` and, for each, its meaning in `value_descriptions` (`{\"stated\": \"the user said it\", …}`): describe_table shows them and a refused value lists them.\nGenerated link columns: `generated: \"link({occurred_at:YYYY-MM-DD})\"` with `ref` = the days table links each row to the row of `ref` named by the template (its folder read from the schema; the target may not exist yet).\nFiltered link targets (link columns): `ref_where` (a `where` every target must match) and `ref_by` (a column of the row picks the target level: `{\"column\": \"kind\", \"levels\": [\"area\", \"project\", \"workstream\"]}` or `{\"column\": \"kind\", \"map\": {\"area\": null, \"project\": [\"area\"]}}`; null = top level, no link; `target_column` when the target names it differently: an enum target column must have every value the map allows, a string one takes any value). A link to no row of the table, or to the row itself, is refused too. Existing rows that break them refuse the change; `list_link_targets` lists the valid targets of a row.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
        },
        "description": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "What a row of the table records (required: the table is refused without it, as without a column's own description)."
        },
        "columns": {
          "items": {
            "additionalProperties": true,
            "type": "object"
          },
          "type": "array"
        },
        "catalog": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "schema": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "time_column": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "filename": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "File name pattern of the rows, e.g. \"{name}\" (instead of time_column)."
        },
        "partition": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Sub-folder pattern of the rows, e.g. \"{occurred_at:YYYY/MM}\"; \"\" = flat."
        },
        "exclude": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Folders whose notes are never rows of the table (e.g. templates that create them)."
        },
        "archive": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Archive folder: a folder name inside the table folder (default: the database's archive_folder)."
        },
        "aliases": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Other words for what the table records, for agents."
        },
        "history": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Keep the table's versions (time travel, restore); default: the database's setting."
        },
        "autolink_target": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "May automatic links link the table's rows? Default: yes, unless its rows are named by a date or a time."
        },
        "row_template": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Markdown body of new rows; {column} placeholders are filled from the row."
        },
        "fields": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Untyped fields of the table (name → default), kept on every row; a field cannot share a name with a column."
        },
        "tags": {
          "anyOf": [
            {
              "additionalProperties": {
                "type": "string"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Key/value labels of the table (strings), e.g. {\"domain\": \"health\"}."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "name",
        "columns"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Create Table",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "drop_table",
    "description": "Drop a table. Refused while it has rows unless `mode: \"archive\"`, which removes the\ndefinition from `metastore.yaml` and moves all rows to the table's archive folder (nothing is\nhard-deleted; undo restores). The transaction log is kept: `restore_table` can bring it back.\nRefused while a CHECK that follows links, or a `ref_where` / `ref_by`, of another table reads this\ntable through a link (link targets are not rewritten): the conflicts name them; drop or change them first.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "mode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "archive"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "\"archive\": drop a table that has rows, moving them to its archive folder."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Drop Table",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "add_column",
    "description": "Add a typed column. Sparse by default (written only on rows that have a value — use for\nmetrics, e.g. `{\"name\": \"metric_mood\", \"type\": \"integer\", \"min\": 1, \"max\": 5, \"label\":\n\"Mood\", \"aliases\": [\"mood\"], \"description\": \"Mood of the day, 1 = bad, 5 = great\"}`).\n`description` is required: what the column holds, for the agents and people who read the schema\n(the engine writes it for `identity` \"uuid\" / \"created\" columns).\n`dense: true` in the spec adds it to every row with its `default`. Call `describe_table` first: never add\na column whose meaning an existing column (name/label/aliases/description) already covers.\nColumn names are permanent identifiers; only `rename_column` changes them.\nEnum columns: `values` and, for each, its meaning in `value_descriptions` (`{\"stated\": \"the user said it\", …}`): describe_table shows them and a refused value lists them.\nGenerated link columns: `generated: \"link({occurred_at:YYYY-MM-DD})\"` with `ref` = the days table links each row to the row of `ref` named by the template (its folder read from the schema; the target may not exist yet).\nFiltered link targets (link columns): `ref_where` (a `where` every target must match) and `ref_by` (a column of the row picks the target level: `{\"column\": \"kind\", \"levels\": [\"area\", \"project\", \"workstream\"]}` or `{\"column\": \"kind\", \"map\": {\"area\": null, \"project\": [\"area\"]}}`; null = top level, no link; `target_column` when the target names it differently: an enum target column must have every value the map allows, a string one takes any value). A link to no row of the table, or to the row itself, is refused too. Existing rows that break them refuse the change; `list_link_targets` lists the valid targets of a row.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "column": {
          "additionalProperties": true,
          "type": "object",
          "description": "The column's spec: name, type, description and its other attributes; `dense: true` writes it on every row."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "column"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Add Column",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "rename_column",
    "description": "Rename a column in metastore.yaml and on every row. Refused if `to_column` is already a column\nof the table; a row that has a stray `to_column` key with a different value is a conflict, and\nnothing is written. CHECKs, `ref_where` and `ref_by` that read the column (in this table, or through\na link from another table: `parent.kind`) follow the new name. Views and note text that mention the\nold name are not rewritten.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "from_column": {
          "type": "string"
        },
        "to_column": {
          "type": "string"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "from_column",
        "to_column"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Rename Column",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "drop_column",
    "description": "Remove a column from the schema and every row. Previous values are journaled; revert with\n`undo_migration`. Refused while a CHECK, `ref_where` or `ref_by` of any table reads the column\n(directly or through a link): the conflicts name them; drop or change them first.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "column": {
          "type": "string",
          "description": "The column's name."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "column"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Drop Column",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "alter_column",
    "description": "Change a column's attributes (type, min/max/step, values, required, default, label,\naliases, description, note, `ref_where`, `ref_by` (see list_link_targets); `null` removes an attribute, except\n`description`, which changes but never goes (null or \"\" is refused); `dense` true/false). Refused with\nthe list of violating rows when existing values do not satisfy the new definition. A\ndifferent scale means a different column: add a new one instead of rescaling. To rename one\nenum value use `rename_value`. Dropping an enum value that a `ref_by` (of any table) allows as a\ntarget level is refused, naming it.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "column": {
          "type": "string",
          "description": "The column's name."
        },
        "changes": {
          "additionalProperties": true,
          "type": "object"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "column",
        "changes"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Alter Column",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "alter_table",
    "description": "Alter a table: move it (`catalog`, `schema`), rename it (`name`), change\n`partition` / `filename` patterns, `description` (changes, never goes: \"\" is refused), `aliases`,\n`exclude` folders, `row_template`\n(\"\" removes it), `history` (true | false | \"default\"), `autolink_target`\n(true | false | \"default\": may automatic links link its rows? default: yes, unless its rows are named by\na date or a time) or `tags` (key/value\nlabels merged into the table's, e.g. `{\"domain\": \"health\"}`; a `null` value removes that tag;\n`clear_tags: true` removes every tag first, so with `tags` the table keeps exactly those),\n`archive` (folder name inside the table folder) or `fields` (untyped fields, name → default; a\n`null` value removes one). Rows, archive and transaction log follow; links are updated; renamed\nrows keep their old name in `aliases`. A change of metadata only (tags, description, aliases,\nhistory, autolink_target, row_template, fields) rewrites the table entry alone: no row is moved or rewritten. Refused\nwhen a row cannot fill a pattern. Renaming or moving the table is refused while a CHECK that follows\nlinks, or a `ref_where` / `ref_by`, of another table reads it through a link (link targets are not\nrewritten): the conflicts name them. Use `dry_run` to see `planned_moves`; undo with undo_migration.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "catalog": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "schema": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "name": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "partition": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "filename": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "description": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The new description: what a row records (it changes, never goes: \"\" is refused)."
        },
        "aliases": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "history": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "string",
              "enum": [
                "default"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Keep the table's versions: true, false, or \"default\" (the database's setting)."
        },
        "autolink_target": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "string",
              "enum": [
                "default"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "May automatic links link the table's rows? true, false, or \"default\" (yes, unless its rows are named by a date or a time)."
        },
        "exclude": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "row_template": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Markdown body of new rows; \"\" removes it."
        },
        "tags": {
          "anyOf": [
            {
              "additionalProperties": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Tags to add or change (strings); a null value removes that tag. The other tags are kept."
        },
        "clear_tags": {
          "default": false,
          "type": "boolean",
          "description": "Remove every tag first (with `tags`: the table keeps exactly those)."
        },
        "archive": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Archive folder: a folder name inside the table folder (e.g. \"_archive\"); \"\" = the database default (`archive_folder`). Archived rows follow."
        },
        "fields": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Untyped fields to set (name → default, as in create_table `fields`); a null value removes that field. The other fields are kept; a name cannot be a column."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Alter Table",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "define_base",
    "description": "Create or replace a base: a named set of columns (same spec as `create_table`) that tables\ninherit, like a parent class (`bases` in `metastore.yaml`). Tables using it get the columns\nwith the same name and meaning; `ref: \"self\"` means the inheriting table (e.g. a `parent`\ncolumn with `hierarchy: true`). `bases` builds on other bases. Descriptions are required, as in\ncreate_table: `description` says what the tables of the base share, and each column has its `description`\n(a column given without one keeps the one the base had for it). Replacing a base changes\nevery inheriting table: `rename_columns` (`{\"old\": \"new\"}`) renames the column on their rows,\n`drop_columns` removes it from their rows; dropping a column without listing it is refused.\nA renamed column is followed into the CHECKs and `ref_where` / `ref_by` that read it (the base's\nown included); dropping one they read is refused, naming them. All affected rows are validated\nbefore any write, inherited `ref_where` / `ref_by` and CHECKs that follow links included.\nEnum columns: `values` and, for each, its meaning in `value_descriptions` (`{\"stated\": \"the user said it\", …}`): describe_table shows them and a refused value lists them.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
        },
        "columns": {
          "items": {
            "additionalProperties": true,
            "type": "object"
          },
          "type": "array"
        },
        "bases": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "description": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "What the tables of the base share (required, as a table's description is)."
        },
        "rename_columns": {
          "anyOf": [
            {
              "additionalProperties": {
                "type": "string"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "drop_columns": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "name",
        "columns"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Define Base",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "set_table_bases",
    "description": "Set the bases a table inherits from (`bases`, in order; `[]` removes them). Inherited\ncolumns come after `id` and before the table's own columns. An own column with the name of an\ninherited one is replaced by the inherited definition (rows must fit it, its `ref_where` /\n`ref_by` included); a table may only\nrestyle an inherited column (label, description, aliases, note, dense) with `alter_column`.\nDense and generated/identity columns are filled on existing rows.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "bases": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "bases"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Set Table Bases",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "describe_database",
    "description": "Describe the database: its folder (`root`), `metastore` (`metastore.yaml`: read it freely,\nbut it is read-only for agents and changes only through the schema operations), configuration\n(default catalog and schema, row partition and file-name formats, archive folder, time zone,\nhistory, automatic links),\njournal folder, `bases` (shared column sets and the tables using them), `catalogs` → `schemas` → `tables` (with `row_count`, `tags`, and `unreadable_count` when some rows' front matter cannot be read) and `views`;\ncatalogs and schemas show their `comment` (set with `comment_on`). A table or base defined before\ndescriptions were required has `missing_descriptions`: what lacks one, for alter_table / alter_column\n(define_base for a base) to fill, so every table and column says what it holds.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "annotations": {
      "title": "Describe Database",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "DatabaseDescription",
      "type": "object",
      "description": "The database: configuration, catalogs, schemas, tables, views and bases.",
      "properties": {
        "root": {
          "type": "string",
          "description": "Database folder in the vault."
        },
        "metastore": {
          "type": "string",
          "description": "Path of metastore.yaml (catalogs, schemas, tables, views)."
        },
        "journal": {
          "type": "string",
          "description": "Folder of the operation journal."
        },
        "config": {
          "type": "object",
          "description": "Database configuration.",
          "properties": {
            "default_catalog": {
              "type": "string"
            },
            "default_schema": {
              "type": "string"
            },
            "default_partition": {
              "type": "string",
              "description": "Date format of row sub-folders; empty = flat."
            },
            "default_filename": {
              "type": "string",
              "description": "Date format of row file names."
            },
            "archive_folder": {
              "type": "string"
            },
            "timezone": {
              "type": "string",
              "description": "IANA time zone; empty = values stored as given."
            },
            "history": {
              "type": "boolean",
              "description": "Transaction log (time travel) on by default."
            },
            "autolink": {
              "type": "boolean",
              "description": "Automatic links in the text writes put in bodies (on by default)."
            }
          },
          "required": [
            "default_catalog",
            "default_schema",
            "default_partition",
            "default_filename",
            "archive_folder",
            "timezone",
            "history",
            "autolink"
          ]
        },
        "catalogs": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "catalog": {
                "type": "string"
              },
              "description": {
                "type": "string",
                "description": "What the catalog holds (comment_on)."
              },
              "default": {
                "type": "boolean",
                "description": "Present (true) on the default catalog."
              },
              "schemas": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "schema": {
                      "type": "string"
                    },
                    "description": {
                      "type": "string",
                      "description": "What the schema holds (comment_on)."
                    },
                    "tables": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "qualified": {
                            "type": "string",
                            "description": "catalog.schema.table"
                          },
                          "row_count": {
                            "type": "integer",
                            "description": "Row count."
                          },
                          "unreadable_count": {
                            "type": "integer",
                            "description": "Rows whose front matter cannot be read, when there are any: not in row_count, since every read leaves them out. check_table lists them (code unreadable)."
                          },
                          "description": {
                            "type": "string"
                          },
                          "tags": {
                            "type": "object",
                            "additionalProperties": {
                              "type": "string"
                            },
                            "description": "Key/value labels of the table, when it has any."
                          },
                          "missing_descriptions": {
                            "title": "MissingDescriptions",
                            "type": "object",
                            "description": "What has no description, when something has none (a table defined before descriptions were required): fill them with alter_table and alter_column.",
                            "properties": {
                              "table": {
                                "type": "boolean",
                                "description": "True when the table itself has no description."
                              },
                              "columns": {
                                "type": "array",
                                "items": {
                                  "type": "string"
                                },
                                "description": "The columns without a description."
                              }
                            },
                            "required": [
                              "table",
                              "columns"
                            ]
                          }
                        },
                        "required": [
                          "name",
                          "qualified",
                          "row_count"
                        ]
                      }
                    },
                    "views": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "qualified": {
                            "type": "string"
                          },
                          "description": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "name",
                          "qualified"
                        ]
                      }
                    }
                  },
                  "required": [
                    "schema",
                    "tables",
                    "views"
                  ]
                }
              }
            },
            "required": [
              "catalog",
              "schemas"
            ]
          },
          "description": "Tables and views by catalog and schema."
        },
        "bases": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "bases": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "The bases this base builds on, in order."
              },
              "columns": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Column names the base declares."
              },
              "tables": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Qualified tables extending it."
              },
              "missing_descriptions": {
                "type": "object",
                "description": "What has no description, when something has none (a base defined before descriptions were required): define_base fills them.",
                "properties": {
                  "base": {
                    "type": "boolean",
                    "description": "True when the base has no comment."
                  },
                  "columns": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "The base's columns without a description."
                  }
                },
                "required": [
                  "base",
                  "columns"
                ]
              }
            },
            "required": [
              "name",
              "columns",
              "tables"
            ]
          },
          "description": "Bases (shared columns) and the tables that extend each one."
        }
      },
      "required": [
        "root",
        "metastore",
        "journal",
        "config",
        "catalogs",
        "bases"
      ]
    }
  },
  {
    "name": "configure_database",
    "description": "Configure the database (persisted in metastore.yaml `config:`): `root` (rename the database\nfolder; links follow; revert by renaming back), `default_catalog`, `default_schema`,\n`default_partition` (\"\" = flat) and `default_filename` (date formats for new time-based tables),\n`archive_folder`, `timezone` (IANA; completes date-times written without offset), `history`\n(transaction log for every table: true in a database the engine creates, false when\n`config` lacks it, as in a metastore from before 3.0.0; change it only on the user's request), `autolink` (the text a write\nputs in a body links the notes it mentions; on by default). Returns describe_database.\nRenaming `root` moves the folder (links to its notes are rewritten; the tables' archive and\n`exclude` folders inside it follow); the move is listed in the journal as `move_database` (undo\nand time travel read older entries with the new paths) and cannot be undone. Settings changes are\nnot journaled (no `migration_id`, nothing for undo_migration): to revert, call it again with the\nprevious values.\n\nThe metastore changes only through operations: never edit metastore.yaml by hand (no validation).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "root": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "default_catalog": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "default_schema": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "default_partition": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "default_filename": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "archive_folder": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "timezone": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "history": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "autolink": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Automatic links: the text a write puts in a note's body links the notes it mentions by name (on by default). A write's own `autolink` overrides it."
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "Configure Database",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "DatabaseDescription",
      "type": "object",
      "description": "The database: configuration, catalogs, schemas, tables, views and bases.",
      "properties": {
        "root": {
          "type": "string",
          "description": "Database folder in the vault."
        },
        "metastore": {
          "type": "string",
          "description": "Path of metastore.yaml (catalogs, schemas, tables, views)."
        },
        "journal": {
          "type": "string",
          "description": "Folder of the operation journal."
        },
        "config": {
          "type": "object",
          "description": "Database configuration.",
          "properties": {
            "default_catalog": {
              "type": "string"
            },
            "default_schema": {
              "type": "string"
            },
            "default_partition": {
              "type": "string",
              "description": "Date format of row sub-folders; empty = flat."
            },
            "default_filename": {
              "type": "string",
              "description": "Date format of row file names."
            },
            "archive_folder": {
              "type": "string"
            },
            "timezone": {
              "type": "string",
              "description": "IANA time zone; empty = values stored as given."
            },
            "history": {
              "type": "boolean",
              "description": "Transaction log (time travel) on by default."
            },
            "autolink": {
              "type": "boolean",
              "description": "Automatic links in the text writes put in bodies (on by default)."
            }
          },
          "required": [
            "default_catalog",
            "default_schema",
            "default_partition",
            "default_filename",
            "archive_folder",
            "timezone",
            "history",
            "autolink"
          ]
        },
        "catalogs": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "catalog": {
                "type": "string"
              },
              "description": {
                "type": "string",
                "description": "What the catalog holds (comment_on)."
              },
              "default": {
                "type": "boolean",
                "description": "Present (true) on the default catalog."
              },
              "schemas": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "schema": {
                      "type": "string"
                    },
                    "description": {
                      "type": "string",
                      "description": "What the schema holds (comment_on)."
                    },
                    "tables": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "qualified": {
                            "type": "string",
                            "description": "catalog.schema.table"
                          },
                          "row_count": {
                            "type": "integer",
                            "description": "Row count."
                          },
                          "unreadable_count": {
                            "type": "integer",
                            "description": "Rows whose front matter cannot be read, when there are any: not in row_count, since every read leaves them out. check_table lists them (code unreadable)."
                          },
                          "description": {
                            "type": "string"
                          },
                          "tags": {
                            "type": "object",
                            "additionalProperties": {
                              "type": "string"
                            },
                            "description": "Key/value labels of the table, when it has any."
                          },
                          "missing_descriptions": {
                            "title": "MissingDescriptions",
                            "type": "object",
                            "description": "What has no description, when something has none (a table defined before descriptions were required): fill them with alter_table and alter_column.",
                            "properties": {
                              "table": {
                                "type": "boolean",
                                "description": "True when the table itself has no description."
                              },
                              "columns": {
                                "type": "array",
                                "items": {
                                  "type": "string"
                                },
                                "description": "The columns without a description."
                              }
                            },
                            "required": [
                              "table",
                              "columns"
                            ]
                          }
                        },
                        "required": [
                          "name",
                          "qualified",
                          "row_count"
                        ]
                      }
                    },
                    "views": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "qualified": {
                            "type": "string"
                          },
                          "description": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "name",
                          "qualified"
                        ]
                      }
                    }
                  },
                  "required": [
                    "schema",
                    "tables",
                    "views"
                  ]
                }
              }
            },
            "required": [
              "catalog",
              "schemas"
            ]
          },
          "description": "Tables and views by catalog and schema."
        },
        "bases": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "bases": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "The bases this base builds on, in order."
              },
              "columns": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Column names the base declares."
              },
              "tables": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Qualified tables extending it."
              },
              "missing_descriptions": {
                "type": "object",
                "description": "What has no description, when something has none (a base defined before descriptions were required): define_base fills them.",
                "properties": {
                  "base": {
                    "type": "boolean",
                    "description": "True when the base has no comment."
                  },
                  "columns": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "The base's columns without a description."
                  }
                },
                "required": [
                  "base",
                  "columns"
                ]
              }
            },
            "required": [
              "name",
              "columns",
              "tables"
            ]
          },
          "description": "Bases (shared columns) and the tables that extend each one."
        }
      },
      "required": [
        "root",
        "metastore",
        "journal",
        "config",
        "catalogs",
        "bases"
      ]
    }
  },
  {
    "name": "comment_on",
    "description": "COMMENT ON CATALOG / SCHEMA: set the `description` of a catalog (`catalog` alone) or of one of its\nschemas (`catalog` and `schema`) in metastore.yaml: what it holds, so agents pick the right place.\n`description` \"\" removes it. An unknown catalog or schema is refused with the existing ones.\ndescribe_database and `system.information_schema.catalogs` / `schemata` show it. Undo with\n`undo_migration`. A table's description: alter_table.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "catalog": {
          "type": "string"
        },
        "schema": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "A schema of the catalog; omitted, the description is the catalog's."
        },
        "description": {
          "type": "string",
          "description": "The new description; \"\" removes it."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "catalog",
        "description"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Comment On",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "rename_value",
    "description": "Rename one value of an enum column (e.g. `high` → `very high`) in metastore.yaml and every\nrow, keeping its position, so an ordered scale is unchanged. CHECKs and `ref_where` conditions on\nthe column (also through a link from another table) and `ref_by` levels / maps that name the value\nuse the new one. Note text (queries, prose) is not rewritten. Refused if `to_value` already exists. Undo with `undo_migration`. Adding or\nremoving classes changes the scale: create a new table instead.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "column": {
          "type": "string"
        },
        "from_value": {
          "type": "string"
        },
        "to_value": {
          "type": "string"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "column",
        "from_value",
        "to_value"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Rename Value",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "insert_row",
    "description": "Insert a row (new note). Values are validated against the columns; the note path comes from\nthe table's `path`/`filename` patterns (e.g. an event logged today about last night lands in\nlast night's day folder when you set `occurred_at` to last night). `body` is the note text.\nGenerated / identity columns are computed (do not pass them); CHECK constraints are enforced.\nReturns `migration_id` (undo) and the created path in `planned_creates`.\n`body` links the notes it mentions by name, at their first mention (automatic links; off with\n`autolink: false` or the database's `autolink` setting). `links_added` lists the links made;\n`ambiguous_mentions` lists the mentions left as text with the notes they may name: read those,\nthen link the right one with update_row and `autolink: false`, or leave the text.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "values": {
          "additionalProperties": true,
          "type": "object"
        },
        "body": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "path": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Optional note path (vault-relative), instead of the table's file-name pattern; `.md` is added if missing; it must stay inside the vault."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        },
        "autolink": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Automatic links for this write: true links the notes `body` mentions by name, false writes it as given. Default: the calling token's `autolink` default, else the database's `autolink` setting (on unless configure_database turned it off)."
        }
      },
      "required": [
        "table",
        "values"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Insert Row",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "update_rows",
    "description": "Update every row matching `where` (required: `{}` is every row). `where`: keys AND-ed; values are equality or operators\neq, ne, gt, gte, lt, lte, in, contains, icontains (case/accent-insensitive, also inside lists —\nuse it for names and aliases), exists, within (a hierarchy link: that row and everything below);\ncombine with `or` / `and` / `not` (nestable); `path` is a pseudo-column. A dotted key follows a\nlink column: `{\"project.area\": \"[[Work]]\"}` matches rows whose `project` links a row with that `area`. `set` sets, `unset`\nremoves; all rows are validated first.\n`expect_count`: refuse unless exactly that many match. One row, or its text: update_row.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "where": {
          "additionalProperties": true,
          "type": "object",
          "description": "The rows to change; {} is every row of the table."
        },
        "set": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unset": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        },
        "expect_count": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Refuse (nothing written) unless `where` matches exactly this many rows."
        }
      },
      "required": [
        "table",
        "where"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Update Rows",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "update_row",
    "description": "Update exactly ONE row, addressed by its `id` (the system UUID) or its `path`; refused when\nthe row does not exist (or id and path disagree). Same validation, journal and history as\n`update_rows`.\n\n- `set` / `unset`: columns to set or remove.\n- `body`: replace the whole note body; or edit it keeping the rest:\n  `body_sections` `{\"History\": \"…\"}` replaces the text under that heading (any level, up to the\n  next heading of the same level; added as `## History` when missing), `body_prepend` /\n  `body_append` add text before / after.\n- `expect`: compare-and-set — `{\"status\": \"open\"}` writes only if the row still has those\n  values (a person may have changed it since you read it); otherwise refused, nothing written.\n- `autolink`: the text written links the notes it mentions by name, at their first mention\n  (off with `autolink: false` or the database's setting). `links_added` lists the links made;\n  `ambiguous_mentions` the mentions left as text with the notes they may name: read those, then\n  link the right one with update_row and `autolink: false`, or leave the text.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "id": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "path": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "set": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unset": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "body": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "body_sections": {
          "anyOf": [
            {
              "additionalProperties": {
                "type": "string"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "body_prepend": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "expect": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "body_append": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        },
        "autolink": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Automatic links for this write: true links the notes the text written (`body`, `body_sections`, `body_prepend`, `body_append`) mentions by name, false writes it as given. Default: the calling token's `autolink` default, else the database's `autolink` setting (on unless configure_database turned it off)."
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Update Row",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "delete_rows",
    "description": "Delete rows matching `where`. `mode`: \"archive\" (default, move to the table's archive\nfolder) or \"delete\" (trash; content journaled for undo). `on_referenced`: \"restrict\"\n(default, refuse rows other notes link to), \"set_null\" (clear front matter links to them) or\n\"ignore\" (the links stay, to no row: an archived row is gone as a trashed one, so check_table\nreports them as `broken_link` and new links to it are refused). `where` is required: `{}` deletes every row.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "where": {
          "additionalProperties": true,
          "type": "object",
          "description": "The rows to change; {} is every row of the table."
        },
        "mode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "archive",
                "delete"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "on_referenced": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "restrict",
                "set_null",
                "ignore"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "where"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Delete Rows",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "move_rows",
    "description": "Move rows matching `where` (required: `{}` is every row) to another table (e.g. split a domain out of `log` into its own\ntable): sets each row's `table` to the destination, applies `rename` (`{\"metric_distance_km\":\n\"distance_km\"}`), `set` and `drop`, adds the destination's missing dense fields, and\nvalidates every row against the destination first. Keys unknown to the destination are\nreported, never dropped silently — rename or drop them explicitly. `relocate: true` also moves\nthe files to the destination table's folder (named by its filename pattern); by default rows stay where\nthey are, as rows already in folders of their own usually do (adopt_rows, for notes that are no rows\nyet, moves them by default). Refused while rows\nstaying behind link to a moved row through a column whose `ref` is the source table (the\nconflicts name them): change those links first. Undo with\n`undo_migration`.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "to_table": {
          "type": "string"
        },
        "where": {
          "additionalProperties": true,
          "type": "object",
          "description": "The rows to change; {} is every row of the table."
        },
        "rename": {
          "anyOf": [
            {
              "additionalProperties": {
                "type": "string"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "set": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "drop": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "relocate": {
          "default": false,
          "type": "boolean"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "to_table",
        "where"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Move Rows",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "adopt_rows",
    "description": "Turn existing notes (not rows of any table yet) into rows of `table`, keeping their body and\nlinks: `rename` keys (`{\"data\": \"occurred_at\"}`), `set` for all, `per_row` values by\nnote path (`{\"Home/x.md\": {\"zone\": \"[[Kitchen]]\"}}`), `drop` keys the table does not have.\nEvery note gets `table` and a system `id`; with `relocate` (default true, unlike move_rows:\nnotes become rows where the table keeps its rows) it moves to the table's folder, named by its filename pattern (links to it are rewritten). All notes are validated first\n(as rows of `table`, so notes of the same call may link to one another):\nunknown keys and bad values are listed and nothing is written. Run with `dry_run` first; undo\nwith `undo_migration`. Many notes: adopt them in calls of about 1,000 `paths` each, so a\nstop or a crash interrupts less (each call is one journal entry).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "paths": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "rename": {
          "anyOf": [
            {
              "additionalProperties": {
                "type": "string"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "set": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "per_row": {
          "anyOf": [
            {
              "additionalProperties": {
                "additionalProperties": true,
                "type": "object"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "drop": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "relocate": {
          "default": true,
          "type": "boolean"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "paths"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Adopt Rows",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "select_rows",
    "description": "Query rows: `{table, total, rows: [{path, ...}]}`. `table` may be a view,\n`system.information_schema.<catalogs|schemata|tables|columns|views|check_constraints>`, or\n`base:<name>` — every table that extends that base (e.g. `base:record`: all event-like tables),\non the base's columns, each row tagged `_source` with its table.\n- `where`: as in update_rows; relative dates `\"{today}\"`, `\"{today-7d}\"`, `\"{now-24h}\"` (on a date column a date-time\n  counts by its day); file columns\n  `file_name`, `file_link`, `file_modified`, `file_backlink_count`.\n- `columns`, `order_by` (`-col` descending), `limit` (default 100, max 1000), `offset`,\n  `expand` (inline linked rows' frontmatter), `include_body` (the note body as `body`).\n- `join`: `{\"table\", \"on\": {\"date(occurred_at)+1\": \"date(timestamp)\"}, \"as\", \"type\": \"inner\"|\"left\",\n  \"columns\", \"where\"}` — matches attached under `as`.\n- `group_by` (column, `path` or `date(col)±n`; a list column counts once per item) + `aggregates`\n  `{\"n\": \"count\", \"kcal\": \"sum:meal.kcal\"}` (count, count:col, sum, avg, min, max).\n- `this_note`: vault path of the note the result is for: `{this.*}` tokens in a view's query\n  and in `where` read it (`{this.date}`, `{this.link}`, `{this.name}`, `{this.path}`); without\n  it (or a front matter key the note lacks) a token stays as written and matches no row, whatever the\n  operator (`within` included).\n- Ordered enums compare by position. Time travel: `version` (of one table) or `timestamp`. With\n  `timestamp` a join, a view, a union or `base:<name>` reads every table in it as of that time\n  (`versions`: the version read of each); a table that did not exist then adds no rows to a union or\n  base. `version` is refused where several tables are read; information_schema has no history.\n  Views and bases keep today's definition, and links followed by `where` (`project.kind`, `within`)\n  or `expand` read the linked rows as they are now.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "columns": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "where": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "order_by": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "limit": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "offset": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "expand": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "join": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "group_by": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "aggregates": {
          "anyOf": [
            {
              "additionalProperties": {
                "type": "string"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "include_body": {
          "default": false,
          "type": "boolean"
        },
        "version": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "timestamp": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "this_note": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Select Rows",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "table": {
          "type": "string",
          "description": "The table, view or base selected, as given."
        },
        "total": {
          "type": "integer",
          "description": "Matching rows before limit/offset."
        },
        "rows": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "A row: `path` plus the selected columns (missing values are null); `body` with include_body; the group keys and aggregates with group_by.",
            "additionalProperties": true
          },
          "description": "The rows returned."
        },
        "version": {
          "type": "integer",
          "description": "Log version read (time travel only; of the left table with a join, absent for a union or a base)."
        },
        "timestamp": {
          "type": "string",
          "description": "Commit time of that version (time travel only); for a union or a base, the time asked for."
        },
        "versions": {
          "type": "object",
          "additionalProperties": {
            "type": "integer"
          },
          "description": "Time travel over several tables (a join, a union, a base): the version read of each, by full name."
        },
        "view": {
          "type": "string",
          "description": "The view whose query ran."
        }
      },
      "required": [
        "table",
        "total",
        "rows"
      ],
      "additionalProperties": true
    }
  },
  {
    "name": "check_table",
    "description": "Validate every row against the table (required, types, ranges, enums, links, unknown\ncolumns, CHECK constraints, those that follow links included, filtered link targets (ref_where / ref_by), stale generated/identity values, missing inverse links, front matter that cannot be read: code `unreadable`, with no column, for a note whose `table` line names the table but whose YAML is broken, which every other read leaves out). A CHECK violation has code `check` and the CHECK's name as `constraint` (every other code names its `column`), as in the `violations` of list_changes. Use it to find rows edited by hand that break the schema. Without `table`, every table is checked: each row then names its `table`, `tables_checked` counts the tables checked, and a table that cannot be checked is listed in `errors` ({table, error}) while the others are. The rows with violations are paged: `limit` (default 500, at most 5000) from `offset`; `total` counts them all. (Hand edits are also checked as they happen: see `violations` in list_changes.)",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Omit to check every table."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5000,
          "default": 500,
          "description": "Rows with violations returned (paging)."
        },
        "offset": {
          "type": "integer",
          "minimum": 0,
          "default": 0,
          "description": "Rows with violations skipped first (paging)."
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "Check Table",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "table": {
          "type": [
            "string",
            "null"
          ],
          "description": "Qualified table; null when every table was checked."
        },
        "rows_checked": {
          "type": "integer",
          "description": "Rows checked."
        },
        "tables_checked": {
          "type": "integer",
          "description": "Tables checked (when every table was checked)."
        },
        "total": {
          "type": "integer",
          "description": "Rows breaking the rules in all (`violations` is the page from `offset`)."
        },
        "errors": {
          "type": "array",
          "description": "Tables that could not be checked (when every table was checked), with the reason.",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string"
              },
              "error": {
                "type": "string"
              }
            },
            "required": [
              "table",
              "error"
            ]
          }
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "CheckedRow",
            "type": "object",
            "description": "A row breaking the rules, with its table when every table was checked.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "table": {
                "type": "string",
                "description": "The row's qualified table (when every table was checked)."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows breaking the table's rules (this page of them)."
        }
      },
      "required": [
        "table",
        "rows_checked",
        "total",
        "violations"
      ]
    }
  },
  {
    "name": "list_link_targets",
    "description": "The rows a link column may point to, for one row: what an agent or a picker offers before writing\nthe link. A link column can filter its targets:\n- `ref_where`: a `where` filter every target must match (`{\"kind\": {\"in\": [\"area\", \"project\"]}}`).\n- `ref_by`: a column of the row picks the targets' level: `{\"column\": \"kind\", \"map\": {\"area\": null,\n  \"project\": [\"area\"], \"workstream\": [\"project\"]}}`: a workstream's parent must have kind project; `null`\n  is a top level (the link must stay empty); any other level needs the link; a value missing from the\n  map is refused. `levels: [\"area\", \"project\", \"workstream\"]` writes the same chain short (each\n  level's parent is the level before it). `target_column` reads another column of the target\n  (default: the same name). describe_table shows the expanded map.\nWrites refuse other targets (code `ref`, listing the valid ones), a link to the row itself (`ref`),\na link to no row of the table (`broken_link`) and a missing link a level needs (`required`). Pass the\nrow (`row`: path, link or name; a name rows in different folders share is refused, listing their\npaths) and/or its values (`values`, e.g. `{\"kind\": \"workstream\"}` for a new row). Returns\n`{rows: [{name, link, path, <level column>}], total, required, empty, reason}` (no rows, and the\nreason, for a level the map lacks); write a row's `link` as the value.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "column": {
          "type": "string",
          "description": "A link column (or list of links) with ref."
        },
        "row": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The row the link is for: its path, a link to it or its name (its values are read)."
        },
        "values": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Values of the row (a new one, or changes to `row`), e.g. {\"kind\": \"workstream\"}."
        },
        "limit": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "At most this many targets: a positive integer (default 50, at most 500)."
        }
      },
      "required": [
        "table",
        "column"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "List Link Targets",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "table": {
          "type": "string",
          "description": "Qualified table."
        },
        "column": {
          "type": "string",
          "description": "The link column."
        },
        "ref": {
          "type": "string",
          "description": "Qualified table the column links to."
        },
        "required": {
          "type": "boolean",
          "description": "True when the row must have the link."
        },
        "empty": {
          "type": "boolean",
          "description": "True when the link must stay empty (a top level of ref_by)."
        },
        "reason": {
          "type": "string",
          "description": "What filters the targets (ref_where, the row's level)."
        },
        "rows": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "File name of the target row."
              },
              "link": {
                "type": "string",
                "description": "Link to write as the value (`[[path|name]]`)."
              },
              "path": {
                "type": "string",
                "description": "Vault path of the target row."
              }
            },
            "required": [
              "name",
              "link",
              "path"
            ],
            "additionalProperties": true,
            "description": "A valid target, with its ref_by level column."
          },
          "description": "Valid targets, sorted by name (the row itself left out)."
        },
        "total": {
          "type": "integer",
          "description": "Valid targets in all (rows is capped by limit)."
        }
      },
      "required": [
        "table",
        "column",
        "ref",
        "required",
        "empty",
        "reason",
        "rows",
        "total"
      ]
    }
  },
  {
    "name": "undo_migration",
    "description": "Revert a journaled table operation by its `migration_id`. Refused (nothing written) when any\ntouched note changed since; the conflicts are listed. Also refused when the revert would leave rows\nbreaking a CHECK that follows links or a `ref_where` / `ref_by` (rows it writes, or rows that link to\nthem), listed like the refusals of other writes with the way out (fix the row, or drop the rule).\nThe rules are those of the schema the revert puts back: undoing a rename_value / rename_column\nputs the old names back with the rows, and a rule the revert puts back must hold on every row.\nA `batch` is checked as a whole first (nothing written when refused), then reverted operation by\noperation, from the last; when one finds a note changed since, those after it stay reverted\nand a retry skips them. An undo is journaled like any operation: undoing it (the\n`migration_id` of its answer; `undoes` names the operation undone) is a redo, whatever the operation (a batch included). The\nrevert is a new version (`UNDO`) in the transaction log; undoing a table's rename or move takes\nits whole log back to the old name, the versions made under the new one included.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "migration_id": {
          "type": "string"
        }
      },
      "required": [
        "migration_id"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Undo Migration",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "description": "Result of undo_migration (HTTP 409 when refused, 500 when a write failed).",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was undone."
        },
        "op": {
          "type": "string",
          "const": "undo_migration",
          "description": "The operation: undo_migration, in the answer and in a refusal."
        },
        "undoes": {
          "type": "string",
          "description": "The operation undone."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the undo itself (undo it to redo the operation)."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Why it could not be undone (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          }
        }
      },
      "required": [
        "ok",
        "op",
        "undoes",
        "conflicts",
        "failed"
      ]
    }
  },
  {
    "name": "batch",
    "description": "Several writes that succeed or fail together. `operations`: `[{\"op\": ..., ...arguments}]` where\n`op` is a row operation (`insert_row`, `update_row`, `update_rows`, `delete_rows`, `merge_rows`,\n`move_rows`, `adopt_rows`, `recompute_columns`, `align_relations`, `restore_table`) or a DDL op\n(`create_table`, `add_column`, `alter_column`, …), with the same arguments as the operation (an unknown one refuses the batch) (e.g.\n`values` for insert_row, `set` for update_row / update_rows). They run in order, each seeing the previous ones; if one is\nrefused, the ones already applied are undone (`rolled_back`). Returns `steps` (per operation, each with its result,\nwhere `ambiguous_mentions` is as in insert_row) and\n`migration_id`: undo_migration on it reverts the whole batch. Use it when a change spans several\nrows (create an event and update the people in it). `dry_run` checks each operation against the\ncurrent data only.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "operations": {
          "items": {
            "additionalProperties": true,
            "type": "object"
          },
          "type": "array"
        },
        "summary": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "operations"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Batch",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when every operation was applied (or would be, on a dry run)."
        },
        "op": {
          "type": "string",
          "const": "batch",
          "description": "The operation: batch, in the answer and in a refusal (each step names its own)."
        },
        "dry_run": {
          "type": "boolean"
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the batch: undo it to undo every operation. Absent on a dry run or when nothing was journaled."
        },
        "steps": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "index": {
                "type": "integer",
                "description": "Position in `operations`."
              },
              "op": {
                "type": "string"
              },
              "ok": {
                "type": "boolean"
              },
              "migration_id": {
                "type": "string"
              },
              "result": {
                "title": "OpResult",
                "type": "object",
                "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
                "properties": {
                  "ok": {
                    "type": "boolean",
                    "description": "True when the operation was applied (or, on a dry run, would be)."
                  },
                  "op": {
                    "type": "string",
                    "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
                  },
                  "dry_run": {
                    "type": "boolean",
                    "description": "True when nothing was written (preview)."
                  },
                  "migration_id": {
                    "type": "string",
                    "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
                  },
                  "notes_changed": {
                    "type": "integer",
                    "description": "Notes whose front matter or body were written."
                  },
                  "files_created": {
                    "type": "integer",
                    "description": "Files created."
                  },
                  "files_moved": {
                    "type": "integer",
                    "description": "Files moved or renamed."
                  },
                  "files_deleted": {
                    "type": "integer",
                    "description": "Files deleted or archived."
                  },
                  "references_updated": {
                    "type": "integer",
                    "description": "Links rewritten in other notes."
                  },
                  "conflicts": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "path": {
                          "type": "string",
                          "description": "Note or file path."
                        },
                        "message": {
                          "type": "string",
                          "description": "Why the operation cannot proceed."
                        }
                      },
                      "required": [
                        "path",
                        "message"
                      ]
                    },
                    "description": "Reasons the operation was refused (empty on success)."
                  },
                  "violations": {
                    "type": "array",
                    "items": {
                      "title": "RowViolations",
                      "type": "object",
                      "description": "The violations of one row.",
                      "properties": {
                        "path": {
                          "type": "string",
                          "description": "Row note path."
                        },
                        "violations": {
                          "type": "array",
                          "items": {
                            "title": "Violation",
                            "type": "object",
                            "properties": {
                              "column": {
                                "type": "string",
                                "description": "The column the violation is about (every code but check and unreadable)."
                              },
                              "index": {
                                "type": "integer",
                                "description": "The item of a list column that breaks the rule, from 0."
                              },
                              "constraint": {
                                "type": "string",
                                "description": "The CHECK's name (code check)."
                              },
                              "code": {
                                "type": "string",
                                "enum": [
                                  "required",
                                  "inverse",
                                  "type",
                                  "min",
                                  "max",
                                  "step",
                                  "enum",
                                  "broken_link",
                                  "ref",
                                  "unique",
                                  "unknown_column",
                                  "check",
                                  "generated",
                                  "cycle",
                                  "vocabulary",
                                  "unreadable"
                                ],
                                "description": "Kind of violation."
                              },
                              "message": {
                                "type": "string",
                                "description": "Agent-readable explanation."
                              },
                              "value": {
                                "description": "The offending value, when there is one."
                              }
                            },
                            "required": [
                              "code",
                              "message"
                            ]
                          },
                          "description": "What is wrong with this row."
                        }
                      },
                      "required": [
                        "path",
                        "violations"
                      ]
                    },
                    "description": "Rows that would break the table's rules (empty on success)."
                  },
                  "failed": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "path": {
                          "type": "string",
                          "description": "Vault path."
                        },
                        "error": {
                          "type": "string",
                          "description": "What went wrong."
                        }
                      },
                      "required": [
                        "path",
                        "error"
                      ]
                    },
                    "description": "Files that could not be written (empty on success)."
                  },
                  "rolled_back": {
                    "type": "boolean",
                    "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
                  },
                  "planned_edits": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "path": {
                          "type": "string",
                          "description": "Note path."
                        },
                        "set": {
                          "type": "object",
                          "description": "Front matter keys set, with their new values.",
                          "additionalProperties": true
                        },
                        "remove": {
                          "type": "array",
                          "items": {
                            "type": "string"
                          },
                          "description": "Front matter keys removed."
                        },
                        "body": {
                          "type": "boolean",
                          "description": "True when the note body changes too."
                        }
                      },
                      "required": [
                        "path",
                        "set",
                        "remove"
                      ]
                    },
                    "description": "Front matter edits per note (planned, or made)."
                  },
                  "planned_creates": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "Paths of notes created."
                  },
                  "planned_moves": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "from": {
                          "type": "string"
                        },
                        "to": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "from",
                        "to"
                      ]
                    },
                    "description": "Files moved: from → to."
                  },
                  "planned_deletes": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "Paths deleted (or archived)."
                  },
                  "planned_texts": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
                  },
                  "commits": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "table": {
                          "type": "string",
                          "description": "Qualified table."
                        },
                        "version": {
                          "type": "integer",
                          "description": "New log version."
                        },
                        "operation": {
                          "type": "string",
                          "description": "Log operation, e.g. WRITE."
                        }
                      },
                      "required": [
                        "table",
                        "version",
                        "operation"
                      ]
                    },
                    "description": "Transaction-log commits written (tables with history on)."
                  },
                  "links_added": {
                    "type": "array",
                    "items": {
                      "title": "LinkAdded",
                      "type": "object",
                      "description": "A link the write added in place of a mention.",
                      "properties": {
                        "path": {
                          "type": "string",
                          "description": "The note the link was written into."
                        },
                        "text": {
                          "type": "string",
                          "description": "The mention, as written."
                        },
                        "target": {
                          "type": "string",
                          "description": "Vault path of the note it links."
                        },
                        "link": {
                          "type": "string",
                          "description": "The link written in place of the mention."
                        }
                      },
                      "required": [
                        "path",
                        "text",
                        "target",
                        "link"
                      ]
                    },
                    "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
                  },
                  "ambiguous_mentions": {
                    "type": "array",
                    "items": {
                      "title": "LinkAmbiguous",
                      "type": "object",
                      "description": "A mention left as text: more than one note could be meant.",
                      "properties": {
                        "path": {
                          "type": "string",
                          "description": "The note the mention is in."
                        },
                        "text": {
                          "type": "string",
                          "description": "The mention, as written."
                        },
                        "reason": {
                          "type": "string",
                          "enum": [
                            "same_name",
                            "adjacent",
                            "overlap",
                            "part_of_name",
                            "sentence_start"
                          ],
                          "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
                        },
                        "candidates": {
                          "type": "array",
                          "items": {
                            "type": "string"
                          },
                          "description": "Vault paths of the notes it may name."
                        },
                        "context": {
                          "type": "string",
                          "description": "The line around the mention."
                        },
                        "hint": {
                          "type": "string",
                          "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
                        }
                      },
                      "required": [
                        "path",
                        "text",
                        "reason",
                        "candidates",
                        "context",
                        "hint"
                      ]
                    },
                    "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
                  }
                },
                "required": [
                  "ok",
                  "op",
                  "dry_run",
                  "notes_changed",
                  "files_created",
                  "files_moved",
                  "files_deleted",
                  "references_updated",
                  "conflicts",
                  "violations",
                  "failed",
                  "planned_edits",
                  "planned_creates",
                  "planned_moves",
                  "planned_deletes",
                  "planned_texts"
                ]
              },
              "error": {
                "type": "string",
                "description": "Error of an operation that threw."
              }
            },
            "required": [
              "index",
              "op",
              "ok"
            ]
          },
          "description": "Result of each operation, in order."
        },
        "failed_at": {
          "type": "integer",
          "description": "Index of the refused operation (refusals only, HTTP 422/500)."
        },
        "rolled_back": {
          "type": "boolean"
        },
        "rollback": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "Undo of an applied operation after a refusal.",
            "additionalProperties": true
          }
        }
      },
      "required": [
        "ok",
        "dry_run",
        "steps"
      ]
    }
  },
  {
    "name": "align_relations",
    "description": "Add the reciprocal links missing on a table's `inverse` link columns (e.g. Alice lists Carol\nin `friends` but Carol does not list Alice). Run it after declaring `inverse` on existing data;\ncheck_table reports such rows (code `inverse`). Single-value links already pointing elsewhere\nare conflicts (nothing written). The links it adds are checked like other writes (CHECKs that\nfollow links, `ref_where` / `ref_by`). Writes through the tools already keep both sides in step.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "paths": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Align Relations",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "infer_table",
    "description": "Read-only schema inference from notes' front matter.\n- `folder` (recursive; \"\" = whole vault) and/or `paths`: notes not yet in a table. Returns\n  `columns` (type, enum `values`, link `ref` to the table most targets belong to, `required`,\n  `unique`, `dense`, `from` when the front matter key is not a valid column name, `stats`),\n  `proposal`, the create_table arguments (`name`, `description`, `filename` or\n  `time_column`, `columns`), and `adopt` ready for adopt_rows (`paths`, `rename`,\n  `relocate: false`), plus `hints` to read.\n  The notes cannot say what the table and its columns mean: `description` is null on the proposal\n  and on every column. Write each one (ask the user when unsure), and review the names, enums and\n  required columns, before you pass the proposal to create_table, which refuses null descriptions.\n- `table`: keys the table's rows use but the table does not declare (candidates for add_column,\n  each with a description to write, or keys to drop from rows).\nA string column becomes an enum when its values repeat: at least 3 notes, at most `max_enum_values`\ndistinct values (default 12), each used twice on average, short texts.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "folder": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "paths": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "table": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "name": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "max_enum_values": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "Infer Table",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "files": {
          "type": "integer",
          "description": "Notes examined."
        },
        "paths": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Their paths."
        },
        "skipped": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string"
              },
              "reason": {
                "type": "string"
              }
            },
            "required": [
              "path",
              "reason"
            ]
          },
          "description": "Notes left out, and why."
        },
        "columns": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "from": {
                "type": "string",
                "description": "Original front matter key when it is not a valid column name."
              },
              "type": {
                "type": "string"
              },
              "description": {
                "type": "null",
                "description": "What the column holds: null, for the caller to write (create_table and add_column refuse a column without one)."
              },
              "items": {
                "type": "string"
              },
              "values": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "ref": {
                "type": "string"
              },
              "required": {
                "type": "boolean"
              },
              "unique": {
                "type": "boolean"
              },
              "dense": {
                "type": "boolean"
              },
              "stats": {
                "type": "object",
                "properties": {
                  "present": {
                    "type": "integer"
                  },
                  "filled": {
                    "type": "integer"
                  },
                  "distinct": {
                    "type": "integer"
                  },
                  "types": {
                    "type": "object",
                    "additionalProperties": {
                      "type": "integer"
                    }
                  },
                  "examples": {
                    "type": "array",
                    "items": {
                      "description": "Any JSON value."
                    }
                  }
                },
                "required": [
                  "present",
                  "filled",
                  "distinct",
                  "types",
                  "examples"
                ]
              }
            },
            "required": [
              "name",
              "type",
              "description",
              "stats"
            ]
          },
          "description": "Inferred columns."
        },
        "proposal": {
          "type": "object",
          "description": "The arguments of create_table (folder/paths mode), once the caller writes the descriptions left null.",
          "properties": {
            "name": {
              "type": "string"
            },
            "description": {
              "type": "null",
              "description": "What a row of the table records: null, for the caller to write (each column's `description` too)."
            },
            "time_column": {
              "type": "string"
            },
            "filename": {
              "type": "string",
              "description": "The notes' name template, when their names follow one."
            },
            "columns": {
              "type": "array",
              "items": {
                "type": "object",
                "description": "A column spec.",
                "additionalProperties": true
              }
            }
          },
          "required": [
            "name",
            "description",
            "columns"
          ]
        },
        "adopt": {
          "type": "object",
          "description": "Ready for adopt_rows once the table exists (folder/paths mode).",
          "properties": {
            "paths": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "rename": {
              "type": "object",
              "additionalProperties": {
                "type": "string"
              }
            },
            "relocate": {
              "type": "boolean"
            }
          },
          "required": [
            "paths",
            "relocate"
          ]
        },
        "hints": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Remarks for the caller."
        }
      },
      "required": [
        "files",
        "paths",
        "skipped",
        "columns",
        "hints"
      ]
    }
  },
  {
    "name": "semantic_search",
    "description": "Find notes by meaning, not exact words: `{query, results: [{path, score, heading, snippet,\ntable?}]}`, one result per note (its best passage), best first. Use it for vague questions\n(\"the dinner where we talked about moving\", \"what did I decide about the car\") and to find the\nrows to read or update; then read_note / select_rows for the details. Filters: `tables`\n(qualified or short names), `folder`, `min_score` (cosine 0–1; ~0.5+ is usually relevant).\n`limit`: default 10, max 100. Fails with a clear message when semantic search is not enabled in\nthe engine settings.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "query": {
          "type": "string"
        },
        "limit": {
          "default": 10,
          "type": "integer"
        },
        "tables": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "folder": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "min_score": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "required": [
        "query"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Semantic Search",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string"
        },
        "results": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string"
              },
              "score": {
                "type": "number",
                "description": "Similarity, 0..1."
              },
              "heading": {
                "type": "string",
                "description": "Heading of the best passage."
              },
              "snippet": {
                "type": "string"
              },
              "table": {
                "type": "string",
                "description": "Qualified table of a row note."
              }
            },
            "required": [
              "path",
              "score",
              "heading",
              "snippet"
            ]
          },
          "description": "One result per note, best first."
        }
      },
      "required": [
        "query",
        "results"
      ]
    }
  },
  {
    "name": "describe_semantic_index",
    "description": "The semantic search index: `enabled`, `provider`, `model`, `files`, `passages`, `pending`,\n`running`, `last_sync`, `last_error`. sync_semantic_index brings it up to date.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "annotations": {
      "title": "Describe Semantic Index",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "SemanticStatus",
      "type": "object",
      "description": "State of the semantic index (action status).",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "provider": {
          "type": "string"
        },
        "model": {
          "type": "string"
        },
        "files": {
          "type": "integer",
          "description": "Notes indexed."
        },
        "passages": {
          "type": "integer",
          "description": "Passages indexed."
        },
        "pending": {
          "type": "integer",
          "description": "Notes waiting to be (re)embedded."
        },
        "running": {
          "type": "boolean",
          "description": "An update is running."
        },
        "last_sync": {
          "type": "string"
        },
        "last_error": {
          "type": "string"
        }
      },
      "required": [
        "enabled",
        "provider",
        "model",
        "files",
        "passages",
        "pending",
        "running"
      ]
    }
  },
  {
    "name": "sync_semantic_index",
    "description": "Bring the semantic search index up to date: embed the notes changed since the last run (the\nengine also does it on its own about ten seconds after edits). `rebuild: true` re-embeds\neverything: slow, and costs money with a paid provider — ask first.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "rebuild": {
          "default": false,
          "type": "boolean",
          "description": "Re-embed every note, not only the changed ones."
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "Sync Semantic Index",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": true
    },
    "responseSchema": {
      "title": "SemanticSyncResult",
      "type": "object",
      "description": "What an update or rebuild did.",
      "properties": {
        "embedded": {
          "type": "integer",
          "description": "Notes embedded."
        },
        "removed": {
          "type": "integer",
          "description": "Notes dropped from the index."
        },
        "unchanged": {
          "type": "integer"
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          }
        }
      },
      "required": [
        "embedded",
        "removed",
        "unchanged",
        "failed"
      ]
    }
  },
  {
    "name": "list_migrations",
    "description": "The operation journal, newest first: `total` (the matching operations) and `migrations`, each with\n`migration_id` (for undo_migration), `op`, `summary`, `table` (when it was about one), `executed_at`,\n`notes_changed`, `files_changed`, `undone`, `undoes`, `files_failed`, `by` (the agent), and `members`\n(a batch's operations) or `batch` (the batch of an operation).\nFilters: `op` (e.g. \"update_rows\"), `table` (substring of the table name, e.g.\n\"personal.tasks.task\"), `since` (ISO date). `limit` default 50. The journal is kept in the\nengine's store, outside the vault (`store:journal/`); entries older than 90 days are dropped.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "limit": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "op": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "table": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "since": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "List Migrations",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "total": {
          "type": "integer",
          "description": "Matching operations (before limit)."
        },
        "migrations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "migration_id": {
                "type": "string"
              },
              "op": {
                "type": "string"
              },
              "summary": {
                "type": "string"
              },
              "table": {
                "type": "string",
                "description": "The table (or schema, or catalog) the operation was about, by its qualified name."
              },
              "executed_at": {
                "type": "string",
                "description": "ISO date-time."
              },
              "notes_changed": {
                "type": "integer"
              },
              "files_changed": {
                "type": "integer",
                "description": "Files created, moved, deleted or rewritten."
              },
              "undone": {
                "type": "boolean"
              },
              "undoes": {
                "type": "string",
                "description": "Operation this one undid."
              },
              "files_failed": {
                "type": "integer"
              },
              "by": {
                "type": "string",
                "description": "harness / model of the agent."
              },
              "members": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Operations of a batch."
              },
              "batch": {
                "type": "string",
                "description": "Batch this operation belongs to."
              }
            },
            "required": [
              "migration_id",
              "op",
              "summary",
              "executed_at",
              "notes_changed",
              "files_changed",
              "undone",
              "files_failed"
            ]
          },
          "description": "Newest first."
        }
      },
      "required": [
        "total",
        "migrations"
      ]
    }
  },
  {
    "name": "merge_rows",
    "description": "MERGE (upsert) `rows` into `table` by the key columns `on` (e.g. `[\"occurred_at\"]` or\n`[\"id\"]`): a row matching an existing one updates it (`when_matched`: \"update\" default or\n\"ignore\"), the others are inserted (`when_not_matched`: \"insert\" default or \"ignore\").\nDate-times are compared after completion with the database time zone. A source key matching\nseveral rows, or repeated, is a conflict. One journaled, undoable operation.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "on": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "rows": {
          "items": {
            "additionalProperties": true,
            "type": "object"
          },
          "type": "array"
        },
        "when_matched": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "update",
                "ignore"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "when_not_matched": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "insert",
                "ignore"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "on",
        "rows"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Merge Rows",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "describe_history",
    "description": "DESCRIBE HISTORY: the table's versions, newest first — `version`, `timestamp`, `operation`\n(CREATE TABLE, WRITE, UPDATE, DELETE, MERGE, ALTER TABLE, ADD COLUMNS, RESTORE, UNDO, …;\n`EXTERNAL_EDIT` = changed outside the engine: an editor, git, sync), `operation_metrics` and `migration_id` (undo).\nAn EXTERNAL_EDIT's `operation_metrics.violations` counts the rules this table's rows break because of the hand edits it holds (each once): the edited rows whose front matter changed and the rows of the table linking to them, a removed or renamed row included (rows of other tables count in their table; a body-only edit is not checked); every rule its rows break when its definition was edited in metastore.yaml. Absent when nothing was checked, or when the edits were logged right before an engine write (the change feed has them); check_table lists the rows invalid now.\nWorks for dropped tables too (full `catalog.schema.table`). Use a version with `select_rows`\n(time travel), `table_changes` or `restore_table`.\nWithout `table`: the history of the whole database — the commits of every table with a log (dropped\nones included), newest first, each with its `table` (the result's `tables` lists the logged tables).\nAn operation that changed several tables (a cascade, inverse links, restore_database) commits to each\nwith the same `migration_id`, and the operations of a `batch` carry its id as `batch`: their commits list\nin `tables` every table that operation (or batch) committed to. Pick a moment for `restore_database`\nfrom it (`timestamp`, or `before_migration` with a `migration_id` or a `batch`).\n`limit` (default 50) counts commits; `since` (ISO date or date-time): only commits at or after it.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "A table; omitted, the whole database."
        },
        "limit": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "since": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "Describe History",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "table": {
          "type": "string",
          "description": "Qualified table (with `table` only)."
        },
        "history": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Without `table`: the table of the commit."
              },
              "version": {
                "type": "integer"
              },
              "timestamp": {
                "type": "string",
                "description": "ISO date-time of the commit."
              },
              "operation": {
                "type": "string",
                "description": "e.g. CREATE TABLE, WRITE, UPDATE, DELETE, EXTERNAL_EDIT."
              },
              "operation_parameters": {
                "type": "object",
                "description": "Parameters of the operation.",
                "additionalProperties": true
              },
              "migration_id": {
                "type": "string",
                "description": "Journal entry of the operation."
              },
              "operation_metrics": {
                "type": "object",
                "properties": {
                  "num_added_files": {
                    "type": "integer"
                  },
                  "num_removed_files": {
                    "type": "integer"
                  },
                  "metadata_changed": {
                    "type": "boolean"
                  },
                  "violations": {
                    "type": "integer",
                    "description": "EXTERNAL_EDIT: the rules this table's rows break because of the commit's hand edits; absent when nothing was checked."
                  }
                },
                "required": [
                  "num_added_files",
                  "num_removed_files",
                  "metadata_changed"
                ]
              },
              "engine_info": {
                "type": "string"
              },
              "user_name": {
                "type": "string",
                "description": "harness / model of the agent (absent for hand edits)."
              },
              "actor": {
                "title": "Actor",
                "type": "object",
                "description": "Who made the change.",
                "properties": {
                  "session": {
                    "type": "string",
                    "description": "MCP session id."
                  },
                  "harness": {
                    "type": "string",
                    "description": "App running the agent."
                  },
                  "harness_version": {
                    "type": "string"
                  },
                  "model": {
                    "type": "string",
                    "description": "Model id reported by the agent."
                  },
                  "tool": {
                    "type": "string",
                    "description": "Tool the agent called."
                  },
                  "auth": {
                    "type": "string",
                    "description": "Credential: owner, or the name of the token that made the request."
                  }
                }
              },
              "batch": {
                "type": "string",
                "description": "Without `table`: the batch the operation ran in (undo_migration on it reverts the batch)."
              },
              "tables": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Without `table`: every table the same operation (or batch) committed to, when there are several."
              }
            },
            "required": [
              "version",
              "timestamp",
              "operation",
              "operation_metrics",
              "engine_info"
            ]
          },
          "description": "Commits, newest first."
        },
        "tables": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Without `table`: every table with a transaction log (dropped ones included)."
        }
      },
      "required": [
        "history"
      ]
    }
  },
  {
    "name": "table_changes",
    "description": "Change data feed between two versions (both included, end defaults to latest): one entry\nper row change with its values plus `_change_type` (insert, delete, update_preimage,\nupdate_postimage, metadata), `_commit_version`, `_commit_timestamp`, `_operation`, `path`.\nUse it to answer \"what changed since …\" without diffing full tables.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "start_version": {
          "type": "integer"
        },
        "end_version": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "required": [
        "table",
        "start_version"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Table Changes",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "table": {
          "type": "string",
          "description": "Qualified table."
        },
        "changes": {
          "type": "array",
          "items": {
            "type": "object",
            "description": "A change; row changes also carry the row's column values.",
            "properties": {
              "_change_type": {
                "type": "string",
                "enum": [
                  "insert",
                  "delete",
                  "update_preimage",
                  "update_postimage",
                  "metadata"
                ]
              },
              "_commit_version": {
                "type": "integer"
              },
              "_commit_timestamp": {
                "type": "string"
              },
              "_operation": {
                "type": "string"
              },
              "path": {
                "type": "string",
                "description": "Row note path (row changes)."
              }
            },
            "required": [
              "_change_type",
              "_commit_version",
              "_commit_timestamp",
              "_operation"
            ],
            "additionalProperties": true
          },
          "description": "Oldest first."
        }
      },
      "required": [
        "table",
        "changes"
      ]
    }
  },
  {
    "name": "list_changes",
    "description": "Change feed across all tables: numbered row changes (`seq`), oldest first, from engine writes\nand from hand edits (`source: external`). Each has `table`, `kind` (insert, update, delete, move,\nmetastore, unreadable), `op` (the operation that made it), `path`, `row_id`, `changes` ({column: {before, after}}), `actor`, `migration_id`. Hand edits are compared in batches (0.7 s after the last vault change, at most 5 s after the first), in the order they happened, renames included. A hand edit that creates, changes, renames or removes a row is checked against the tables' rules (as check_table does) with the rows that link to it: the last event of each row in the batch has `violations` ([{path, violations: [{code, column | constraint (the CHECK's name), index, message}]}]), what the edit breaks (a rule a row already broke is not listed); empty when it breaks nothing, absent when nothing was checked (engine events, a check that failed). A hand edit of metastore.yaml that changes tables' entries checks every row of those tables: on its `metastore` event. At most 100 per event; `violations_total` then counts them all. A note renamed or moved by hand (a row or a plain note) has the links to its old path rewritten across the vault once the vault is quiet (4 s without a change; not while git pulls, rebases or merges; setting repairLinksOnHandMove, on by default), and its move event does not report them as broken_link: that repair's events (`op: repair_links`) follow the batch and name the moves in `cause` ([{path, old_path, seq}], `seq` of the row's move event). A hand edit that leaves a row's front matter unreadable (broken YAML) is a `kind: unreadable` event with one violation of code `unreadable`: every read leaves the row out until the note is fixed, and the fix is an update of the row's last readable state (an insert for a new note). Agents' tool calls (reported by MCP servers) are `kind: tool_call` events (`call`: tool, args, ok, duration_ms, value, served_by), returned only when `kinds` includes tool_call. Pass the returned\n`last` as `since` next time (`head` is the newest number); `wait_ms` (max 60000) waits for a new change (long poll); `limit` max 5000. `gap: true` means\nolder changes were dropped: re-read the tables. `where` filters rows as in select_rows (on the values after the change). Per-table versions: `table_changes`.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "since": {
          "type": "integer",
          "default": 0
        },
        "tables": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "kinds": {
          "anyOf": [
            {
              "items": {
                "enum": [
                  "insert",
                  "update",
                  "delete",
                  "move",
                  "metastore",
                  "tool_call",
                  "unreadable"
                ],
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "columns": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "where": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "exclude_actor": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "limit": {
          "type": "integer",
          "default": 500
        },
        "wait_ms": {
          "type": "integer",
          "default": 0
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "List Changes",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "events": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "seq": {
                "type": "integer",
                "description": "Sequence number."
              },
              "at": {
                "type": "string",
                "description": "ISO date-time."
              },
              "table": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "Qualified table, or null for a note outside any table."
              },
              "kind": {
                "type": "string",
                "enum": [
                  "insert",
                  "update",
                  "delete",
                  "move",
                  "metastore",
                  "tool_call",
                  "unreadable"
                ],
                "description": "The kind of change: insert, update, delete, move, metastore (metastore.yaml), tool_call, or unreadable (a hand edit left the row's front matter unreadable)."
              },
              "op": {
                "type": "string",
                "description": "The operation that made it (insert_row, update_row, undo_migration, repair_links, …); absent for hand edits."
              },
              "path": {
                "type": "string"
              },
              "old_path": {
                "type": "string",
                "description": "Previous path (move)."
              },
              "row_id": {
                "type": "string",
                "description": "Row id."
              },
              "changes": {
                "type": "object",
                "description": "Changed columns: {before, after}.",
                "additionalProperties": {
                  "type": "object",
                  "properties": {
                    "before": {
                      "description": "Any JSON value."
                    },
                    "after": {
                      "description": "Any JSON value."
                    }
                  }
                }
              },
              "source": {
                "type": "string",
                "enum": [
                  "engine",
                  "external"
                ]
              },
              "row": {
                "type": "object",
                "description": "Row values after the change (before it, for a delete).",
                "additionalProperties": true
              },
              "actor": {
                "title": "Actor",
                "type": "object",
                "description": "Who made the change.",
                "properties": {
                  "session": {
                    "type": "string",
                    "description": "MCP session id."
                  },
                  "harness": {
                    "type": "string",
                    "description": "App running the agent."
                  },
                  "harness_version": {
                    "type": "string"
                  },
                  "model": {
                    "type": "string",
                    "description": "Model id reported by the agent."
                  },
                  "tool": {
                    "type": "string",
                    "description": "Tool the agent called."
                  },
                  "auth": {
                    "type": "string",
                    "description": "Credential: owner, or the name of the token that made the request."
                  }
                }
              },
              "migration_id": {
                "type": "string",
                "description": "Journal id of the engine operation."
              },
              "call": {
                "type": "object",
                "description": "The MCP tool call, for kind tool_call.",
                "properties": {
                  "tool": {
                    "type": "string"
                  },
                  "args": {
                    "type": "object",
                    "additionalProperties": true
                  },
                  "ok": {
                    "type": "boolean"
                  },
                  "duration_ms": {
                    "type": "number"
                  },
                  "value": {
                    "description": "The result, or the error text (long values cut)."
                  },
                  "summary": {
                    "type": "object",
                    "additionalProperties": true,
                    "description": "The result's top-level scalars, and lists as their length."
                  },
                  "served_by": {
                    "type": "string",
                    "description": "\"engine\", or the MCP server that ran a tool of its own."
                  },
                  "result_chars": {
                    "type": "integer"
                  },
                  "result_tokens": {
                    "type": "integer"
                  },
                  "session": {
                    "type": "string"
                  }
                },
                "required": [
                  "tool",
                  "args",
                  "ok",
                  "duration_ms",
                  "value",
                  "served_by"
                ]
              },
              "violations": {
                "type": "array",
                "description": "External insert / update / move / delete (the last event of the row in its batch): what the edit breaks, the row's rules and those of the rows linking to it (a rule broken before the edit is not listed); external schema event: what the rows of the tables it changed break. Empty when nothing is broken; absent when nothing was checked. At most 100 (see violations_total).",
                "items": {
                  "type": "object",
                  "description": "The violations of one row.",
                  "properties": {
                    "path": {
                      "type": "string",
                      "description": "The row that breaks the rule: the edited row or a row linking to it."
                    },
                    "violations": {
                      "type": "array",
                      "items": {
                        "title": "ExternalViolation",
                        "type": "object",
                        "properties": {
                          "code": {
                            "type": "string",
                            "enum": [
                              "required",
                              "type",
                              "min",
                              "max",
                              "step",
                              "enum",
                              "broken_link",
                              "ref",
                              "unique",
                              "unknown_column",
                              "check",
                              "cycle",
                              "vocabulary",
                              "unreadable"
                            ],
                            "description": "Kind of violation."
                          },
                          "column": {
                            "type": "string",
                            "description": "Column the violation is about (all codes but check and unreadable)."
                          },
                          "index": {
                            "type": "integer",
                            "description": "The item of a list column, from 0."
                          },
                          "constraint": {
                            "type": "string",
                            "description": "The CHECK's name (code check)."
                          },
                          "message": {
                            "type": "string",
                            "description": "Agent-readable explanation."
                          }
                        },
                        "required": [
                          "code",
                          "message"
                        ]
                      }
                    }
                  },
                  "required": [
                    "path",
                    "violations"
                  ]
                }
              },
              "violations_total": {
                "type": "integer",
                "description": "How many violations there are in all, when `violations` holds only the first 100."
              },
              "cause": {
                "type": "array",
                "description": "An engine write that follows hand edits (operation repair_links: the links repaired after notes were renamed or moved by hand): those moves.",
                "items": {
                  "type": "object",
                  "properties": {
                    "path": {
                      "type": "string",
                      "description": "The note's path after the move."
                    },
                    "old_path": {
                      "type": "string",
                      "description": "Its path before the move."
                    },
                    "seq": {
                      "type": "integer",
                      "description": "The move's event, when the note is a row."
                    }
                  },
                  "required": [
                    "path",
                    "old_path"
                  ]
                }
              }
            },
            "required": [
              "seq",
              "at",
              "table",
              "kind",
              "path",
              "source"
            ]
          },
          "description": "Matching changes, oldest first."
        },
        "last": {
          "type": "integer",
          "description": "Pass as `since` next time."
        },
        "head": {
          "type": "integer",
          "description": "Newest sequence number."
        },
        "gap": {
          "type": "boolean",
          "description": "Events after `since` were dropped by retention: re-read the tables."
        }
      },
      "required": [
        "events",
        "last",
        "head"
      ]
    }
  },
  {
    "name": "list_webhooks",
    "description": "Webhooks of the change feed: id, url, filter (tables, ops, columns, exclude_actor), `cursor` (last change delivered), `status` (ok, failing, disabled), `last_delivery`, `last_error`. Secrets are not shown.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "annotations": {
      "title": "List Webhooks",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "webhooks": {
          "type": "array",
          "items": {
            "title": "Webhook",
            "type": "object",
            "description": "A webhook of the change feed (its secret is never listed).",
            "properties": {
              "id": {
                "type": "string",
                "description": "Webhook id (wh_…)."
              },
              "url": {
                "type": "string",
                "description": "Receiver URL."
              },
              "tables": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "kinds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "insert",
                    "update",
                    "delete",
                    "move",
                    "metastore",
                    "tool_call",
                    "unreadable"
                  ]
                }
              },
              "columns": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "exclude_actor": {
                "type": "string"
              },
              "where": {
                "type": "object",
                "description": "Row filter.",
                "additionalProperties": true
              },
              "enabled": {
                "type": "boolean"
              },
              "cursor": {
                "type": "integer",
                "description": "Last sequence number delivered (or skipped by the filter)."
              },
              "created_at": {
                "type": "string",
                "description": "ISO date-time."
              },
              "last_delivery": {
                "type": "string",
                "description": "ISO date-time of the last delivery."
              },
              "last_error": {
                "type": "string"
              },
              "failures": {
                "type": "integer",
                "description": "Consecutive failed deliveries."
              },
              "status": {
                "type": "string",
                "enum": [
                  "ok",
                  "failing",
                  "disabled"
                ],
                "description": "Delivery state."
              }
            },
            "required": [
              "id",
              "url",
              "enabled",
              "cursor",
              "created_at",
              "failures",
              "status"
            ]
          }
        }
      },
      "required": [
        "webhooks"
      ]
    }
  },
  {
    "name": "create_webhook",
    "description": "Push row changes to a URL (a service that would rather be called than poll `list_changes`): batches of up to 100 events POSTed as `{webhook, events, last}`, signed with `X-Datanotes-Signature: sha256=<HMAC of the body>`, retried with backoff until a 2xx. Events are those of `list_changes` (hand edits with their `violations`; the hand edits the service has seen are recorded before it stops). Starts from now unless `since`. Returns the webhook with its `secret` — shown only here: give it to the receiver. Only on the user's explicit request: a webhook sends the database's changes (and, with `since`, its past ones) to that address.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "url": {
          "type": "string"
        },
        "tables": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "kinds": {
          "anyOf": [
            {
              "items": {
                "enum": [
                  "insert",
                  "update",
                  "delete",
                  "move",
                  "metastore",
                  "tool_call",
                  "unreadable"
                ],
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "columns": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "exclude_actor": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "where": {
          "anyOf": [
            {
              "additionalProperties": true,
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "since": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "required": [
        "url"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Create Webhook",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    },
    "sensitive": {
      "result": [
        "secret"
      ]
    },
    "responseSchema": {
      "type": "object",
      "description": "The webhook created, with its secret.",
      "properties": {
        "id": {
          "type": "string",
          "description": "Webhook id (wh_…)."
        },
        "url": {
          "type": "string",
          "description": "Receiver URL."
        },
        "tables": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "kinds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "insert",
              "update",
              "delete",
              "move",
              "metastore",
              "tool_call",
              "unreadable"
            ]
          }
        },
        "columns": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "exclude_actor": {
          "type": "string"
        },
        "where": {
          "type": "object",
          "description": "Row filter.",
          "additionalProperties": true
        },
        "enabled": {
          "type": "boolean"
        },
        "cursor": {
          "type": "integer",
          "description": "Last sequence number delivered (or skipped by the filter)."
        },
        "created_at": {
          "type": "string",
          "description": "ISO date-time."
        },
        "last_delivery": {
          "type": "string",
          "description": "ISO date-time of the last delivery."
        },
        "last_error": {
          "type": "string"
        },
        "failures": {
          "type": "integer",
          "description": "Consecutive failed deliveries."
        },
        "status": {
          "type": "string",
          "enum": [
            "ok",
            "failing",
            "disabled"
          ],
          "description": "Delivery state."
        },
        "secret": {
          "type": "string",
          "description": "HMAC secret for X-Datanotes-Signature: shown only here."
        }
      },
      "required": [
        "id",
        "url",
        "enabled",
        "cursor",
        "created_at",
        "failures",
        "status",
        "secret"
      ]
    }
  },
  {
    "name": "delete_webhook",
    "description": "Stop and remove a webhook (by `id` from list_webhooks).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Delete Webhook",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "deleted": {
          "type": "boolean",
          "description": "Always true (an unknown id is a 400)."
        }
      },
      "required": [
        "deleted"
      ]
    }
  },
  {
    "name": "restore_table",
    "description": "RESTORE TABLE to a `version` or `timestamp`: rows and definition return to that state —\nrows added since are deleted, changed rows get their old content, removed rows come back (a\ndropped table is re-created). History is not rewritten: the restore is a new version, and\n`undo_migration` reverts it. Refused (rows listed, with the way out) when the rows it writes, or\nrows that link to them, would break a CHECK that follows links or a `ref_where` / `ref_by` (as the\nrestored definition has them: a rule added since does not hold the old rows). Run with\n`dry_run` first and show the user what changes.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "version": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "timestamp": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Restore Table",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "restore_database",
    "description": "RESTORE DATABASE to a `timestamp` (each table as of its last version committed at or before it) or\nto `before_migration` (a `migration_id` or a `batch`: every table as it was just before that operation\nran — to rewind an agent's run). Every table that keeps a transaction log goes back, rows and\ndefinition: rows added since are deleted, changed rows get their old content, removed rows come back;\na table created since is dropped with its rows moved to its archive folder (as drop_table with\nmode \"archive\": nothing is hard-deleted), a table dropped since comes back. Tables already as\nthey were are left alone (`unchanged`, no new version). One operation: each restored table gets a\nRESTORE version, all with one `migration_id`, and `undo_migration` on it reverts them all. Refused as a\nwhole, nothing written (rows listed, with the way out), when a row it leaves would break a CHECK that\nfollows links or a `ref_where` / `ref_by`, across tables, as the restored definitions have them.\nTables without a log (history off, or vacuumed before that time) cannot be rewound: they stay as they\nare, listed in `skipped` with the reason (tell the user). Views, bases and the database settings are\nnot rewound (the logs keep tables), nor a rename or move of a table (undo_migration on it does that).\nReturns `restored_to`, `tables` (per table: `action` restore / drop / recreate, `version`,\n`creates`, `texts`, `deletes`, `archived`), `unchanged` and `skipped`. Run with `dry_run` first and show the user what changes; describe_history without `table` shows the moments.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "timestamp": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "before_migration": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "type": "object"
    },
    "annotations": {
      "title": "Restore Database",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "RestoreDatabaseResult",
      "type": "object",
      "description": "Result of restore_database: a write operation's result plus what it does to each table. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        },
        "restored_to": {
          "type": "string",
          "description": "The moment restored (ISO date-time): `timestamp`, or the last millisecond before the first commit of `before_migration`; given back as `timestamp`, it names the same state."
        },
        "tables": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "action": {
                "type": "string",
                "enum": [
                  "restore",
                  "drop",
                  "recreate"
                ],
                "description": "restore: rows and/or definition go back; drop: the table did not exist then (definition removed, rows archived); recreate: dropped since, it comes back."
              },
              "version": {
                "anyOf": [
                  {
                    "type": "integer"
                  },
                  {
                    "type": "null"
                  }
                ],
                "description": "The version of its log restored; null when the table did not exist then."
              },
              "definition_changed": {
                "type": "boolean",
                "description": "Its entry in metastore.yaml changes."
              },
              "creates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Rows re-created."
              },
              "texts": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Rows that get their old text back."
              },
              "deletes": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Rows created since, deleted (undo puts them back)."
              },
              "archived": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "from": {
                      "type": "string"
                    },
                    "to": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "from",
                    "to"
                  ]
                },
                "description": "Rows of a dropped table moved to its archive folder."
              }
            },
            "required": [
              "table",
              "action",
              "version",
              "definition_changed",
              "creates",
              "texts",
              "deletes",
              "archived"
            ]
          },
          "description": "The tables that change."
        },
        "unchanged": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Logged tables already as they were then (no new version)."
        },
        "skipped": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string"
              },
              "reason": {
                "type": "string"
              }
            },
            "required": [
              "table",
              "reason"
            ]
          },
          "description": "Tables that cannot be rewound (no transaction log, or not that far back), with the reason."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts",
        "restored_to",
        "tables",
        "unchanged",
        "skipped"
      ]
    }
  },
  {
    "name": "vacuum_table",
    "description": "Delete transaction-log history older than `retain_from_version` (default: keep only the\nlatest version); time travel before it becomes impossible. Rows are not touched. `dry_run`\ndefaults to true: it lists the log files that would go. Only on the user's explicit request.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "retain_from_version": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "dry_run": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Vacuum Table",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "table": {
          "type": "string"
        },
        "retained_from": {
          "type": "integer",
          "description": "Oldest version still available for time travel."
        },
        "deleted": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Log files deleted (or to delete, on a dry run)."
        },
        "dry_run": {
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "retained_from",
        "deleted",
        "dry_run"
      ]
    }
  },
  {
    "name": "add_constraint",
    "description": "ALTER TABLE ADD CONSTRAINT `name` CHECK: `check` is a where filter every row must match,\ne.g. `{\"value\": {\"gte\": 1, \"lte\": 5}}`. A condition on a column the row leaves empty passes, like SQL;\ninside `or` / `and` / `not` an empty value is tested as it is (`{\"exists\": true}` there fails).\nA key may follow a link column to the row it names, as in queries: `{\"parent.kind\": \"project\"}`\n(further dots follow further links). An empty link passes at the top level and fails inside `or` / `and` /\n`not`; only the first link of a longer path is skipped when empty (`parent.parent.kind` fails for a row\nwhose parent has no parent). A link to a row that does not exist fails; on a list of links every linked\nrow must match. `not` turns that into a pass: `{\"not\": {\"parent.kind\": \"area\"}}` passes a link to a\nmissing row, so add `\"parent.kind\": {\"exists\": true}` to require a real one. Links resolve as in the\nvault (by path, from the row's note: same-named rows in two folders stay apart); renaming or moving a\nlinked row keeps them (they follow it).\nRefused while existing rows violate it (they are listed); then enforced on every write, by the same rule.\nA write that changes a linked row re-checks the rows that link to it and is refused, listing them, when\nit breaks them, naming the changed row (in a batch, re-link them first: each step is checked on the vault\nthe earlier ones left); the inverse links a write adds, undo_migration and restore_table are checked too.\nrename_column / rename_value follow into CHECKs; drop_column of a column a CHECK reads is refused.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "check": {
          "additionalProperties": true,
          "type": "object"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "name",
        "check"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Add Constraint",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "drop_constraint",
    "description": "Remove the CHECK constraint `name` from `table`.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table",
        "name"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Drop Constraint",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "create_view",
    "description": "Create (or `replace`) a view: a named select stored in metastore.yaml. Name it with the prefix\n`vw_` (e.g. `vw_open_tasks`): views share names and folders with tables. `query` takes the\nselect_rows parameters (table, columns, where, order_by, limit, join, group_by, aggregates, expand;\nrelative dates keep it current) and must run now. Or `query: {union: [{table, columns, where}, …],\ncolumns, where, order_by, limit, expand}` stacks the rows of several tables (UNION ALL, each row\ntagged `_source`). Its filters may read the note the view is shown for: `{this.<property>}`\n(`{this.date+1d}`, `{this.date-1w}` shift a date), `{this.link}`, `{this.name}`, `{this.path}`,\nfilled in from select_rows `this_note` (one view serves every daily note, every project note).\n`description` and `aliases` let agents find it; `labels` are column headings. Views are selected with\n`select_rows(table=<view>)`, which may narrow them further (where, columns, order_by, limit; a `where`\noperator the view already has on a column replaces it). A view writes no note: it lives only in\nmetastore.yaml.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
        },
        "query": {
          "additionalProperties": true,
          "type": "object"
        },
        "catalog": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "schema": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "description": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "What the view shows, for agents and people."
        },
        "aliases": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "labels": {
          "anyOf": [
            {
              "additionalProperties": {
                "type": "string"
              },
              "type": "object"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "replace": {
          "default": false,
          "type": "boolean"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "name",
        "query"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Create View",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "drop_view",
    "description": "Remove a view from `metastore.yaml` (undo with `undo_migration`).\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "view": {
          "type": "string"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "view"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Drop View",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "clone_table",
    "description": "CREATE TABLE `target` CLONE `source`: same definition plus independent copies of its rows\n(deep clone), optionally as of a `version` / `timestamp`. `copy_rows: false` copies the\ndefinition only (CREATE TABLE LIKE). `target`: `catalog.schema.table`, `schema.table` (in the\nsource's catalog) or a name (source's catalog and schema). Useful for experiments, e.g. a sandbox copy\nin the `agent` catalog. The clone is a new table, so it needs the descriptions create_table does: a\nsource without them is refused, naming what to describe first (alter_table, alter_column). A past\nversion lacking one gets the one the source has now.\n\nThe schema changes only through operations like this one: never edit metastore.yaml by hand (no validation, no undo).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "source": {
          "type": "string"
        },
        "target": {
          "type": "string"
        },
        "version": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "timestamp": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "copy_rows": {
          "default": true,
          "type": "boolean",
          "description": "Copy the rows (default); false copies the definition only (CREATE TABLE LIKE)."
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "source",
        "target"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Clone Table",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "recompute_columns",
    "description": "Bring generated and identity columns up to date (all rows, or only `paths`), e.g. after\nrows were edited by hand (an editor, git, sync) or a generated expression changed with `alter_column`.\nAlso gives rows without an `id` a new one, and a duplicated note (same `id` as an older row)\na new id. `new_ids=true` regenerates every id in scope (new ones on every call): only on the user's\nexplicit request.\n`check_table` reports stale values with code `generated`. No-op when nothing is stale;\notherwise journaled (undo_migration) and a RECOMPUTE version in the table's history.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "table": {
          "type": "string"
        },
        "paths": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "new_ids": {
          "default": false,
          "type": "boolean"
        },
        "dry_run": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "table"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Recompute Columns",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "responseSchema": {
      "title": "OpResult",
      "type": "object",
      "description": "Result of a write operation. A refusal (ok false) is answered with HTTP 422, a failed write with 500, so a 2xx body has ok true.",
      "properties": {
        "ok": {
          "type": "boolean",
          "description": "True when the operation was applied (or, on a dry run, would be)."
        },
        "op": {
          "type": "string",
          "description": "The operation, by the name it was called with (e.g. insert_row, create_table, recompute_columns)."
        },
        "dry_run": {
          "type": "boolean",
          "description": "True when nothing was written (preview)."
        },
        "migration_id": {
          "type": "string",
          "description": "Journal id of the applied operation: pass it to undo_migration. Absent on a dry run."
        },
        "notes_changed": {
          "type": "integer",
          "description": "Notes whose front matter or body were written."
        },
        "files_created": {
          "type": "integer",
          "description": "Files created."
        },
        "files_moved": {
          "type": "integer",
          "description": "Files moved or renamed."
        },
        "files_deleted": {
          "type": "integer",
          "description": "Files deleted or archived."
        },
        "references_updated": {
          "type": "integer",
          "description": "Links rewritten in other notes."
        },
        "conflicts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note or file path."
              },
              "message": {
                "type": "string",
                "description": "Why the operation cannot proceed."
              }
            },
            "required": [
              "path",
              "message"
            ]
          },
          "description": "Reasons the operation was refused (empty on success)."
        },
        "violations": {
          "type": "array",
          "items": {
            "title": "RowViolations",
            "type": "object",
            "description": "The violations of one row.",
            "properties": {
              "path": {
                "type": "string",
                "description": "Row note path."
              },
              "violations": {
                "type": "array",
                "items": {
                  "title": "Violation",
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "description": "The column the violation is about (every code but check and unreadable)."
                    },
                    "index": {
                      "type": "integer",
                      "description": "The item of a list column that breaks the rule, from 0."
                    },
                    "constraint": {
                      "type": "string",
                      "description": "The CHECK's name (code check)."
                    },
                    "code": {
                      "type": "string",
                      "enum": [
                        "required",
                        "inverse",
                        "type",
                        "min",
                        "max",
                        "step",
                        "enum",
                        "broken_link",
                        "ref",
                        "unique",
                        "unknown_column",
                        "check",
                        "generated",
                        "cycle",
                        "vocabulary",
                        "unreadable"
                      ],
                      "description": "Kind of violation."
                    },
                    "message": {
                      "type": "string",
                      "description": "Agent-readable explanation."
                    },
                    "value": {
                      "description": "The offending value, when there is one."
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ]
                },
                "description": "What is wrong with this row."
              }
            },
            "required": [
              "path",
              "violations"
            ]
          },
          "description": "Rows that would break the table's rules (empty on success)."
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Vault path."
              },
              "error": {
                "type": "string",
                "description": "What went wrong."
              }
            },
            "required": [
              "path",
              "error"
            ]
          },
          "description": "Files that could not be written (empty on success)."
        },
        "rolled_back": {
          "type": "boolean",
          "description": "Set when a write failed partway (`failed`): true when the engine put back what it had written, so nothing is left written; false when that rollback failed too (`failed` names the files left, and undo_migration on `migration_id` retries it)."
        },
        "planned_edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Note path."
              },
              "set": {
                "type": "object",
                "description": "Front matter keys set, with their new values.",
                "additionalProperties": true
              },
              "remove": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Front matter keys removed."
              },
              "body": {
                "type": "boolean",
                "description": "True when the note body changes too."
              }
            },
            "required": [
              "path",
              "set",
              "remove"
            ]
          },
          "description": "Front matter edits per note (planned, or made)."
        },
        "planned_creates": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths of notes created."
        },
        "planned_moves": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "string"
              },
              "to": {
                "type": "string"
              }
            },
            "required": [
              "from",
              "to"
            ]
          },
          "description": "Files moved: from → to."
        },
        "planned_deletes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Paths deleted (or archived)."
        },
        "planned_texts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Files rewritten whole, e.g. metastore.yaml for DDL."
        },
        "commits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "table": {
                "type": "string",
                "description": "Qualified table."
              },
              "version": {
                "type": "integer",
                "description": "New log version."
              },
              "operation": {
                "type": "string",
                "description": "Log operation, e.g. WRITE."
              }
            },
            "required": [
              "table",
              "version",
              "operation"
            ]
          },
          "description": "Transaction-log commits written (tables with history on)."
        },
        "links_added": {
          "type": "array",
          "items": {
            "title": "LinkAdded",
            "type": "object",
            "description": "A link the write added in place of a mention.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the link was written into."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "target": {
                "type": "string",
                "description": "Vault path of the note it links."
              },
              "link": {
                "type": "string",
                "description": "The link written in place of the mention."
              }
            },
            "required": [
              "path",
              "text",
              "target",
              "link"
            ]
          },
          "description": "Links the write added to the text it wrote: the notes the text mentions by name (automatic links). Present when there is one."
        },
        "ambiguous_mentions": {
          "type": "array",
          "items": {
            "title": "LinkAmbiguous",
            "type": "object",
            "description": "A mention left as text: more than one note could be meant.",
            "properties": {
              "path": {
                "type": "string",
                "description": "The note the mention is in."
              },
              "text": {
                "type": "string",
                "description": "The mention, as written."
              },
              "reason": {
                "type": "string",
                "enum": [
                  "same_name",
                  "adjacent",
                  "overlap",
                  "part_of_name",
                  "sentence_start"
                ],
                "description": "same_name: several notes have this name; adjacent: names of different notes side by side, which may be one name; overlap: names of notes overlap; part_of_name: a capitalized word next to it suggests a longer name; sentence_start: a one-word name at the start of a sentence, a line, a list item or a label, where its capital says nothing."
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Vault paths of the notes it may name."
              },
              "context": {
                "type": "string",
                "description": "The line around the mention."
              },
              "hint": {
                "type": "string",
                "description": "What to do: read the candidates, then link the right one with update_row and autolink: false, or leave the text."
              }
            },
            "required": [
              "path",
              "text",
              "reason",
              "candidates",
              "context",
              "hint"
            ]
          },
          "description": "Mentions left as text because the engine is not sure which note they name. Present when there is one: read the candidates and the context, then link the right one with update_row and autolink: false, or leave the text."
        }
      },
      "required": [
        "ok",
        "op",
        "dry_run",
        "notes_changed",
        "files_created",
        "files_moved",
        "files_deleted",
        "references_updated",
        "conflicts",
        "violations",
        "failed",
        "planned_edits",
        "planned_creates",
        "planned_moves",
        "planned_deletes",
        "planned_texts"
      ]
    }
  },
  {
    "name": "graph_neighbors",
    "description": "Direct neighbours of notes: what they link to (`out`) and what links to them (`in`,\nbacklinks), with counts per edge label. `direction`: out, in or both (default).\n\n`from_nodes` selects the notes: `{\"paths\": [...]}` and/or `{\"table\": ..., \"where\": {...}}`.\nEdges are labelled with their link column (`people`, `event`, …) or `link` for other links.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "from_nodes": {
          "additionalProperties": true,
          "type": "object"
        },
        "direction": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "out",
                "in",
                "both"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "edges": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "required": [
        "from_nodes"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Graph Neighbors",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "nodes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Start note."
              },
              "table": {
                "type": "string"
              },
              "counts": {
                "type": "object",
                "description": "Edges per `direction:label`.",
                "additionalProperties": {
                  "type": "integer"
                }
              },
              "edges": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "path": {
                      "type": "string"
                    },
                    "table": {
                      "type": "string"
                    },
                    "label": {
                      "type": "string"
                    },
                    "direction": {
                      "type": "string",
                      "enum": [
                        "out",
                        "in"
                      ]
                    }
                  },
                  "required": [
                    "path",
                    "label",
                    "direction"
                  ]
                }
              }
            },
            "required": [
              "path",
              "counts",
              "edges"
            ]
          },
          "description": "One entry per start note."
        }
      },
      "required": [
        "nodes"
      ]
    }
  },
  {
    "name": "graph_traverse",
    "description": "Breadth-first walk over links from `from_nodes` (`{\"paths\": [...]}` and/or `{\"table\", \"where\"}`).\n\n- `direction`: out (default, follow links), in (follow backlinks) or both.\n- `edges`: edge labels to follow (link columns such as `people`, `event`, or `link`).\n- `tables`: return only notes of these tables; `through`: only walk on through these tables.\n- `min_depth` (default 1) / `max_depth` (default 2, max 10), `limit` (default 500).\n\nEach node comes with `depth` and `via` (one shortest route). Example — moods tied to events\nwith Alice: from `{\"table\": \"person\", \"where\": {\"name\": \"Alice\"}}`, direction `in`, edges\n`[\"people\", \"event\"]`, tables `[\"mood\"]`, max_depth 2. Feed the paths to `select_rows` with\n`where: {\"path\": {\"in\": [...]}}` to aggregate them.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "from_nodes": {
          "additionalProperties": true,
          "type": "object"
        },
        "direction": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "out",
                "in",
                "both"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "edges": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "tables": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "through": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "min_depth": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "max_depth": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "limit": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "required": [
        "from_nodes"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Graph Traverse",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "start": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Start notes."
        },
        "nodes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string"
              },
              "table": {
                "type": "string"
              },
              "depth": {
                "type": "integer"
              },
              "via": {
                "type": "array",
                "items": {
                  "title": "GraphStep",
                  "type": "object",
                  "description": "One link followed.",
                  "properties": {
                    "from": {
                      "type": "string",
                      "description": "Note path the step starts at."
                    },
                    "label": {
                      "type": "string",
                      "description": "Edge label: the link column, or `link` for other links."
                    },
                    "direction": {
                      "type": "string",
                      "enum": [
                        "out",
                        "in"
                      ],
                      "description": "out: `from` links to `to`; in: `to` links to `from`."
                    },
                    "to": {
                      "type": "string",
                      "description": "Note path reached."
                    }
                  },
                  "required": [
                    "from",
                    "label",
                    "direction",
                    "to"
                  ]
                },
                "description": "One shortest route from a start note."
              }
            },
            "required": [
              "path",
              "depth",
              "via"
            ]
          },
          "description": "Notes reached, by depth."
        },
        "truncated": {
          "type": "boolean",
          "description": "`limit` was reached."
        }
      },
      "required": [
        "start",
        "nodes",
        "truncated"
      ]
    }
  },
  {
    "name": "graph_path",
    "description": "Shortest chain of links between two sets of notes (each `{\"paths\": [...]}` and/or\n`{\"table\", \"where\"}`): `found`, `length` and `path`: the steps (`from`, `label`, `direction`, `to`).\n`direction` both by default; `max_depth` default 6 (max 10).",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "from_nodes": {
          "additionalProperties": true,
          "type": "object"
        },
        "to_nodes": {
          "additionalProperties": true,
          "type": "object"
        },
        "direction": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "out",
                "in",
                "both"
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "edges": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "max_depth": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        }
      },
      "required": [
        "from_nodes",
        "to_nodes"
      ],
      "type": "object"
    },
    "annotations": {
      "title": "Graph Path",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "responseSchema": {
      "type": "object",
      "properties": {
        "found": {
          "type": "boolean"
        },
        "length": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Links on the path; null when none was found."
        },
        "via": {
          "type": "array",
          "items": {
            "title": "GraphStep",
            "type": "object",
            "description": "One link followed.",
            "properties": {
              "from": {
                "type": "string",
                "description": "Note path the step starts at."
              },
              "label": {
                "type": "string",
                "description": "Edge label: the link column, or `link` for other links."
              },
              "direction": {
                "type": "string",
                "enum": [
                  "out",
                  "in"
                ],
                "description": "out: `from` links to `to`; in: `to` links to `from`."
              },
              "to": {
                "type": "string",
                "description": "Note path reached."
              }
            },
            "required": [
              "from",
              "label",
              "direction",
              "to"
            ]
          },
          "description": "The links, in order (empty when not found or from = to)."
        },
        "from": {
          "type": "string",
          "description": "Start note of the path (found only)."
        },
        "to": {
          "type": "string",
          "description": "End note (found only)."
        }
      },
      "required": [
        "found",
        "length",
        "via"
      ]
    }
  }
];

/**
 * The kinds of operation, as the docs' reference groups them (one page each,
 * `reference/operations/<kind>`), like the statement kinds of a SQL reference.
 */
export const OPERATION_KINDS = {
  schema: { title: "Schema operations (DDL)", label: "Schema (DDL)", description: "Operations that define the database: tables, columns, constraints, bases and views." },
  rows: { title: "Row operations (DML)", label: "Rows (DML)", description: "Operations that write rows: insert, update, merge, delete, move, adopt and batch." },
  queries: { title: "Query operations", label: "Queries", description: "Operations that read rows and notes: select_rows, link targets, text and semantic search, the link graph." },
  history: { title: "History operations", label: "History", description: "Operations on the journal, a table's versions, the change feed and webhooks: undo, time travel, restore and vacuum." },
  auxiliary: { title: "Auxiliary operations", label: "Auxiliary", description: "Operations that describe and check the database, configure it and maintain its indexes." },
} as const;

export type OperationKind = keyof typeof OPERATION_KINDS;

/** The kind of every operation of {@link OPERATIONS} (tests/operation-kinds.test.ts: each has exactly one). */
export const OPERATION_KIND: Readonly<Record<string, OperationKind>> = {
  create_table: "schema",
  drop_table: "schema",
  alter_table: "schema",
  clone_table: "schema",
  add_column: "schema",
  rename_column: "schema",
  drop_column: "schema",
  alter_column: "schema",
  rename_value: "schema",
  comment_on: "schema",
  define_base: "schema",
  set_table_bases: "schema",
  add_constraint: "schema",
  drop_constraint: "schema",
  create_view: "schema",
  drop_view: "schema",
  insert_row: "rows",
  update_row: "rows",
  update_rows: "rows",
  merge_rows: "rows",
  delete_rows: "rows",
  move_rows: "rows",
  adopt_rows: "rows",
  batch: "rows",
  align_relations: "rows",
  recompute_columns: "rows",
  select_rows: "queries",
  list_link_targets: "queries",
  read_note: "queries",
  list_folder: "queries",
  search_notes: "queries",
  semantic_search: "queries",
  graph_neighbors: "queries",
  graph_traverse: "queries",
  graph_path: "queries",
  list_migrations: "history",
  undo_migration: "history",
  describe_history: "history",
  table_changes: "history",
  restore_table: "history",
  restore_database: "history",
  vacuum_table: "history",
  list_changes: "history",
  list_webhooks: "history",
  create_webhook: "history",
  delete_webhook: "history",
  list_tables: "auxiliary",
  describe_table: "auxiliary",
  describe_database: "auxiliary",
  configure_database: "auxiliary",
  check_table: "auxiliary",
  infer_table: "auxiliary",
  describe_semantic_index: "auxiliary",
  sync_semantic_index: "auxiliary",
};
