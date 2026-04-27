# Planning & Architecture Decisions

## Decision Log

| Date | Decision | Why | Alternatives Considered |
|------|----------|-----|------------------------|
| 2026-03-24 | CSV over SQLite for storage | PDF spec requires CSV, simpler for V1 | SQLite (overkill), Base44 DB (later) |
| 2026-03-24 | last_forecast.json for persistence | PDF requires storing today_forecast for next day | Extra CSV column (messier), SQLite (overkill) |
| 2026-03-24 | Base44 for initial code gen | Supervisor's platform choice | Pure manual coding (slower) |
| 2026-03-28 | Drop Base44, go standalone TS | Free plan too limited for continued dev | Stay on Base44 (blocked by limits) |
| 2026-03-28 | Yahoo Finance HTTP API | Free, no API key, covers all symbols | yfinance Python (switched to TS), Alpha Vantage (rate limited) |
| 2026-03-28 | Single-file agent | All 7 actions + helpers in one .ts file | Multi-file module structure (overkill for V1) |
| 2026-03-28 | Groq API + Llama 3.3 70B | PDF spec says Llama 3.3 70B, Groq is free tier | OpenAI (paid), local Ollama (heavy) |
| 2026-03-28 | HTML stripping for readability | Lightweight, no external deps | readability-lxml (Python only), Puppeteer (heavy) |
| 2026-03-28 | Multi-source URL collection | Google alone gets blocked by CAPTCHA | Single source (unreliable) |
| 2026-03-28 | npx tsx for execution | Runs TS directly, no build step needed | tsc + node (extra step), Deno (different runtime) |

## PDF Discrepancies Found

These discrepancies exist between the Gold Forecast PDF spec and mathematical/technical reality.
We follow the PDF literally per supervisor's instructions.

### 1. Forecast % vs Actual $ Mismatch (MAJOR)
- **PDF says**: forecast = average of C1, C2, C3 (percentage changes, e.g., 0.45%)
- **PDF says**: actual = gold spot price from kitco (e.g., $2,300 USD)
- **PDF says**: deviation = actual - forecast ($2,300 - 0.45 = $2,299.55)
- **Issue**: Subtracting a percentage from a dollar amount is dimensionally inconsistent
- **Possible intent**: forecast should be applied as `yesterday_price * (1 + forecast/100)`
- **Our approach**: Follow PDF literally. Flag for supervisor review.

### 2. Action 6 & 7 Overlap
- Action 6 already creates the row with deviation calculated
- Action 7 says "calculate deviation if not already calculated"
- **Our approach**: Action 6 appends row with deviation=null, Action 7 calculates and updates it

### 3. Stock Ticker Typo
- Page 1 says "Newmont (NEW)" — incorrect
- Page 2 says "Newmont Corp (NEM)" — correct
- **Our approach**: Use NEM

## AI Michel Context (Future Iterations)

The Gold Forecast Agent is V1 — a prototype for the larger **AI Michel** project:
- 3-agent neurotropic architecture (Sensor → Consciousness → Action)
- Tracks gold, oil, silver + Magnificent Seven stocks
- Uses LangChain, CrewAI, ChromaDB, Ollama
- Agent #3 predicts at 9 PM for next day's 9 AM market open
- Includes human-in-the-loop prompt modulation

**Not building AI Michel now.** The standalone agent is structured to evolve into it later.

## Phase Roadmap

```
Phase 1: Scaffold                ─── Complete (2026-03-24)
Phase 2: Base44 Code Generation  ─── Complete (2026-03-26–27), 3/3 runs
Phase 3: Refine with Claude Code ─── Complete (2026-03-28)
Phase 4: Standalone TS Agent     ─── Complete (2026-03-28), pipeline functional
Phase 5: Scheduling & Deploy     ─── Not started
Phase 6: (Future) AI Michel      ─── Not started
```

## Open Questions
- [ ] Clarify forecast % vs actual $ with supervisor
- [x] Determine if kitco.com requires headless browser → simple HTTP works with Yahoo fallback
- [x] Rate limits on Google search for 20 URLs → mitigated with multi-source collection
