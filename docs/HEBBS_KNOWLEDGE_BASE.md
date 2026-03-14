# RFC: Hebbs Knowledge Base for NanoClaw

**Status:** Draft
**Date:** 2026-03-14
**Author:** Auto-generated from architecture review

---

## 1. Problem Statement

NanoClaw's current knowledge system has three issues:

1. **Schema-in-prompt**: The company tracker is defined as 60+ lines of SQL in `groups/main/CLAUDE.md`. The agent runs raw `sqlite3` bash commands to create tables, insert rows, and query. If the prompt drifts or the agent hallucinates SQL, the data corrupts silently.

2. **No temporal reasoning**: Querying "what happened with COHR over the last month?" requires hand-written `ORDER BY created_at` queries. There's no native concept of time-ordered recall.

3. **CLAUDE.md bloat**: The main group's memory file is 430+ lines — half of which is SQL schemas, example queries, and intent-recognition tables. This eats context window and mixes concerns (preferences vs. knowledge structure).

### Current Flow

```
User: "track COHR, photonics play"
        │
        ▼
Agent reads CLAUDE.md (430 lines including SQL schema)
        │
        ▼
Agent runs: sqlite3 /workspace/group/companies.db "INSERT INTO companies ..."
        │
        ▼
companies.db lives inside groups/main/ (container-local)
```

**Failure modes:**
- Agent forgets to initialize the DB → crash
- Agent writes malformed SQL → silent data loss
- Agent can't do semantic search ("companies like COHR") → only exact SQL matches
- No way to ask "what happened in order?" without writing temporal SQL by hand

---

## 2. Proposed Solution: Hebbs Memory Engine

