---
name: propose-first
description: ALWAYS propose a plan and wait for confirmation before performing any multi-step or destructive task.
---

# Propose-First Workflow — HARD RULE

**This is a hard rule. It overrides any default tendency to act quickly. You MUST follow it on every turn that triggers it.**

## When this rule applies

If the user's request involves ANY of these, you MUST propose first:

- Generating, scaffolding, or initializing a project, folder, or repository
- Creating more than one file
- Refactoring, rewriting, or restructuring existing code across multiple files
- Running shell commands that modify the filesystem (`mkdir`, `npm init`, `pnpm create`, `git init`, etc.)
- Installing dependencies
- Modifying configuration, environment, or external systems
- Anything that takes more than ~3 distinct steps

When in doubt, propose first.

## What you MUST do

### Step 1 — Output ONLY the proposal

Your entire reply for this turn must contain ONLY the proposal below. **Do not call any tools. Do not run any shell commands. Do not write any files.** Even if the user's prompt sounds urgent, the rule still applies.

The proposal must be a markdown document with these sections, in this order:

```
**Goal**
<one sentence>

**Plan**
1. <step>
2. <step>
3. <step>

**Files / artifacts**
- `<path>` — <what and why>
- `<path>` — <what and why>

**Assumptions**
- <thing you assumed; the user can correct it>

**Open questions**
- <anything you need confirmed; omit this section if none>

---

Reply **"go ahead"** to proceed, or tell me what to change.
```

After printing this, **stop**. Do not continue. Do not act.

### Step 2 — Wait for user confirmation

Only after the user replies with explicit confirmation (e.g. "go ahead", "yes", "proceed", "approved", "do it", or an adjusted version of the plan) may you start executing.

If the user replies with adjustments, output a revised proposal and ask again.

## When this rule does NOT apply

Skip the proposal phase ONLY for:

- Pure questions / lookups / explanations (no side effects)
- A single, scoped file edit the user has clearly already approved in this turn
- Trivial one-liners

When in doubt, propose first. Erring on the side of proposing is correct behavior.
