/**
 * The command line options of the `datanotes` commands: `--name value` or `--name=value` for an
 * option with a value, `--name` for a flag. An option the command does not know is refused with
 * the closest one, so a typo never runs a command with its defaults.
 */

import { didYouMean } from "./guidance.js";

export interface OptionSpec {
  /** Options that take a value. */
  values?: readonly string[];
  /** Options that take none. */
  flags?: readonly string[];
}

/** A command line the command cannot run: what is wrong, and how to write it. */
export class CliOptionError extends Error {
  override readonly name = "CliOptionError";
  /** Every command and its options. */
  readonly docs = "https://datanotes.dev/reference/cli.md";
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface Options {
  /** The value of an option, when given. */
  get(name: string): string | undefined;
  /** Was a flag given? */
  has(name: string): boolean;
}

/** Read `argv` against what `command` takes; throws {@link CliOptionError} on anything else. */
export function readOptions(argv: readonly string[], spec: OptionSpec, command: string): Options {
  const values = new Set(spec.values ?? []);
  const flags = new Set(spec.flags ?? []);
  const known = [...values, ...flags].map((n) => `--${n}`);
  const given = new Map<string, string>();
  const set = new Set<string>();
  const takes = `${command} takes: ${known.join(", ") || "no options"} (${command} --help).`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new CliOptionError(`unexpected argument "${arg}"`, takes);
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (values.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new CliOptionError(`--${name} needs a value`, `Write --${name} <value> or --${name}=<value>. ${takes}`);
      given.set(name, value);
    } else if (flags.has(name)) {
      if (eq >= 0) throw new CliOptionError(`--${name} takes no value`, `Write --${name} alone. ${takes}`);
      set.add(name);
    } else {
      throw new CliOptionError(`unknown option --${name}`, `${didYouMean(`--${name}`, known)} ${takes}`.trim());
    }
  }
  return { get: (name) => given.get(name), has: (name) => set.has(name) };
}

/** The folder a command works on, and how to read it. */
export interface FolderArg {
  folder: string;
  /** `--database`: the folder is the database (metastore.yaml at its root); else a vault holding it. */
  atRoot: boolean;
}

/**
 * The folder of `--database` (the folder is the database) or `--vault` (a vault holding the
 * database in a subfolder), else DATANOTES_DATABASE or DATANOTES_VAULT: one of the two, never
 * both. Null when none is given and the command can do without (`required` false).
 */
export function folderArg(o: Options, env: Record<string, string | undefined>, command: string, required = true): FolderArg | null {
  const database = o.get("database");
  const vault = o.get("vault");
  const hint =
    "Pass --database <folder> when the folder is the database (metastore.yaml at its root), or --vault <folder> when it is a vault holding the database in a subfolder, such as one Obsidian opens.";
  const both = (a: string, b: string) => new CliOptionError(`${command}: ${a} and ${b} name the folder twice`, hint);
  if (database !== undefined && vault !== undefined) throw both("--database", "--vault");
  if (database !== undefined) return { folder: database, atRoot: true };
  if (vault !== undefined) return { folder: vault, atRoot: false };
  if (env.DATANOTES_DATABASE && env.DATANOTES_VAULT) throw both("DATANOTES_DATABASE", "DATANOTES_VAULT");
  if (env.DATANOTES_DATABASE) return { folder: env.DATANOTES_DATABASE, atRoot: true };
  if (env.DATANOTES_VAULT) return { folder: env.DATANOTES_VAULT, atRoot: false };
  if (!required) return null;
  throw new CliOptionError(`${command}: pass --database <folder> (or --vault <folder>)`, `${hint} DATANOTES_DATABASE or DATANOTES_VAULT work too.`);
}
