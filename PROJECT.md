# FUBAR Project Context: Daemonic

## Overview

`Daemonic` is a macOS desktop app for inspecting and controlling launchd jobs. It is being evolved into a tray-first macOS services app with local agent assistance, structured approval workflows, and deterministic launchctl execution.

## Stack

- Frontend: React, TypeScript, Vite, Tailwind CSS, shadcn-style primitives.
- Backend: Tauri v2 with Rust commands.
- Runtime adapters: local CLI execution for llama.cpp/yama.cpp, Ollama, and custom local CLIs.
- Tests: Vitest for frontend, Rust unit tests for backend.
- Package manager: pnpm.

## Structure

- `src/`: React app, components, hooks, typed Tauri invoke wrappers, frontend tests.
- `src/components/`: user-facing controls, job table, job detail, logs, and agent panel.
- `src/components/ui/`: generated UI primitives; avoid manual edits unless unavoidable.
- `src/lib/invoke.ts`: frontend wrappers for Tauri commands.
- `src/test-utils/tauri-mock.ts`: fake Tauri IPC for frontend tests.
- `src-tauri/src/`: Rust backend modules for launchctl, plist parsing, commands, errors, and agent runtime.
- `QUESTIONS.md`, `RESEARCH.md`, `ROADMAP.md`, `PROJECT.md`: FUBAR workflow artifacts.

## Conventions

- Use `type` instead of `interface` in TypeScript.
- Keep project docs and comments in English.
- Use `pnpm` scripts for frontend verification.
- Use `RUSTUP_HOME=$HOME/.rustup` for cargo commands in this environment.
- Keep system launch agents and daemons read-only.
- Route all model-suggested mutations through deterministic Rust helpers.
- Do not execute arbitrary shell text from model output.

## Glossary

- User Agent: launchd job in `~/Library/LaunchAgents`; mutable by this app.
- System Agent: launchd job in `/Library/LaunchAgents`; read-only in this app.
- System Daemon: launchd job in `/Library/LaunchDaemons`; read-only in this app.
- Approved Action: a model-proposed command classified into a known launchd action and executed by backend helpers after approval.
- Audit Trail: UI drawer containing prompt, context, command, structured result, and raw model response.
