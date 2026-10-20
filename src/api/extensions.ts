/**
 * `datanotes/extensions`: the module API for extension authors (`defineExtension`, `ExtensionToolError`
 * and the context types), the manifest parser (`parseManifest`) and the places extensions live on
 * disk. From the extension host on it also holds the loader MCP servers use.
 */

export * from "./extension-sdk.js";
export {
  parseManifest,
  validateManifest,
  ExtensionError,
  ExtensionManifestError,
  MANIFEST_FILE,
  EXT_DOCS,
  parseVersion,
  compareVersions,
  satisfiesEngine,
  bindRoles,
  rolesNamed,
  type ExtensionManifest,
  type ManifestTable,
  type ManifestColumn,
  type ManifestTool,
  type ManifestView,
  type ManifestBase,
  type ManifestMigration,
  type ManifestConstraint,
  type ColumnNeed,
  type SemVer,
} from "./extension-manifest.js";
export { extensionsHome, codeDir, tokenPath } from "./extension-files.js";
export {
  loadExtensions,
  validateModule,
  extensionDocs,
  tableAllowed,
  engineActor,
  sourceLabel,
  ClientTokens,
  type LoadOptions,
  type LoadedExtension,
  type ExtensionLoad,
  type ExtensionCaller,
  type ExtensionToolDefinition,
  type SkippedExtension,
  type SkipCode,
  type HostLog,
} from "./extension-host.js";
export { type DocsMount, type DocsLibrary } from "./docs.js";
export { RECORD_NAME, recordProblems, type InstalledExtension, type ExtensionList, type RecordTable, type ExtensionSourceRecord } from "./extension-record.js";
