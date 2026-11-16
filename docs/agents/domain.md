# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: multi-context.** This repo uses a multi-context layout: each subproject keeps its own `GLOSSARY.md` (and its own `docs/adr/`), and a single `GLOSSARY-MAP.md` at the repo root indexes them. This layout was confirmed with the user during setup.

The glossary/map files are created lazily: `GLOSSARY-MAP.md` and the per-subproject `GLOSSARY.md` files do not exist yet — they will be created the first time real terms are written down, at which point the root `GLOSSARY-MAP.md` points to them.

## Before exploring, read these

- The **`GLOSSARY-MAP.md`** at the repo root — it points at one `GLOSSARY.md` per subproject. Read each one relevant to the topic.
- **`docs/adr/`** in the subproject you're touching; also check the repo-root `docs/adr/` for system-wide decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/domain-modeling`) creates the root `GLOSSARY-MAP.md` and per-subproject `GLOSSARY.md` files lazily when terms or decisions actually get resolved.

## File structure

Multi-context layout (subprojects each carry their own glossary):

```
/
├── GLOSSARY-MAP.md          ← created lazily, indexes the subprojects below
├── docs/adr/                ← system-wide decisions (created lazily)
├── antigravity/
│   ├── GLOSSARY.md          ← created lazily
│   └── docs/adr/            ← subproject-specific decisions
├── broker/
│   ├── GLOSSARY.md
│   └── docs/adr/
└── plugin/
    ├── GLOSSARY.md
    └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
