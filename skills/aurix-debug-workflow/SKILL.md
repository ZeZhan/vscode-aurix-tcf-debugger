---
name: aurix-debug-workflow
description: 'Use when debugging, inspecting, or validating AURIX TriCore firmware with the VS Code AURIX TCF Debugger and AURIX Debug MCP. Covers session reuse, execution control and breakpoints, control flow, interrupts and multicore state, local/global/static variables, memory, core/peripheral registers, fault or hang investigation, and runtime verification after code changes. AURIX AI Agent is not required.'
---

# AURIX Debug Workflow

Use the Debugger's shared VS Code session, not a second TCF connection. This
skill provides a workflow, not authorization or additional hardware capabilities.
Follow the installed tools' schemas, safety checks and user approvals.

Use the shortest relevant path for the user's request. These sections are
guidance, not a mandatory checklist for every question. A simple value lookup
does not require a full diagnostic plan, unrelated register reads or a complete
validation report. Keep the answer proportional to the task, with the essential
evidence, caveats and final session state.

## 1. Establish scope and tool availability

- Identify the expected behavior and a small set of observation points or
  assertions. Clarify missing information rather than guessing device facts.
- Discover the available AURIX Debug MCP tools. Client prefixes may differ; use
  the actual exposed tool names and schemas, not invented bindings.
- If unavailable, guide the user to install/enable **AURIX TCF Debugger**, open a
  trusted local Windows workspace and inspect **MCP: List Servers**. Respect an
  explicit `aurix-tcf.mcp.enabled: false`; do not change it without permission.
- A skill-capable Copilot/agent client is required to load this file. The
  extension's minimum VS Code version for MCP does not guarantee skill support.
- AURIX AI Agent is optional. Do not assume its build, flash or documentation
  tools exist. Do not replace missing debug tools with shell commands, a new TCF
  connection, arbitrary DAP requests or a second debugging backend.
- For read-only requests, do not start, pause, continue, step, stop, change
  breakpoints or write registers. If running cores prevent inspection, explain
  the limitation and request permission to pause.
- Obtain explicit authorization for the needed execution changes and breakpoint
  edits unless already covered by the user's request. General permission to
  diagnose a problem is not permission to reset, flash or write hardware.
- An explicit request to "build, flash, then verify with the debugger" already
  authorizes the required startup reprogramming for the same task, selected
  device and ELF built for that task. Do not ask for a second conversational
  approval merely because another tool has already flashed that ELF.
  Briefly announce that Debug MCP will program it again using the existing
  flasher flow, including its one full-erase retry on flasher failure, then
  proceed within the requested verification scope.
  An explicit no-reflash, no-full-erase or preserve-scene instruction takes
  precedence: do not start a programming session under this rule. Ask if the
  task, device, ELF provenance or programming scope is unclear or changes.
  "Inspect/debug the already-flashed program" alone is not a request to flash.
  This authorization does not permit automatic retries of failed or uncertain
  `debug_start` calls, unrelated writes or bypassing client tool approvals.
- For multi-step execution not already authorized, ask once for a bounded plan:
  session/core, allowed actions, execution budget and final state. Do not repeat
  that conversational authorization for each tool call within the agreed scope.
  Reconfirm if the scope or target changes. This does not bypass client tool
  approvals or the Debugger's mandatory confirmation for every peripheral write.

## 2. Reuse a session, or prepare an explicitly authorized start

1. Call `debug_sessions` first. Use an existing UI/F5-created session whenever
   possible. If several sessions are present, resolve the selection explicitly.
   Never terminate a user's session merely to make startup easier.
2. With no session, call `debug_prepare`. It discovers/validates workspace ELF,
   actual DAS device names and SVD without launching or reading target values.
   Resolve ambiguous candidates, incomplete scans and `needs-input` explicitly;
   never choose the first/newest ELF or translate a board label into a DAS name.
   The default CPU0 recommendation is unprobed.
3. Preparation normally has a 30-second limit. For a known large SVD such as
   TC4D, explicitly request up to `timeoutMs: 120000` when appropriate. On failure,
   report the returned stage/timings and partial findings; do not infer missing
   results, automatically retry or start from diagnostic-only partial data.
4. `launchArguments` are advisory, not authorization or proof of flashed
   firmware. Verify the workspace, built/flashed ELF, exact DAS name and core
   against the request and preparation results before `debug_start`; do not
   re-ask for information or permission already established in scope.
   Preparation itself never builds or flashes.
