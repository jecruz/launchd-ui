# FUBAR Roadmap: launchd-ui

## Milestone 1: Lock Down Approved Action Safety

### Task 1.1: Validate enable and disable through the approved action path — DONE

Success criterion: approved agent actions for `Enable` and `Disable` require a user-agent plist path before mutation, matching start, stop, restart, and kickstart.

### Task 1.2: Replace loose command matching with structured command classification tests — DONE

Success criterion: Rust tests cover supported proposal forms, ambiguous text, and unsupported shell text.

### Task 1.3: Return exact execution metadata from approved actions — DONE

Success criterion: frontend receives action kind, display command, and verified post-action status without relying on placeholder text.

## Milestone 2: Test The Agent Timeline

### Task 2.1: Add frontend tests for structured model response parsing — DONE

Success criterion: valid JSON, fenced JSON, invalid JSON, missing optional fields, and command proposal cases are covered.

### Task 2.2: Add frontend tests for timeline state transitions — DONE

Success criterion: summary, proposal, approval, apply, and verification states are tested with fake Tauri handlers.

### Task 2.3: Add regression coverage for user-agent-only apply UI — DONE

Success criterion: apply control appears for user agents only and stays hidden for system agents and daemons.

## Milestone 3: Improve Runtime Configuration Ergonomics

### Task 3.1: Add runtime provider readiness details to the control surface — DONE

Success criterion: missing executable, missing model, and valid provider states are clear without opening the audit trail.

### Task 3.2: Prevent running prompts when selected provider is incomplete — DONE

Success criterion: run controls are disabled with a specific reason when the configured provider is not ready.

### Task 3.3: Add a lightweight runtime smoke action — DONE

Success criterion: user can send a minimal local test prompt and see success or failure before using job context.

## Milestone 4: Update Project Documentation

### Task 4.1: Update README for tray-first agent-driven Launch Control — DONE

Success criterion: README accurately describes menu bar behavior, local runtime adapters, approval-gated actions, and safety constraints.

### Task 4.2: Add operator safety notes — DONE

Success criterion: docs clearly state what can mutate, what is read-only, and why arbitrary model commands are not executed.

### Task 4.3: Document verification commands — DONE

Success criterion: all commands required by the FUBAR gate are listed with the correct environment variables.

## Milestone 5: Final Review And Checkpoint

### Task 5.1: Run domain review — DONE

Success criterion: UI, async, API, and file/I/O checklist items are reviewed against changed files.

### Task 5.2: Run diff-only code review — DONE

Success criterion: zero BLOCKER findings before commit.

### Task 5.3: Run full verifier gate — DONE

Success criterion: typecheck, build, tests, lint, Rust tests, format check, and clippy pass.

## Milestone 6: Continue Assistant And Policy Scope

### Task 6.1: Add in-session assistant conversation history — DONE

Success criterion: recent assistant turns show action, summary, prompt/response, and command proposal state.

### Task 6.2: Add proactive job insights — DONE

Success criterion: the panel surfaces local status/plist signals before prompting the model.

### Task 6.3: Add conservative semi-autonomous execution policy — DONE

Success criterion: opt-in auto-apply only runs safe user-agent start/kickstart-style proposals while preserving manual review for sensitive/system actions.

## Approval Gate

FUBAR requires human approval before implementation continues past this roadmap.

Recommended first build task: Task 1.1, because approved-action safety is the highest-risk part of the agent-driven workflow.
