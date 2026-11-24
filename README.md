# tess-codex-agents

Guidance for Codex agents that need to follow custom, organization- or project-specific workflows.

## Purpose

Use this repository to provide Codex with explicit instructions, conventions, and supporting tools for flows that are not covered by its default behavior. Agents should review the relevant skill before starting a custom flow and follow its instructions throughout the task.

## Structure

- `skills/` — reusable custom-flow guidance and any supporting scripts.
  - `browser-control/` — instructions and scripts for controlled Chrome browser automation.
- `chrome-profile/` — local browser-profile data; it is not part of the documented workflow guidance.

## Using a skill

1. Identify the custom flow required for the task.
2. Read the relevant `skills/<skill-name>/SKILL.md` file before acting.
3. Follow the prescribed steps and use the included scripts where applicable.
4. Update the skill documentation when the flow, tooling, or constraints change.

## Maintaining custom flows

Keep each skill focused, actionable, and up to date. Document prerequisites, safety constraints, expected inputs and outputs, and verification steps so an agent can carry out the workflow consistently.
