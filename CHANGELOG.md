# Changelog

Simple, human-readable release notes for this extension.

## 0.1.31
- Default the configuration panel to enabled flashing and stop at `core0_main` when no existing setting is available; preserve launch-file and remembered choices, including disabled flashing and an empty function.
- Require flashing and Agent `-f` for every new Debug MCP session; remove the `flash` input and reject obsolete flags before launch.
- Enforce required flashing/download settings at the launch factory boundary; preserve UI flashing options and reuse of existing sessions.
- Update startup guidance: preserving firmware requires an existing session or a user-selected manual workflow, not an MCP no-flash launch.

## 0.1.30
- Default Debug MCP startup to flashing, even after separate AURIX MCP programming; use explicit `flash: false` to preserve existing firmware.
- Keep stop-at-function optional and UI flashing defaults unchanged; retain startup evidence, cancellation guards and the existing full-erase retry.

## 0.1.29
- Add explicit `debug_start` options for flashing through the existing UI workflow and requesting an Agent stop-at-function; default startup remains no-flash.
- Return actual flash progress and phase-specific startup failures, including Agent port-readiness timeouts, instead of losing factory errors behind `START_REJECTED`.
- Preserve the existing full-erase retry with explicit authorization guidance; prevent new flasher attempts after MCP cancellation and keep pending launches reserved.

## 0.1.28
- Add read-only `debug_observe` for bounded global/peripheral batches with fresh identity resolution and shared execution-state checks; preserve existing tools.
- Prefer batch observations in the Debug skill and avoid redundant discovery while retaining stop verification and explicit error reporting.

## 0.1.27
- Refresh the bundled AURIX Flasher binaries and device resources, including the TC4Px A-step files.
- Include the latest README guidance and agent-startup known issue.

## 0.1.26
- Add a focused diagnosis-completeness check to the Debug skill: test whether a proposed fix is sufficient and distinguish source reasoning from runtime evidence.
- Clarify task-scoped temporary-breakpoint authorization and cleanup while preserving existing or user-modified breakpoints; client approvals remain unchanged.
- Simplify the README into a user guide with both MCP session paths and a concise capability list.

## 0.1.25
- Generalize the Debug skill description to AURIX firmware debugging and runtime inspection; keep LED/PWM as examples only.
- Clarify task-sized workflows and one bounded conversational authorization for in-scope execution, without bypassing client tool approvals or individual peripheral-write confirmation.
- Document user-managed tool approval settings; no debugger runtime or approval enforcement changes.

## 0.1.24
- Bundle the standalone `aurix-debug-workflow` skill with the Debugger; AURIX AI Agent is optional.
- Add an explicit Install / Update Debug Skill command for one selected workspace folder, with overwrite confirmation, dirty-editor and concurrent-change protection.
- Keep activation, existing debug startup and hardware behavior unchanged; installing the skill only writes its project-local SKILL.md.

## 0.1.23
- Revert the 0.1.22 panel/native-launch redesign; restore the original Apply/Debug, last-used settings and direct Agent startup behavior.
- Only add launch.json creation/update before the existing Debug action. Persist the original panel's Agent startup parameters, update the first AURIX entry without duplicating it, and retain other configurations.
- Report launch-file write failures without starting debugging.

## 0.1.22 (UI/native-launch redesign reverted in 0.1.23)
- Make the configuration panel a named, folder-local launch.json editor with explicit Save and Save and Debug actions; use the same saved configurations from Run and Debug / F5.
- Add workspace/configuration selection, portable project paths, JSONC-preserving edits and conflict/dirty-file checks without overwriting other debugger entries or advanced settings.
- Align native templates and panel defaults, keep new configurations no-flash, and open the panel before starting an incomplete native launch. Keep MCP launch isolation and external-agent behavior.
- Add offline model/UI/provider tests and real VS Code launch-file persistence/onboarding checks without hardware access.

