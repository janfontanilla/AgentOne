# Changelog

All notable changes to the HappyNutrition project.

## [1.0.0] - 2026-03-28 — Standalone TypeScript Agent

### Added
- Standalone TypeScript agent (`agentone/gold_forecast_agent.ts`) — no Base44 dependency
- All 7 actions implemented in single file (~518 lines)
- Groq API + Llama 3.3 70B for ≤25-word news synthesis (Action 1)
- Multi-source URL collection: Google, DuckDuckGo API, known gold sites, Yahoo RSS
- Yahoo Finance HTTP API for NEM, GOLD, AUDUSD=X, SLV (Actions 2-4)
- Kitco.com gold price scraping with Yahoo GC=F fallback (Action 6)
- Local CSV persistence (`agentone/data/gold_forecast_history.csv`)
- `last_forecast.json` with date check to prevent same-day read
- Independent error handling per action (failed coefficients default to 0)
- First-run handling: forecast=empty, deviation=empty
- Toronto timezone via `Intl.DateTimeFormat` for DST
- `.env` loader with agentone/.env priority and force-overwrite

### Fixed
- NEM and GOLD now fetch independently (one failing doesn't kill the other)
- All coefficients formatted to 2 decimal places (was 4)
- Path resolution on Windows with OneDrive spaces using `fileURLToPath`

### Removed
- Python codebase (`src/`, `tests/`, `scripts/`, `requirements.txt`, `pyproject.toml`)
- Base44 scaffold files (function.ts, dashboard.jsx)
- Root-level `data/`, `.env`, `.env.example`, `.mcp.json`
- Python-specific .claude configs (2 agents, 1 hook)

## [0.2.0] - 2026-03-26 to 2026-03-27 — Base44 Agent

### Added
- Base44 trigger configured: daily at 14:00, task ID `run_gold_forecast`
- Backend function (TypeScript) + Dashboard (React JSX) in `agentone/`
- 3 runs, 3 succeeded, 0 failed (1.7 credits)

### Issues
- Base44 free plan too limited for continued development
- Decision: move to standalone TypeScript

## [0.1.0] - 2026-03-24 — Project Scaffold

### Added
- Full project directory structure following Claude Code best practices
- Documentation: CLAUDE.md, PLANNING.md, CONVENTIONS.md, PROGRESS.md, TASKS.md
- .claude/ configuration: settings.json, commands, rules, skills, agents, hooks
- Python source skeleton: 7 action modules, 4 service modules, storage, scheduler
- CSV with correct headers: `date,actual_gold_price,forecast,deviation`
- .gitignore, .env.example, requirements.txt
