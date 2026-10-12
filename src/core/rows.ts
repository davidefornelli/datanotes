/**
 * Row operations (phase 34): insert, update, delete (archive by default), select, check.
 * Writes go through the same change-set / journal / undo machinery as DDL.
 *
 * This module only re-exports them from where they live:
 * - `path-templates.ts`: path and row templates (`{column:FORMAT}`), row names;
 * - `computed-columns.ts`: generated and identity columns, row ids, date-times completed;
 * - `where.ts`: `where` filters and CHECK predicates (compileWhere, compileCheck, resolveWithin);
 * - `check-links.ts`: CHECKs that follow links and the rows they read (CheckLinks);
 * - `link-targets.ts`: filtered link columns (`ref_where` / `ref_by`) and list_link_targets;
 * - `changeset-checks.ts`: the rules that follow links, on the state a change set leaves;
 * - `row-checks.ts`: CHECK constraints, hierarchy cycles and check_table;
 * - `external-edits.ts`: the checks of edits made outside the engine;
 * - `select.ts`: select (views, bases, unions, joins, groups, time travel);
 * - `row-ops.ts`: insert_row, merge_rows, recompute_columns, update_rows, update_row, delete_rows;
 * - `move-rows.ts`: move_rows and adopt_rows;
 * - `alter-table.ts`: alter_table (the table and its rows move together);
 * - `relations.ts`: sync_relations and align_relations (inverse link columns).
 */

export { formatDateTokens, MAX_NAME_SUFFIX, renderPathTemplate, renderRowTemplate, sanitizeFileName } from "./path-templates";
export { fillIdentities } from "./computed-columns";
export {
  compileCheck,
  compileWhere,
  FILE_COLUMNS,
  hasLogical,
  LOGICAL_KEYS,
  resolveWithin,
  rowGetter,
  type RowGetter,
  type Where,
  type WhereValue,
} from "./where";
export { CheckLinks, type MetastoreState } from "./check-links";
export { columnTargetViolations, linkOptions, type LinkOptionsInput, type LinkOptionsResult } from "./link-targets";
export { linkedCheckViolations, metastoreLeftBy } from "./changeset-checks";
export { CHECK_LIMIT, CHECK_MAX, checkTable, type CheckedRow, type CheckInput, type CheckResult, type CheckViolation } from "./row-checks";
export {
  checkChangedTables,
  checkExternalEdits,
  type ExternalCheck,
  type ExternalEdit,
  type ExternalViolation,
  type ExternalViolationCode,
} from "./external-edits";
export { select, UNION_BRANCH_MAX, type SelectInput, type SelectJoin, type SelectResult, type SelectUnionBranch } from "./select";
export {
  deleteRows,
  insertRow,
  mergeRows,
  recomputeColumns,
  updateRow,
  updateRows,
  type DeleteRowsInput,
  type InsertRowInput,
  type MergeRowsInput,
  type RecomputeInput,
  type UpdateRowInput,
  type UpdateRowsInput,
} from "./row-ops";
export { adoptRows, moveRows, type AdoptRowsInput, type MoveRowsInput } from "./move-rows";
export { alterTable, type AlterTableInput } from "./alter-table";
export { alignRelations, syncRelations, type AlignRelationsInput } from "./relations";
