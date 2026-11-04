/**
 * A parse that answers a request — the viewer's syntax highlighting, the
 * branch guards a Steps or Flow card reads — runs on the server's one thread,
 * so a parse that does not finish takes every other request down with it.
 * Indexing parses in workers it can kill; these cannot be killed, so they are
 * cancelled instead: tree-sitter asks its progress callback as it goes, and a
 * `true` stops the parse. A free-format COBOL window handed to the
 * fixed-format grammar kept cobolcraft's Flow strip — and the whole viewer
 * after it — parsing for good.
 */

import type { Parser, Tree } from 'web-tree-sitter';

/** Longest a request-time parse may run before it is given up — far past any file that parses at all. */
export const REQUEST_PARSE_BUDGET_MS = 3000;

/**
 * Grammars handed their source in small chunks rather than as one string. Their
 * external scanner asks for the column of nearly every token (F#'s offside
 * rule), and each ask makes the wasm parser walk the string it was handed from
 * the start of its chunk: over one whole-file chunk that is quadratic, and real
 * F# parses about three times as fast in 128-character chunks.
 */
const CHUNKED_INPUT_LANGUAGES: ReadonlySet<string> = new Set(['fsharp']);

/** What `parser.parse` is handed for `source` in `language`: the string, or a callback serving it in chunks. */
export function parserInput(source: string, language: string): string | ((index: number) => string) {
  if (!CHUNKED_INPUT_LANGUAGES.has(language)) return source;
  return (index) => {
    let end = index + 128;
    // A surrogate pair is never cut in two.
    if (end < source.length && (source.charCodeAt(end - 1) & 0xfc00) === 0xd800) end++;
    return source.slice(index, end);
  };
}

/** `parser.parse(source)` for a file in `language`, or null when it runs past the budget. */
export function parseWithinBudget(parser: Parser, source: string, language: string, budgetMs = REQUEST_PARSE_BUDGET_MS): Tree | null {
  const deadline = Date.now() + budgetMs;
  // The runtime hands the callback's return value to the parser: `true` cancels.
  const cancel = (() => Date.now() > deadline) as unknown as () => void;
  return parser.parse(parserInput(source, language), null, { progressCallback: cancel }) ?? null;
}
