# Domain docs

Read the repository's domain documentation before exploring code.

## What to read

- Read `CONTEXT.md` at the repository root.
- If `CONTEXT-MAP.md` exists instead, use it to find the relevant context-specific `CONTEXT.md`.
- Read ADRs under `docs/adr/` that affect the area being changed.

If these files do not exist, proceed silently. The `/domain-modeling` skill creates them when the project resolves terms or architectural decisions.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

Use terms defined in `CONTEXT.md` when naming concepts in issues, proposals, hypotheses, and tests. Avoid synonyms that the glossary rejects.

If a needed concept is absent, reconsider whether the term belongs to the project. Record genuine vocabulary gaps for `/domain-modeling`.

## Flag ADR conflicts

Call out any proposal that contradicts an existing ADR and name the ADR involved.
