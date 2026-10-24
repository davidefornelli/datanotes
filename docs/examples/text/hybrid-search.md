## Choose the search to use

The engine has three ways to search the notes:

| Operation | Finds | Use it for |
|---|---|---|
| `search` | Notes with any word of the query, ranked; with semantic search on, notes that mean the same too | Most searches, by agents and programs |
| `search_notes` | Notes with every word of the query, as text | Exact passages, such as a code or a name |
| `semantic_search` | Notes by meaning only | Vague questions, when semantic search is on |

## How the words rank the notes

`search` scores each note with BM25, the ranking of most search engines:

- **Rare words count more.** A word that few notes have says more than a word that every note has.
- **The name and the properties count more.** A word in the note's name, or in a value of its front matter, adds to its score. Property names, `id` and `table` don't count.
- **Every word counts.** A note with every word of the query ranks above a note with some of them.
- **Words in a row count more.** Two words next to each other, as in the query, add a little.

The engine ignores case and accents, so `Uovo` finds `uovo` and `perche` finds `perché`. It doesn't reduce words to a stem, because notes are in many languages: `uova` doesn't find `uovo`. Semantic search finds those other forms. A single letter is never searched, but a single digit is, so `6 mesi` works.

## Write a query

A query takes the syntax of `search_docs`:

- `"6 mesi"`: the words must appear in a row.
- `+uovo`: the word must appear.
- `-latte`: no note with the word is returned.
- Any other word only ranks the notes.

`tables` keeps the rows of some tables, by full or short name. `folder` keeps the notes of one folder. `limit` sets how many notes come back: 10 by default, at most 100.

## Fuse the words with the meaning

When semantic search is on, `search` also ranks the notes by meaning. It then fuses the two rankings with Reciprocal Rank Fusion. A note scores more for each ranking it is in, and more near the top of each.

Each hit says how the engine found it in `matched_by`: `words`, `meaning` or both. The answer's `meaning` field says what ran:

- `on`: both rankings, fused.
- `off`: semantic search is off, so only the words ranked.
- `failed`: the embedding provider failed, so only the words ranked. `meaning_error` says why.

The required and excluded words filter both rankings. `min_score` drops the passages of the meaning ranking below that similarity, from 0 to 1.

## What a token may search

A named token with [`read` patterns](/guides/security/tokens/#limit-what-a-token-can-read) searches only the notes it may read. A table it may not read, named exactly in `tables`, answers 403.
