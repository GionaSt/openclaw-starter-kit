# The LLM Wiki memory system

Pattern: a small always-loaded INDEX pointing to flat wiki PAGES, backed by
immutable RAW sources. Inspired by the "LLM wiki" idea (Karpathy): the model
maintains its own wiki about your world.

## Why not just one big memory file?

Context is expensive and truncated: a 200k-char memory file silently stops being
read. The wiki keeps *recall* cheap (index + targeted page reads) and *knowledge*
unbounded (any number of pages on disk).

## The three layers

1. **RAW** (`raw/`, `memory-archive/`): immutable sources: PDFs, transcripts, old
   daily notes. Never edited, only added. Read on demand.
2. **WIKI** (`memory/*.md`, flat): maintained pages. `hub-<area>.md` per macro-area,
   `entity-<name>.md` per recurring person/company, topic pages for everything else,
   `wiki-log.md` as append-only journal.
3. **INDEX** (`MEMORY.md`): one line per page, <15k chars hard limit. Loaded every
   main session. Never contains content.

## The RIPPLE rule (the one that prevents drift)

Every page update triggers: (1) index line refresh, (2) check of linked pages for
contradictions, fixing them too, (3) a line in `wiki-log.md`. Skipping ripple is
how wikis rot: page A says the project shipped, page B still says it's blocked.

## Maintenance

Monthly (cron or manual): distill daily notes older than 30 days into topic pages,
archive them, rewrite pages whose "history" layers obscure current state (current
state on top, history at the bottom), verify the index size, log everything.

## Practical effect

Ask "what did we decide about X in March?" and the assistant goes index → hub →
page → (only if needed) raw source, spending hundreds of tokens instead of tens of
thousands, and answers with a citation. That's the whole trick.