5. Every new `debug_start` requires flashing and Agent `-f`.
   There is no `flash` input: omit it; both true and false are rejected.
   It reuses the Debugger's existing flasher/download workflow. An AURIX AI Agent
   workflow may build and flash separately, then optionally flash again through
   Debug MCP for validation; prior flashing does not skip this startup flash.
   Apply the authorization rule in section 1 to the ELF and exact device;
   ask only for missing authorization, not a second approval for the same
   explicit flash-and-verify task. If reprogramming
   is forbidden or a fault scene must be preserved, do not call `debug_start`.
   Reuse an existing suitable session or ask the user about manual UI startup;
   UI options are unchanged, but backend startup limitations can still apply.
   Do not silently drop a rejected no-flash argument and retry with programming.
   `entryFunction` is unset by default and does not disable flashing.
   Optional `entryFunction: "core0_main"` requests a stop-at-function; it does
   not bypass the required flashing or establish a stopped location.
   It is a request, not proof of the stopped location. Never invent a function.
   Startup never builds, reads a saved launch configuration or runs launch tasks.
   It can reset/run the target; inspect actual PC/stack after its startup pause.
6. Query `debug_status` and `debug_stack` to establish the actual core, PC and
   source location. Use returned session/thread IDs; thread IDs are not core
   indices. All reported cores must be stopped before data inspection.

## 3. Establish an observation point

- For an already stopped session, inspect its current location first. Do not
  continue merely to reach a more convenient point without authorization.
- For an authorized breakpoint workflow, list `debug_breakpoints` first.
  Add a source breakpoint with `debug_add_breakpoint` only when needed; use an
  existing absolute workspace source path and a 1-based line.
- Breakpoints are shared with the VS Code UI. Do not change or remove pre-existing
  breakpoints unless the user explicitly authorizes that change. Record the IDs
  and settings of newly created breakpoints; an add can return an existing one,
  which is not yours to clean up. Before cleanup, recheck the list and preserve
  breakpoints the user has since changed. Ask if ownership is uncertain.
- Authorization to use temporary breakpoints includes adding the needed ones
  and cleaning up only those created for the task. Do not ask again for each
  in-scope add or removal. Client tool approvals still apply; a read-only request
  does not authorize breakpoint edits.
- Check `debug_breakpoint_status` with the VS Code breakpoint ID. A successful
  add or DAP `verified` response alone does not prove an exact installed source
  line or future hit. If an error reports `uiChanged`, inspect the existing
  breakpoint before considering any further edit.
- `debug_continue` waits for a continued event, NOT the next breakpoint.
  Establish a bounded observation budget (default: at most five status queries
  within 30 seconds; stop when either limit is reached). Check `debug_status`
  without busy-looping or issuing repeated continues.
- On a stop, verify all cores are stopped and use fresh stack/PC and breakpoint
  evidence to determine the actual location. An unrelated stop is not a pass.
  On budget expiry, report that the desired stop was not observed. Pause only
  if a timeout pause was authorized; otherwise ask how to proceed.
- `debug_pause` pauses all cores. `debug_step` waits for the selected core's
  stop and follows the current source/instruction stepping mode; inspect that
  mode and the resulting state instead of claiming a source-line step blindly.

## 4. Collect small, fresh evidence

After any execution change, session change or write, discard old inspection
handles and reacquire state and values. Do not treat cached values as a new
measurement. Stopped CPUs do not make DMA/peripheral observations atomic.

Prefer `debug_observe` when available for known globals/file-statics and
peripheral registers: send up to 8 exact global names with source qualifiers
and/or 32 exact SVD register names in one call. It resolves fresh references,
reads the selected values and returns final core state under one bounded
inspection. Reuse the selectors, never old handles or values, at later stops.
Use catalog tools only to discover names or resolve ambiguity; do not repeat
catalog/read pairs when the batch tool can perform the same observation.
An error rejects the whole batch: report it, not partial or inferred values.
Do not split/retry a failed batch automatically or bypass an access rejection.
If the batch tool is absent, use the existing handle-based tools below.

Collect the smallest set of samples that proves the requested assertion.
Do not repeat unchanged source, tool discovery, stack or breakpoint queries
without a reason. Still verify each stop using fresh PC/state and the established
breakpoint mapping; request a fresh stack if the PC or stop reason is unexpected.
Never skip measurements the user explicitly requested, infer intermediate
samples, or claim a full cycle from endpoints alone.

| Question | Tool sequence |
| --- | --- |
| What are the selected global and peripheral values at this stop? | `debug_observe` with exact selectors; no catalog/handle round trips required |
| Where is execution stopped? | `debug_status` -> `debug_stack` |
| What are the local values? | `debug_stack` frameHandle -> `debug_scopes` variablesHandle -> `debug_variables` |
| What is a global or file-static value? | `debug_global_variables` exact identifier -> select source/address candidate -> `debug_read_global_variable` symbolHandle |
| What are struct/array children? | `debug_variables` using the returned child handle; these expand captured bytes, not a new sample |
| What are CORE register values? | `debug_registers` -> select handles -> `debug_read_registers` |
| What is the peripheral configuration? | Filter/page `debug_peripheral_registers` -> select handles -> `debug_read_peripheral_registers` |
| What are bytes in an allowed ELF-backed region? | `debug_read_memory`, 1..4096 bytes |