Replace the SQLite company tracker with [Hebbs](https://github.com/hebbs-ai/hebbs) — a Rust-based cognitive memory engine that provides structured remember/recall operations with four query strategies.

### Why Hebbs over SQLite?

| Concern | SQLite (current) | Hebbs (proposed) |
|---------|-------------------|-------------------|
| Schema management | 60 lines of SQL in CLAUDE.md | Zero schema — key-value with metadata |
| Store info | Raw `sqlite3` bash commands | `hebbs-cli remember "..." --entity-id X` |
| Query info | Hand-written SQL | `hebbs-cli recall "query" --strategy similarity` |
| Temporal queries | `ORDER BY created_at` | Native `--strategy temporal` |
| Semantic search | Not possible | Built-in vector similarity |
| Cross-entity links | Foreign keys + JOINs | Analogical recall finds patterns |
| Knowledge consolidation | Manual | `reflect()` auto-clusters into insights |
| Agent prompt burden | ~200 lines of SQL/examples | ~20 lines (entity naming conventions) |
| Failure modes | Silent SQL corruption | Typed CLI with error codes |

### What stays the same

**User preferences remain in markdown.** `CLAUDE.md` files continue to hold:
- Agent persona and personality
- Timezone and market hours
- Communication formatting rules
- Alert timing preferences
- Group configuration

Hebbs only replaces the **structured knowledge** layer (companies, topics, trades, research notes).

---

## 3. Hebbs Concepts

### 3.1 Core API

| Operation | Purpose | Example |
|-----------|---------|---------|
| `remember()` | Store a memory with metadata | Store company info, trade rationale, research note |
| `recall()` | Query with 4 strategies | Find related companies, get timeline, trace causes |
| `revise()` | Update a memory preserving history | Update thesis without losing original |
| `forget()` | Delete by staleness or explicit | Remove stale research |
| `reflect()` | Consolidate raw memories → insights | Auto-cluster "COHR" memories into themes |
| `insights()` | Query consolidated knowledge | "What do I know about photonics?" |

### 3.2 Four Recall Strategies

| Strategy | Question It Answers | Use Case |
|----------|---------------------|----------|
| **Similarity** | "What looks like this?" | "Companies related to photonics" |
| **Temporal** | "What happened, in order?" | "COHR timeline over last 3 months" |
| **Causal** | "What led to this outcome?" | "Why did I exit that trade?" |
| **Analogical** | "What pattern transfers here?" | "Any setup similar to COHR's breakout?" |

### 3.3 Memory Structure

Each memory has:

```
{
  content:    "COHR beat Q3 earnings, revenue up 15% YoY",
  importance: 0.85,           // 0-1, set at creation
  entity_id:  "company:COHR", // scoping — filters recall
  context: {                  // arbitrary metadata
    "type":   "earnings",
    "ticker": "COHR",
    "sector": "photonics",
    "market": "US"
  }
}
```

### 3.4 Scoring Formula

Results are ranked by composite score (weights are tunable):

```
score = (relevance × 0.50) + (recency × 0.20) + (importance × 0.20) + (reinforcement × 0.10)
```

- **Relevance**: Semantic similarity (vector distance)
- **Recency**: How recently created (decays over time)
- **Importance**: Set at encoding (0-1)
- **Reinforcement**: How often recalled (strengthens with use)

---

## 4. Entity Design

### 4.1 Entity ID Conventions

We use `entity_id` to scope memories to logical groups:

| Entity Type | entity_id Pattern | Example |
|-------------|-------------------|---------|
| Company | `company:{TICKER}` | `company:COHR`, `company:NVDA` |
| Topic/Theme | `topic:{name}` | `topic:photonics`, `topic:ai-infrastructure` |
| Trade | `trade:{TICKER}:{YYYY-MM-DD}` | `trade:COHR:2026-03-10` |
| Watchlist | `watchlist:{name}` | `watchlist:looking-for-entry` |
| General | (no entity_id) | Unscoped memories |

### 4.2 Context Metadata Schema

Each memory carries structured `context` metadata for filtering:

```json
// Company
{
  "type": "company",
  "ticker": "COHR",
  "sector": "photonics",
  "market": "US",
  "tags": ["portfolio", "silicon-photonics"]
}

// Trade
{
  "type": "trade",
  "ticker": "COHR",
  "direction": "buy",
  "entry_price": 85.50,
  "size": 100,
  "market": "US"
}

// Research note
{
  "type": "research",
  "ticker": "COHR",
  "source": "url",
  "url": "https://example.com/article"
}

// Topic
{
  "type": "topic",
  "category": "sector",
  "related_tickers": ["COHR", "IIVI", "LITE"]
}
```

### 4.3 Example Operations

**Store a company:**
```bash
hebbs-cli remember \
  "COHR: Coherent Corp. Silicon photonics leader. Thesis: AI datacenter \
   interconnect demand drives 30%+ revenue growth. US market, ticker COHR." \
  --entity-id "company:COHR" \
  --importance 0.9 \
  --context '{"type":"company","ticker":"COHR","sector":"photonics","market":"US","tags":["portfolio"]}'
```

**Store a trade:**
```bash
hebbs-cli remember \
  "Bought 100 shares COHR at $85.50. Entry based on Q3 earnings beat and \
   photonics sector momentum. Target $110, stop $75." \
  --entity-id "trade:COHR:2026-03-10" \
  --importance 0.95 \
  --context '{"type":"trade","ticker":"COHR","direction":"buy","entry_price":85.50,"size":100}'
```

**Store temporal event:**
```bash
hebbs-cli remember \
  "COHR announced partnership with TSMC for co-packaged optics. Stock up 8%." \
  --entity-id "company:COHR" \
  --importance 0.85 \
  --context '{"type":"event","ticker":"COHR"}'
```

**Query: "What do I know about COHR?"**
```bash
hebbs-cli recall "COHR Coherent Corp" \
  --entity-id "company:COHR" \
  --strategy similarity
```

**Query: "COHR timeline"**
```bash
hebbs-cli recall "COHR timeline" \
  --entity-id "company:COHR" \
  --strategy temporal
```

**Query: "Companies in photonics"**
```bash
hebbs-cli recall "photonics silicon photonics companies" \
  --strategy similarity
```

**Query: "Why did I buy COHR?"**
```bash
hebbs-cli recall "COHR buy rationale" \
  --entity-id "company:COHR" \
  --strategy causal
```

**Consolidate insights:**
```bash
hebbs-cli reflect --entity-id "company:COHR"
hebbs-cli insights --entity-id "company:COHR" --max-results 5
```

---

## 5. Architecture

### 5.1 Deployment Topology

```
┌───────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                                 │
│                                                               │
│  ┌─────────────────┐     ┌──────────────────────────────┐    │
│  │  NanoClaw        │     │  hebbs-server                │    │
│  │  (src/index.ts)  │     │  gRPC :6380 / HTTP :6381     │    │
│  │                  │     │                              │    │
│  │  Starts hebbs    │────→│  Data: ~/.hebbs/data/        │    │
│  │  as a service    │     │  ├─ RocksDB (storage)        │    │
│  │                  │     │  ├─ HNSW (vector index)      │    │
│  └────────┬─────────┘     │  └─ B-tree (temporal index)  │    │
│           │               └──────────┬───────────────────┘    │
│           │                          │                        │
│     ┌─────▼──────────────────────────▼────┐                   │
│     │  Container (nanoclaw-agent)          │                   │
│     │                                     │                   │
│     │  Agent reads CLAUDE.md for:         │                   │
│     │  • Preferences (markdown)           │                   │
│     │  • Entity conventions (10 lines)    │                   │
│     │                                     │                   │
│     │  Agent uses hebbs-cli for:          │                   │
│     │  • remember / recall / revise       │                   │
│     │  • Connects to host:6380 via        │                   │
│     │    CONTAINER_HOST_GATEWAY           │                   │
│     │                                     │                   │
│     │  hebbs-cli is installed in the      │                   │
│     │  container image (Dockerfile)       │                   │
│     └─────────────────────────────────────┘                   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 5.2 Container Connectivity

The agent container already has access to the host via `CONTAINER_HOST_GATEWAY` (used for the credential proxy on port 3001). Hebbs uses the same mechanism:

```
Container                          Host
─────────                          ────
hebbs-cli ──gRPC──→ host.docker.internal:6380 ──→ hebbs-server
```

Configuration inside container:
```bash
export HEBBS_SERVER="host.docker.internal:6380"
# or for environments where gateway differs:
export HEBBS_SERVER="${CONTAINER_HOST_GATEWAY}:6380"
```

### 5.3 Multi-Group Access

| Group | Access Level | Rationale |
|-------|-------------|-----------|
| Main | Read-write | Owns the knowledge base, can remember/recall/revise/forget |
| Non-main | Read-only (recall only) | Can query knowledge but cannot modify |

Hebbs supports this via **tenant_id** scoping. Main group uses the default tenant. Non-main groups get a read-only client configuration (no `remember` permission).

Alternatively, since `hebbs-cli` is a bash tool, we can control this at the skill level — the non-main skill instructions simply omit `remember`/`revise`/`forget` commands.

---

## 6. Changes Required

### 6.1 Host-Side Changes

| File | Change | Effort |
|------|--------|--------|
| `container/Dockerfile` | Add `hebbs-cli` installation (curl installer or copy binary) | Small |
| `src/container-runner.ts` | Pass `HEBBS_SERVER` env var to containers | Small |
| `src/index.ts` | (Optional) Start/verify hebbs-server on NanoClaw startup | Medium |
| `.env` | Add `HEBBS_API_KEY` if auth enabled | Small |
| Service config | Add hebbs-server as a systemd/launchd service | Small |

### 6.2 Container-Side Changes

| File | Change | Effort |
|------|--------|--------|
| `container/skills/knowledge-base/` | New skill with Hebbs usage instructions | Medium |
| (Installed via hebbs-skill repo) | Or clone `hebbs-ai/hebbs-skill` into skills dir | Small |

### 6.3 CLAUDE.md Changes

| File | Change | Lines Removed | Lines Added |
|------|--------|---------------|-------------|
| `groups/main/CLAUDE.md` | Remove Company Tracker section (SQL schema, examples, intent table) | ~220 lines | ~30 lines |
| `groups/main/CLAUDE.md` | Add Knowledge Base section (entity conventions, query examples) | — | (included above) |

**New CLAUDE.md section (replaces the 220-line company tracker):**

```markdown
## Knowledge Base (Hebbs)

You have a persistent knowledge base powered by Hebbs. Use `hebbs-cli` for all
knowledge operations — never use raw SQLite for company/trade/research data.

### Entity Conventions

| Type | entity_id | Example |
|------|-----------|---------|
| Company | `company:{TICKER}` | `company:COHR` |
| Topic | `topic:{name}` | `topic:photonics` |
| Trade | `trade:{TICKER}:{date}` | `trade:COHR:2026-03-10` |

### Context Fields

Always include in `--context`:
- `type`: company, trade, research, event, topic
- `ticker`: stock ticker (if applicable)
- `sector`: industry sector
- `market`: US, JP, UK, OTHER
- `tags`: array of labels (replaces watchlists)

### When to Remember

- User says "track X" or "add X" → remember company
- User shares a URL → fetch, summarize, remember as research
- User makes a trade → remember with direction, price, rationale
- User states a preference → store in CLAUDE.md (not Hebbs)
- User shares a photo → remember as image reference

### When to Recall

- User asks about a company → recall with entity_id
- User asks "what happened with X?" → strategy: temporal
- User asks "why did I..." → strategy: causal
- User asks "companies like X" → strategy: similarity
- User asks "show my watchlist" → recall by tag
```

### 6.4 Data Migration

One-time script to migrate existing `companies.db` into Hebbs:

```bash
#!/bin/bash
# migrate-companies-to-hebbs.sh
# Run once after Hebbs is set up

DB="/path/to/groups/main/companies.db"

# Migrate companies
sqlite3 "$DB" "SELECT name, ticker, sector, market, notes FROM companies" | while IFS='|' read -r name ticker sector market notes; do
  hebbs-cli remember \
    "$name ($ticker): $sector sector, $market market. $notes" \
    --entity-id "company:$ticker" \
    --importance 0.8 \
    --context "{\"type\":\"company\",\"ticker\":\"$ticker\",\"sector\":\"$sector\",\"market\":\"$market\"}"
done

# Migrate attachments
sqlite3 "$DB" "
  SELECT c.ticker, a.type, a.content, a.summary
  FROM attachments a JOIN companies c ON a.company_id = c.id
" | while IFS='|' read -r ticker type content summary; do
  hebbs-cli remember \
    "[$type] $summary: $content" \
    --entity-id "company:$ticker" \
    --importance 0.6 \
    --context "{\"type\":\"research\",\"ticker\":\"$ticker\",\"source\":\"$type\"}"
done

# Migrate watchlist memberships as tags
sqlite3 "$DB" "
  SELECT c.ticker, w.name
  FROM company_watchlists cw
  JOIN companies c ON cw.company_id = c.id
  JOIN watchlists w ON cw.watchlist_id = w.id
" | while IFS='|' read -r ticker watchlist; do
  hebbs-cli remember \
    "$ticker is in watchlist: $watchlist" \
    --entity-id "company:$ticker" \
    --importance 0.5 \
    --context "{\"type\":\"tag\",\"ticker\":\"$ticker\",\"tags\":[\"$watchlist\"]}"
done

echo "Migration complete. Verify with: hebbs-cli recall 'all companies' --strategy similarity"
```

---

## 7. Deployment Steps

### 7.1 Install Hebbs

```bash
# macOS
brew install hebbs-ai/tap/hebbs

# Linux
curl -sSf https://hebbs.ai/install | sh
```

### 7.2 Start Hebbs Server

```bash
# macOS (persistent service)
brew services start hebbs

# Linux (systemd)
cat > ~/.config/systemd/user/hebbs.service << 'EOF'
[Unit]
Description=Hebbs Memory Engine
After=network.target

[Service]
ExecStart=%h/.local/bin/hebbs-server start --data-dir %h/.hebbs/data
Restart=on-failure
Environment=HEBBS_AUTH_ENABLED=false

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now hebbs
```

### 7.3 Verify

```bash
hebbs-cli status --format json
hebbs-cli remember "test memory" --importance 0.5
hebbs-cli recall "test"
```

### 7.4 Install in Container

Add to `container/Dockerfile`:

```dockerfile
# Install Hebbs CLI for knowledge base access
RUN curl -sSf https://hebbs.ai/install | sh \
    && mv ~/.local/bin/hebbs-cli /usr/local/bin/
```

### 7.5 Pass Server Address to Container

Add to `src/container-runner.ts` in `buildContainerArgs()`:

```typescript
// Connect agent to host's Hebbs memory engine
args.push('-e', `HEBBS_SERVER=${CONTAINER_HOST_GATEWAY}:6380`);
```

### 7.6 Install Skill

```bash
git clone https://github.com/hebbs-ai/hebbs-skill.git container/skills/hebbs
```

Skills are auto-synced to containers on startup (existing `buildVolumeMounts` logic handles this).

### 7.7 Update CLAUDE.md

Replace the Company Tracker section with the Knowledge Base section (see 6.3 above).

### 7.8 Migrate Data

Run the migration script (see 6.4 above), then verify:

```bash
hebbs-cli recall "all companies" --strategy similarity --max-results 50
```

### 7.9 Rebuild Container

```bash
./container/build.sh
```

---

## 8. Comparison: Before vs After

### Before (current)

```
User: "what do I know about photonics companies?"
        │
        ▼
Agent reads CLAUDE.md → finds SQL schema → constructs query:
  sqlite3 /workspace/group/companies.db "
    SELECT c.name, c.ticker, c.notes
    FROM companies c
    JOIN company_watchlists cw ON c.id = cw.company_id
    JOIN watchlists w ON cw.watchlist_id = w.id
    WHERE w.name = 'photonics' OR c.sector = 'photonics'
    ORDER BY c.name;"
        │
        ▼
Returns exact matches only. Misses companies tagged differently.
```

### After (Hebbs)

```
User: "what do I know about photonics companies?"
        │
        ▼
Agent runs:
  hebbs-cli recall "photonics silicon photonics optics companies" \
    --strategy similarity
        │
        ▼
Returns semantically similar results:
  - COHR (exact match: photonics sector)
  - LITE (related: fiber optics)
  - IIVI (related: photonic components)
  - Research note about silicon photonics market size
  - Trade note mentioning optical interconnect thesis
```

### CLAUDE.md size

| Section | Before | After |
|---------|--------|-------|
| Company Tracker (schema + SQL examples + intent table) | ~220 lines | 0 lines |
| Knowledge Base (entity conventions + examples) | 0 lines | ~30 lines |
| Rest of CLAUDE.md | ~210 lines | ~210 lines |
| **Total** | **~430 lines** | **~240 lines** |

---

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Hebbs is alpha software | Medium | High | Keep `companies.db` as backup. Migration is one-way but data is preserved. |
| hebbs-server crashes | Low | Medium | systemd/launchd auto-restart. Agent falls back to file-based notes. |
| Semantic recall returns irrelevant results | Medium | Low | Use `entity_id` scoping to narrow results. Tunable scoring weights. |
| Container can't reach hebbs-server | Low | Medium | Same host-gateway pattern as credential proxy (proven). Health check on startup. |
| Breaking API changes in Hebbs | Low | Medium | Pin CLI version in Dockerfile. SDKs are Apache 2.0. |
| Large memory count degrades performance | Very Low | Low | Benchmarked at 10M memories with <10ms p99. |

---

## 10. Future Extensions

1. **TypeScript SDK integration**: Replace CLI calls with `@hebbs/sdk` in the agent-runner MCP server for typed, structured access (similar to `ipc-mcp-stdio.ts`).

2. **Cross-group knowledge sharing**: Non-main groups recall from the shared knowledge base (read-only) for context in their conversations.

3. **Scheduled reflection**: Add a daily cron task that runs `hebbs-cli reflect` to auto-consolidate recent memories into insights.

4. **Vault for documentation**: Use `hv` (Hebbs Vault) to index markdown files in `groups/` for cross-session searchable memory.

5. **Trade journaling**: Automatic P&L tracking by linking `trade:` entities with FMP price data on a schedule.

---

## 11. Open Questions

1. **Auth or no auth?** Should we run hebbs-server with `HEBBS_AUTH_ENABLED=true` and pass the API key through the credential proxy, or is no-auth acceptable since it only listens on localhost?

2. **Data backup strategy?** `~/.hebbs/data/` is a RocksDB directory. Do we add it to the existing backup workflow, or rely on Hebbs' export functionality (if any)?

3. **Skill installation method?** Clone `hebbs-ai/hebbs-skill` into `container/skills/`, or maintain our own simplified skill with just the entity conventions?

4. **MCP server vs CLI?** Start with `hebbs-cli` in bash (simple, works now) or build an MCP server wrapping `@hebbs/sdk` for structured tool calls (more work, better UX)?

5. **Non-main group access?** Should non-main groups be able to query the knowledge base at all, or keep it main-only?

---

## 12. Decision Checklist

Before implementation, confirm:

- [ ] Hebbs binary works on the deployment platform (Linux/macOS)
- [ ] hebbs-server is stable enough for persistent data (alpha status)
- [ ] Container-to-host connectivity works on port 6380
- [ ] Team agrees on entity_id naming conventions
- [ ] Team agrees on context metadata schema
- [ ] Backup strategy for `~/.hebbs/data/` is defined
- [ ] Migration script tested against current `companies.db`
