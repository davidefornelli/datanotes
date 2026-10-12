/** The shape of an example chapter: examples that share one vault, shown on the guide pages (pages.ts). */

export interface Ctx {
  /** Answers of earlier steps stored with `save`. */
  saved: Record<string, any>;
  /** The answer of the previous call. */
  last: any;
  /** A vault file's text. */
  read(rel: string): string;
}

/** How long a step with `until` calls again before the build fails. */
export const UNTIL_TIMEOUT_MS = 20_000;

export interface Step {
  /** The operation, called as an agent calls it (the MCP tool of the same name). */
  op?: string;
  args?: Record<string, unknown> | ((ctx: Ctx) => Record<string, unknown>);
  /** Text shown before the call. */
  say?: string;
  /** The engine must refuse this call (the example shows the refusal). */
  refused?: boolean;
  /** Keep the answer for later steps (`ctx.saved[name]`). */
  save?: string;
  /** Returns a problem when the answer is not what the example claims; the build fails. */
  check?: (value: any, ctx: Ctx) => string | undefined | false;
  /** What part of the answer to show (default: all of it, long lists cut). */
  show?: (value: any) => unknown;
  /** Hide the answer (the call still runs and is checked). */
  quiet?: boolean;
  /** Show this vault file after the call; a step with no `op` only shows the file as it is now. */
  showFile?: string | ((ctx: Ctx) => string);
  /** Instead of a call: show the last request the examples' webhook receiver got (`ctx.saved.hookUrl`). */
  received?: boolean;
  /** Instead of a call: edit a note by hand, as a person in an editor would. */
  edit?: { path: string; text: string | ((current: string) => string) };
  /** Instead of a call: rename or move a note by hand, as a person in a file manager would. */
  move?: { from: string; to: string };
  /** Milliseconds to wait after the step (hand edits are picked up within a second or two). */
  wait?: number;
  /**
   * Call again until the answer holds this (at most {@link UNTIL_TIMEOUT_MS}), e.g. a long-polled
   * `list_changes` until the event of a hand edit arrives: no fixed wait.
   */
  until?: (value: any, ctx: Ctx) => boolean;
}

export interface Example {
  title: string;
  /** What the example shows, in a sentence or two. */
  say: string;
  steps: Step[];
  /** Text after the steps. */
  after?: string;
}

/**
 * A chapter: examples that run in order on one vault of their own (run.ts). Its examples are shown
 * on the guide pages of their area (pages.ts), not on a page of their own.
 */
export interface Chapter {
  slug: string;
  /** What the chapter's vault is about (in test and build messages). */
  title: string;
  /** Files of the vault before the first step (e.g. `datanotes/metastore.yaml`, notes). */
  files?: Record<string, string>;
  /** Engine settings for this chapter. */
  settings?: Record<string, unknown>;
  /** Calls run before the examples, not shown. */
  setup?: Step[];
  examples: Example[];
}

export interface StepResult {
  step: Step;
  ok: boolean;
  value: unknown;
  args?: Record<string, unknown>;
  file?: { path: string; text: string };
}