## 0.1.21
- Remove `-ver on` from integrated AURIX Flasher invocations.
- Add `-freq 20000000` only for the selected DAS device's TC3/TC4 family, including automatic single-device selection; omit it for TC2 and unknown families.

## 0.1.20
- Restore full TC4DXA SVD loading with a shared 256 MiB file/decoded-XML limit and dimensions of up to 4,096 elements; keep total definition, expansion and nesting bounds.
- Add TC4D automatic family matching consistently across preparation and UI/MCP launch validation.
- Preserve the complete original SVD for Viewer and Agent; validate all 85,083 TC4D registers, 407,029 Viewer fields and both 2,048-element lookup tables offline.
- Add optional `debug_prepare.timeoutMs` (100..120000 ms), keeping the 30-second default; large TC4D preparations can explicitly request 120 seconds without changing startup parameters or permissions.
- Add file/gzip/dimension-boundary tests, TC4D selection/preparation checks and actual-Viewer compatibility coverage.

## 0.1.19
- Pipeline full-SVD native metadata lookup with a shared limit of eight in-flight metadata commands; keep register value reads ordered.
- Retain completed metadata batches within one inspection state after a deadline, instead of restarting a wide group from its first register.
- Drain metadata batches on failure and cancel queued work on execution changes; preserve cache invalidation, complete ambiguity checks and write approval/revalidation.
- Keep the 15-second Viewer deadline and report the state, metadata or value-access phase on timeout.

## 0.1.18
- Report non-displayable expression results (such as function/type symbols) as failed DAP evaluations without a session-error notification.
- Preserve genuine evaluation, transport and value-decoding errors; do not fabricate values or add function-call support.
- Add adapter-level hover, Watch and REPL regression tests, including recovery after an unsupported symbol.

## 0.1.17
- Cancel pending and late memory/peripheral reads during normal debug termination instead of showing a misleading read failure notification.
- Stop teardown-time fallback reads and discard late results without returning zero-filled data; preserve genuine active-session errors.
- Add offline disconnect-race coverage and a real Peripheral Viewer integration check.

## 0.1.16
- Replace preparation's misleading hardware-operation timeout with `PREPARE_TIMEOUT` and explicit read-only evidence.
- Preserve stage/path/timing and partial discovery diagnostics on timeout, cancellation and enumeration failure; never return launch arguments from failed preparation.
- Move SVD validation to a cancellable worker so full catalogs no longer block the extension host. Keep the 30-second overall deadline.
- Log preparation stage transitions and add stalled-stage, worker responsiveness/cancellation and both-protocol HTTP regression tests.

## 0.1.15
- Add read-only `debug_prepare` for bounded workspace ELF discovery, actual DAS device enumeration and matched SVD validation.
- Prefer existing sessions; report ambiguous/incomplete discovery rather than choosing a first/newest candidate.
- Return advisory startup arguments and an ELF hash, with default CPU0 explicitly marked as unprobed. Never start, flash or access target values during preparation.
- Reuse one bounded DAS enumerator/parser across MCP preparation, UI detection and existing launch/flashing checks; reject failed or partial inventories.
- Add offline filesystem, cancellation, host-registration and both-protocol MCP integration coverage.

## 0.1.14
- Add read-only MCP lookup and reads for global and file-static variables using the existing TCF session.
- Report same-name candidates with native compilation-unit metadata instead of automatically selecting one.
- Expand structs and arrays through existing variable handles using captured bytes, without pointer dereferencing.
- Revalidate symbol identity, type, ELF hash and stopped state before bounded reads; report unavailable data explicitly.
- Display non-character 8-bit integers numerically in MCP variable inspection.
- Add offline native-service and HTTP integration tests. Live Agent compatibility and target values still require on-target acceptance.

## 0.1.0 - 2026-01-20
- First public release.
- Core debugging: breakpoints, step/continue, call stack, variables.
- Memory read/write and disassembly view.
- Launch configs, multi-core support, optional auto-start agent.
