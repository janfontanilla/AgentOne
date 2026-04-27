# Task Backlog

## Phase 4: Standalone TypeScript Agent (CURRENT — Functional)
- [x] Drop Base44 platform dependency
- [x] Refactor to standalone TypeScript (`agentone/gold_forecast_agent.ts`)
- [x] Implement all 7 actions in single file
- [x] Yahoo Finance HTTP API for NEM, GOLD, SLV, AUDUSD=X
- [x] Kitco.com gold price with Yahoo GC=F fallback
- [x] Multi-source URL collection (Google, DuckDuckGo, known sites, RSS)
- [x] Groq Llama 3.3 70B synthesis via API
- [x] Local CSV + JSON persistence in `agentone/data/`
- [x] Independent error handling per action
- [x] First-run handling with date check
- [x] Toronto timezone via Intl.DateTimeFormat
- [x] Pipeline tested end-to-end
- [x] Full audit completed
- [x] Update all stale documentation for TypeScript
- [x] Update .claude/ configs for TypeScript
- [ ] Fix code bugs: silent catch blocks, torontoNow() timestamp, package.json type field
- [ ] Add `agentone/.env.example`

## Phase 5: Scheduling & Polish
- [ ] Add scheduler (node-cron or system cron) for daily 10 AM Toronto
- [ ] Test DST handling (Toronto switches in March/November)
- [ ] Add unit tests
- [ ] Production deployment

## Future: AI Michel Expansion
- [ ] Add oil and silver price tracking
- [ ] Add Magnificent Seven stock tracking
- [ ] Implement 3-agent neurotropic architecture
- [ ] Integrate LangChain/CrewAI for agent communication
- [ ] Add ChromaDB for agent memory
- [ ] Add human prompt modulation interface
