# Decision Log

Chronological record of project decisions. Details and verification evidence live in `PLAYOPS_PLAN.md`.

| Date       | Decision                                                        | Reason                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-25 | Language: **TypeScript**; Runtime: **Node.js LTS**              | PlayOps is API-, schema-, JSON-, CLI-, and LLM-tooling-heavy. TypeScript provides strong typing while keeping integration with Google APIs and LLM providers straightforward. (PLAYOPS_PLAN.md §5 rule 8, Phase 0.1) |
| 2026-09-25 | License: **MIT**                                                | Permissive, standard for open developer tooling; no copyleft constraints on operators embedding PlayOps in their workflows. (Phase 0.2)                                                                              |
| 2026-09-25 | Agent Runtime Core moved to Phase 2, before all domain agents   | Domain agents must use the real tool registry, permission engine, approval gates, verification model, and audit infrastructure from the beginning rather than implementing temporary versions and refactoring later. |
| 2026-09-25 | PlayOps accepts an already-built `.aab`; never builds artifacts | Building/compiling APK/AAB is out of scope; release pipeline uses the Android Publisher Edits workflow only.                                                                                                         |
