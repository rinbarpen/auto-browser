---
name: workflow-capture
description: Capture an operational workflow and package it as a reusable project skill. Use when the user says "把这个流程整理成skill", "save this workflow", "make this a skill", or when a just-completed multi-step operation should be reusable.
origin: auto-browser
---

# Workflow Capture

Turn a just-completed operational flow into a durable, reusable project skill stored in `.codex/skills/<name>/SKILL.md`.

This is a meta-skill: it produces another skill. Use it when the user has just worked through a multi-step process (debugging, deployment, data pipeline, code generation pattern, review workflow, etc.) and wants it captured for future Claude instances.

## When to Use

- User says "把这个流程整理成skill", "保存为skill", "记录下来下次复用"
- User says "make this workflow a skill", "capture this as a skill"
- A non-trivial multi-step operation just completed and the user wants it durable
- The process spans multiple tools, files, or systems and would be hard to reconstruct from memory

Do NOT use for:
- Single command invocations
- Trivial one-shot edits
- Workflows already captured by existing skills

## Workflow

### Step 1: Reconstruct What Happened

From the conversation context, extract:

- **Goal**: What problem was being solved?
- **Trigger**: What did the user ask for initially?
- **Steps**: The sequence of actions taken (reads, edits, commands, agent invocations)
- **Key decisions**: Branch points where the approach could have gone differently
- **Result**: What was the final state?

Present this reconstruction to the user as a concise summary (3-5 bullets) and ask for confirmation. The user may correct scope or emphasis.

### Step 2: Determine Skill Name and Scope

Propose a skill name following these rules:

- **kebab-case**, 2-4 words
- Describes the *operation*, not the *technology* (e.g., `credential-auto-fill` not `credential-store-ts`)
- Fits the project's existing naming style (see existing skills in `.codex/skills/` for conventions)
- Not already taken by an existing skill

Ask the user to confirm or suggest an alternative name.

### Step 3: Generalize the Workflow

Strip session-specific details and extract the reusable pattern:

| Remove | Keep |
|--------|------|
| Specific URLs, hostnames, IPs | The *kind* of URL or endpoint pattern |
| Timestamps, durations, dates | Timeout strategies, polling intervals as parameters |
| Concrete file paths from one session | Project-relative paths or path patterns |
| Actual model names, API keys | The *role* of the model or config key |
| Literal user input values | The *shape* and *validation* of inputs |
| Specific git branches, commit SHAs | Branch naming conventions, commit message patterns |
| Error messages from one run | Error *categories* and resolution strategies |

The result should be a parameterized template — concrete enough to be actionable, abstract enough to apply to future instances of the same problem class.

### Step 4: Write the SKILL.md

Create `.codex/skills/<name>/SKILL.md` with this structure:

```markdown
---
name: <skill-name>
description: <one-line description of what the skill does and when to use it>
origin: auto-browser
---

# <Human-Readable Title>

<1-2 sentence overview of what this skill enables>

## When to Use

- <specific trigger 1>
- <specific trigger 2>
- <user phrases that should activate this>

## Prerequisites / Dependencies

<List any other skills this one depends on, tools needed, or configuration required>

## Workflow

### 1. <Phase Name>

<Concrete steps, commands to run, files to check>

### 2. <Phase Name>

<Concrete steps, commands to run, files to check>

...

## Guardrails

- <what NOT to do>
- <boundary conditions>
- <when to stop and ask the user>

## Output Format

<If the skill produces structured output, show the expected format here>

## Verification

- <how to confirm the workflow completed correctly>
- <specific check commands or assertions>

## Reference Files

<List key source files this workflow typically touches, with brief notes on each>
```

### Step 5: Validate and Confirm

1. Check the skill name doesn't collide with an existing skill
2. Verify the frontmatter is valid YAML (no tabs, correct indentation)
3. Show the user the skill path and a brief summary of what was captured
4. If the workflow depends on other skills, reference them with backticks in the body

## Guardrails

- Do NOT include secrets, API keys, tokens, or credentials
- Do NOT include session-specific data (timestamps, concrete IDs, one-off URLs)
- Keep the skill focused on ONE workflow — split if it covers multiple unrelated operations
- The SKILL.md should be scannable in under 60 seconds
- Reference existing skills rather than duplicating their content
- Use the project's existing skill naming and formatting conventions

## Skill Placement

Skills go in `.codex/skills/<skill-name>/SKILL.md`. If the skill needs supporting files (reference docs, templates, scripts), place them alongside SKILL.md in the same directory.

For agent-browser-specific skills, place them in `agent-browser/skills/<skill-name>/SKILL.md`.

## Example

Given this workflow:
> User: "when I have a build error, I always run tsc --noEmit first, then check the specific file, then run the fix, then rebuild"

The skill would be named `build-error-resolution`, generalize the steps into a reusable pattern, and reference the `build-error-resolver` agent where appropriate. It would NOT hardcode the specific file that was broken in this session.
