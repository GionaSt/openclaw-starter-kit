# WIKI SCHEMA — memory system rules (LLM Wiki pattern)

This file is the SCHEMA: it says how memory is structured and how to maintain it.
Read it before any memory maintenance operation.

## 3 layers
1. **RAW (immutable)**: `raw/` in workspace root = PDFs and generated sources (never
   modify, only add). `memory-archive/` = old daily/micro notes no longer indexed.
   Read on demand.
2. **WIKI (maintained)**: `memory/*.md` FLAT (no subfolders: memory search indexes
   only the first level). Page types:
   - TOPIC/PROJECT pages: `<project>-*.md`
   - ENTITY pages: `entity-<name>.md` (people/companies/places that cut across
     topics) — hubs with links to topic pages.
   - HUB pages: `hub-<area>.md` — area index with links.
   - log: `wiki-log.md` (append-only, one line per operation).
3. **INDEX**: `MEMORY.md` in root = slim index ONLY (1 line per page: link + hook).
   HARD LIMIT: stay under ~15k characters (bootstrap truncates at 20k). Never paste
   content into the index.

## Conventions
- Internal links as `[[slug]]` where slug = filename without .md. Link liberally.
- Dates always ABSOLUTE (2026-07-22, never "yesterday").
- One page = one topic. Update the existing page, don't create a duplicate.
- Telegraphic high-density style is fine inside pages (save tokens).

## RIPPLE rule (anti-drift — documented failure mode #1 of this pattern)
When you update a page:
1. Update the matching line in MEMORY.md if the hook changed.
2. Check inbound/outbound `[[links]]`: if the new fact contradicts a linked page,
   fix THAT page too.
3. Append a line to `wiki-log.md`: `YYYY-MM-DD | action | page | notes`.

## Ingest (new information)
1. Pick the destination page (existing > new).
2. Write the distilled fact (not the raw transcript; raw goes to raw/ or memory-archive/).
3. Ripple (above).

## Query
1. First MEMORY.md (index), then memory search, then read only the relevant pages.
2. Cite `Source: path` when useful.

## DAILY USE (operating rules)
1. **Your human should never need to know paths.** If they ask for a file/PDF, find
   it (index → raw/) and send it as an attachment. Never answer "it's in raw/x".
2. **Newly generated PDFs**: generate → deliver → then MOVE the PDF into the right
   raw/ subfolder in the same turn. Root stays clean, always.
3. **New facts to remember**: first choice = update the existing topic page; quick
   session notes go to `memory/YYYY-MM-DD-HHMM.md` (the ingest buffer).
4. **Every wiki update** = ripple (above) + line in wiki-log. No exceptions.
5. **New recurring people/companies/places** → create `entity-*.md` and link it from hubs.
6. **Monthly maintenance** (cron, 1st of month): distill dated notes >30 days old
   into topic pages, move them to `memory-archive/daily/`, check drift (pages with
   layered "HISTORY" sections get rewritten: current state on top, history at the
   bottom), verify MEMORY.md <15k, append everything to wiki-log, short report to
   your human.
