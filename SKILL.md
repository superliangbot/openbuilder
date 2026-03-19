---
name: openbuilder
description: Query your meeting intelligence database — search transcripts, action items, topics, and more across all your Read AI meetings. Supports both keyword and semantic search.
homepage: https://github.com/superliangbot/openbuilder
metadata: { "openclaw": { "emoji": "📋", "requires": { "bins": ["node"] } } }
---

# OpenBuilder — Meeting Intelligence

Query your meeting database from Read AI. Supports keyword search (FTS5) and semantic search (vector embeddings).

## Quick Reference

All commands run from `~/projects/openbuilder` using `npx tsx src/cli.ts`.

### Database Status
```bash
npx tsx src/cli.ts db status
```

### Search (keyword — fast, exact matches)
```bash
npx tsx src/cli.ts search "topic sentences"
npx tsx src/cli.ts search "BrainLift" --limit 20
```

### Semantic Search (vector — meaning-based, requires embeddings + OPENAI_API_KEY)
```bash
npx tsx src/cli.ts semantic "what approaches were discussed for durable mastery?"
npx tsx src/cli.ts semantic "concerns about UI complexity" --type transcript --since 2026-03-01
```

### Meetings
```bash
npx tsx src/cli.ts meetings --since 2026-03-01
npx tsx src/cli.ts meetings --title "MasteryWrite"
npx tsx src/cli.ts meeting 01KM0TFJVPAHBQHYWY3992NC16
```

### Action Items
```bash
npx tsx src/cli.ts actions --assignee "Logan"
npx tsx src/cli.ts actions --since 2026-03-15
npx tsx src/cli.ts actions --meeting 01KM0TFJVPAHBQHYWY3992NC16
```

### Speakers & Metrics
```bash
npx tsx src/cli.ts speakers --since 2026-03-01
npx tsx src/cli.ts metrics --title "MasteryWrite"
```

### Sync New Meetings
```bash
npx tsx scripts/sync-all-meetings.ts    # Pull from Read AI
npx tsx src/cli.ts db ingest             # Ingest new raw files into SQLite
npx tsx src/cli.ts embed                 # Embed new meetings for semantic search
```

## When to use keyword vs semantic search
- **Keyword** (`search`): When looking for specific terms, names, or exact phrases
- **Semantic** (`semantic`): When looking for concepts, themes, or asking questions about what was discussed

## Output format
All commands output human-readable text by default. Add `--json` for programmatic output.

## Data location
- Database: `~/.openbuilder/meetings.db`
- Raw meeting data: `~/.openclaw/workspace/openbuilder/reports/`
- Transcripts: `~/.openclaw/workspace/openbuilder/transcripts/`