- Never auto-select the first same-name file-static variable. Missing symbols,
  optimized-out values and unsupported registers remain explicit limitations.
- Do not substitute source initializers, cached/default zeros or catalog
  metadata for actual target values. Distinguish constants from runtime reads.
- Filter catalogs by the needed peripheral/register names; do not enumerate all
  tens of thousands of SVD registers. Respect pagination and read limits.
- No arbitrary expression evaluation, pointer dereference, CORE-register writes
  or general memory writes are exposed. Do not work around these restrictions.
- Respect SVD/backend access permissions and read-side-effect restrictions.
  Never use raw memory to bypass MMIO guards. Full SVD metadata does not promise
  backend access to every listed register.
- A peripheral write is a separate, explicitly requested action, not a default
  diagnosis technique. `debug_write_peripheral_register` writes one whole
  register and always requires fresh Debugger-hosted approval. Never implement
  implicit read-modify-write, automatic readback or repeat a failed/uncertain
  write. A subsequent read is a separate permitted observation.

## 5. Handle uncertainty and an optional rebuild/flash handoff

- On a launch or execution timeout, the operation may have happened. Do not
  automatically repeat it. Inspect `debug_sessions` and fresh `debug_status`;
  report uncertainty and seek a decision if recovery needs execution changes.
- On startup failure, report `startup.stage`, flash status and the specific
  error (for example `FLASH_FAILED` or `AGENT_START_TIMEOUT`). Flasher completion
  does not imply Agent readiness, full-image verification or a stopped session.
  `flashPerformed: null` means programming may be partial or still in flight;
  do not report it as "no flash". The launch reservation blocks another start
  until the pending operation settles. Increasing `debug_prepare.timeoutMs`
  does not extend the Agent's separate 15-second port-readiness timeout.
- On a read error, report the actual error and obtain fresh state before further
  inspection. Never present an unavailable value as zero or bypass a safety
  rejection. Respect any user instruction to stop after the first failure.
- Before a separately authorized flash, use `debug_stop` and require
  `agent.agentReleased: true`. `debug_stop` is termination, not a CPU pause.
  External Agents need separate release; do not kill processes, force device
  ownership or proceed while release is unconfirmed.
- Builds require separately available build tools or the user's established
  workflow. Flashing can use a separately available flash tool without debugging.
  If validation then needs a new `debug_start`, it must flash again, without
  sending a `flash` argument. Prior programming does not skip this step.
  On an obsolete-schema error, refresh the tools and check programming
  authorization before correcting the request; do not retry automatically.
  Never invent tools or bypass the MCP interface to obtain a no-flash startup.
- After a rebuild/flash, revalidate the new ELF and start a new authorized
  session. Reacquire handles and re-check breakpoints and observation points.
  A local ELF hash identifies the file, not the firmware on the board.
- A reported `firmwareMatchVerified: false` must remain false/unknown in the
  report; successful launch or a plausible value is not proof of identity.

## 6. Check diagnosis completeness and report evidence

For fault diagnosis, ask whether fixing the identified cause alone would restore
the user's expected behavior. Check the relevant path from application logic
through configuration to the observed state, including units, ranges and update
conditions where applicable. Do not stop at the first plausible explanation,
but do not expand into an unrelated audit or invent additional faults.

Choose evidence that distinguishes a fault from normal behavior: an unchanged
value between scheduled updates does not by itself prove updates have stopped.
Separate what the source implies from what was actually observed. If more
evidence is needed, stay within the agreed execution budget or report the gap.
A proposed fix is not a verified repair; state what still needs retesting.

For each requested assertion, report **supported**, **contradicted** or
**unverified**, with:

- Session/core, actual stopped PC/source location and the observation performed.
- Measured values (and raw bytes/address when relevant), separately from source
  constants, configuration-derived calculations and diagnostic hypotheses.
- Missing evidence, tool errors and firmware-identity uncertainty.
- Final session state and any breakpoints added/removed or approved writes.

Examples:

- **LED/PWM:** Check initialization/control flow, relevant globals and PORT/timer
  registers. Configuration can support a predicted frequency/duty cycle, but
  does not measure a pin waveform, voltage, load or timing quality.
- **Missing interrupt:** Check the intended ISR breakpoint, counter and relevant
  enable/pending state. Failure to observe a hit in a bounded window is not
  proof that an interrupt can never occur.
- **Stuck firmware:** Inspect fresh per-core PC/stack and selected registers.
  Present suspected wait loops or fault paths as hypotheses backed by evidence.
- **Regression:** Compare the same observation point and explicit assertions
  before/after a change; compilation success alone is not runtime verification.

Do not silently continue or terminate a session at the end. Preserve the user's
requested final state, and explicitly report if it could not be established.
