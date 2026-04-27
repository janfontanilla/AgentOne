# Session Handoff — Gold Forecast Daily AI Agent V1

> Created: 2026-03-28
> Purpose: Resume audit remediation in the next Claude Code session.

---

## Project Summary

Daily AI agent (standalone TypeScript) that runs a 7-action pipeline per supervisor Olga Grass's PDF spec:

1. **News Analysis** — Google search + page scraping + Groq Llama 3.3 70B synthesis (<=25 words)
2. **Mining Stocks** — NEM + GOLD 24h % change → Coefficient #1
3. **Forex Rate** — AUD/USD 24h % change → Coefficient #2
4. **Silver Price** — SLV 24h % change → Coefficient #3
5. **Display Forecast** — Article text + avg(C1,C2,C3) formatted to 2 decimals, save to last_forecast.json
6. **Build Table Row** — Actual gold price (kitco, Yahoo fallback) + yesterday forecast → CSV
7. **Update Deviation** — deviation = actual - forecast → update CSV row

**Single file agent:** `agentone/gold_forecast_agent.ts` (~518 lines, runs via `npx tsx`)

---

## What's Done

- Pipeline is **fully functional** — runs end-to-end, CSV output matches PDF format
- Successfully ran on 2026-03-28, produced CSV row: `2026-03-28,4492.00,,` (first run, no yesterday forecast)
- `last_forecast.json` has `{"date":"2026-03-28","forecast":1.8}`
- Groq API integration working with `agentone/.env` (GROQ_API_KEY set)
- Multi-source URL collection (Google, DuckDuckGo API, known gold sites, Yahoo RSS)
- Independent error handling per action, failed coefficients default to 0
- First-run handling with date check in `loadYesterdayForecast()`
- Deleted old Base44 scaffold files (function.ts, dashboard.jsx)
- Deleted Python-specific .claude configs (2 agents, 1 hook)
- Full audit completed — identified all issues below

---

## What's NOT Done (Audit Remediation Tasks)

### 1. Fix 3 Code Bugs in `gold_forecast_agent.ts`

**Bug A — Silent catch blocks (lines 155, 178, 275, 319)**
Several `catch (_) {}` blocks swallow errors silently. Add logging:
```typescript
// Change: catch (_) {}
// To:     catch (e: any) { log(`[context]: ${e.message}`); }
```
Locations:
- Line 155: `loadYesterdayForecast()` — log warning about corrupt forecast file
- Line 178: kitco fetch failure — already has comment but no log
- Line 275: Yahoo RSS fetch — log warning
- Line 319: page extraction in Action 1 — log as debug/skip

**Bug B — `torontoNow()` returns system time, not Toronto time (line 63-65)**
Currently just returns `new Date()` which uses system timezone (Windows local, may not be Toronto).
The function is only used in `log()` for timestamps. Fix: use Intl.DateTimeFormat to format the timestamp, or note it's cosmetic-only since `torontoDateStr()` (used for actual date logic) is correct.

**Bug C — `package.json` has `"type": "commonjs"` but code uses ESM (import/export)**
`tsconfig.json` sets `"module": "ESNext"`. The `tsx` runner handles this, but `"type": "module"` would be more correct. Also `"main": "index.js"` is wrong — there's no index.js.

### 2. Update All Stale Root Documentation

**ALL of these files reference the deleted Python project and need rewriting for TypeScript:**

| File | Current State | What Needs Updating |
|------|--------------|---------------------|
| `CLAUDE.md` | References Python, pip, pytest, src/main.py, APScheduler | Rewrite for TS: npx tsx, agentone/, Groq API, node-fetch |
| `README.md` | References Python, src/main.py, pytest, pip install | Rewrite with TS setup, run instructions, architecture |
| `CONVENTIONS.md` | Python conventions (dataclasses, logging, black) | Rewrite for TS conventions actually used |
| `CHANGELOG.md` | Only has v0.1.0 Python scaffold | Add v0.2.0 Base44 runs, v1.0.0 standalone TS |
| `TASKS.md` | Python module task backlog | Replace with remaining TS tasks |
| `REVIEW.md` | Reviews old Python files that don't exist | Delete or rewrite for agentone/ |
| `PLANNING.md` | Some decisions stale (yfinance, APScheduler) | Update Decision Log for TS choices |
| `PROGRESS.md` | Mostly accurate but needs audit results added | Append audit findings and cleanup status |

### 3. Update `.claude/` Configs for TypeScript

**Commands (all 5 reference Python executables that don't exist):**
- `.claude/commands/run-forecast.md` — should run `npx tsx agentone/gold_forecast_agent.ts`
- `.claude/commands/view-history.md` — should cat `agentone/data/gold_forecast_history.csv`
- `.claude/commands/test-actions.md` — no tests exist yet, placeholder
- `.claude/commands/check-coefficients.md` — should run the agent or parse last output
- `.claude/commands/import-base44.md` — DELETE (no longer needed)

**Skills (all 4 reference Python files/modules):**
- `.claude/skills/code-review/SKILL.md` — update for TS
- `.claude/skills/forecast-runner/SKILL.md` — update for TS
- `.claude/skills/data-analyzer/SKILL.md` — update for TS
- `.claude/skills/security-audit/SKILL.md` — update for TS

**Rules:**
- `.claude/rules/api-conventions.md` — references yfinance Python API, update to Yahoo Finance HTTP API
- `.claude/rules/csv-format.md` — still accurate, no changes needed
- `.claude/rules/error-handling.md` — still accurate conceptually, update code examples from Python to TS

**Settings:**
- `.claude/settings.json` — review for stale Python references

### 4. Add Missing Files

- `agentone/.env.example` — document required `GROQ_API_KEY=your_key_here`
- Scheduler — `node-cron` or system-level cron for daily 10 AM Toronto time (Phase 5 in roadmap)

### 5. Update PROGRESS.md

Add audit results, mark cleanup tasks, update phase status.

---

## File Map (Current State)

```
HappyNutrition/
├── agentone/                    # ALL operational code lives here
│   ├── gold_forecast_agent.ts   # THE agent (518 lines, standalone TS)
│   ├── .env                     # GROQ_API_KEY (DO NOT COMMIT)
│   ├── package.json             # @types/node devDep, needs type fix
│   ├── tsconfig.json            # ES2022, ESNext, bundler resolution
│   ├── node_modules/            # @types/node, undici-types
│   └── data/
│       ├── gold_forecast_history.csv  # Pipeline output
│       └── last_forecast.json         # Persists today's forecast for next run
├── .claude/                     # Claude Code config (MOSTLY STALE)
│   ├── commands/                # 5 commands — all reference Python
│   ├── skills/                  # 4 skills — all reference Python
│   ├── rules/                   # 3 rules — 2 still valid, 1 stale
│   ├── hooks/pre-commit-secrets.sh  # Still useful
│   └── settings.json
├── Gold_20Forecast_20Daily_20AI_20Agent_20V1_20(5).pdf  # THE spec
├── v1 Project AI Michel.pdf     # Future context
├── Screenshot 2026-03-24 160742.png  # Claude Code project structure ref
├── CLAUDE.md                    # STALE — references Python
├── README.md                    # STALE — references Python
├── CONVENTIONS.md               # STALE — references Python
├── CHANGELOG.md                 # STALE — missing TS entries
├── PLANNING.md                  # PARTIALLY STALE
├── PROGRESS.md                  # Mostly current
├── TASKS.md                     # STALE — Python tasks
├── REVIEW.md                    # STALE — reviews deleted files
└── .gitignore                   # Should cover node_modules, .env, data/
```

---

## How to Run

```bash
cd agentone
npx tsx gold_forecast_agent.ts
```

Requires:
- Node.js 18+ (for native fetch)
- `GROQ_API_KEY` in `agentone/.env`
- `npm install` (for @types/node)

---

## Key Context for Next Session

- **Supervisor**: Olga Grass at AI SYNT. Follow PDF spec literally, even the % vs $ dimensional mismatch.
- **Submission**: TypeScript (user already told supervisor this).
- **Everything operational must stay in `agentone/`** — root is for docs only.
- **The audit is complete** — next session should execute the remediation tasks above, in order.
- **Don't overscope** — no AI Michel features, no extra abstractions, just fix what the audit found.
- **Update PROGRESS.md** after each major task group.

---

## Prompt to Continue

> Continue the audit remediation for the Gold Forecast agent. The full audit is done and documented in SESSION_HANDOFF.md. Work through the 5 task groups in order: (1) fix the 3 code bugs, (2) update all stale root docs for TypeScript, (3) update .claude/ configs, (4) add .env.example, (5) update PROGRESS.md. Keep everything operational inside agentone/. Follow the PDF spec exactly.
