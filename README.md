# AURIX&trade; TCF Debugger for VS Code

> **Disclaimer:** This is a personal project, built and maintained by one developer in my own time. It is not an official Infineon product and has nothing to do with Infineon Technologies AG. It comes with no warranty and no promise of support or future updates. Use it at your own risk.

Debug Infineon AURIX&trade; firmware in VS Code, using the normal debugging UI or
an AI assistant connected through MCP. Both operate on the **same debug session**.

The extension uses the TCF backend from [AURIX&trade; Configuration Studio](https://www.infineon.com/design-resources/platforms/aurix-software-tools/aurix-configuration-studio).
It supports debugging AURIX TC2x, TC3x and TC4x devices, with UI configuration for
TriCore, PPU and CDSP cores. See [MCP capabilities](#what-you-can-do-with-mcp) for
the current MCP coverage.

## Features

- Multicore debugging with source and instruction breakpoints
- Continue, pause, step into/over/out, restart and terminate
- Call stacks, variables, Watch and Live Watch
- Disassembly, instruction stepping, Peripheral Viewer and Memory Inspector
- A configuration panel with device detection and saved Run and Debug / F5 configurations
- Optional pre-debug flashing in the UI, including PPU/CDSP HEX files
- AI-assisted debugging through the built-in Debug MCP server

## Requirements

- Visual Studio Code 1.102.0 or higher
- DAS 8.3.0.1 and a connected target for hardware debugging
- Peripheral Viewer and Memory Inspector extensions (installed automatically as dependencies)
- For MCP: a trusted, local Windows workspace and an MCP-capable AI client
- For the optional skill: a client with Agent Skills support; use a recent VS Code/Copilot version

## Installation

1. Download the `.vsix` from [Releases](https://github.com/ZeZhan/vscode-aurix-tcf-debugger/releases), or build it as described below.
2. Open the Extensions view (`Ctrl+Shift+X`).
3. Select **... > Install from VSIX...** and choose the file.
4. Reload VS Code when prompted.

## Usage

### Debug configuration (UI)

1. Open your firmware project in VS Code.
2. Run **AURIX&trade; TCF: Open Debug Configuration** from the Command Palette.
3. Select your ELF and use **Detect** to select the connected device. Configure any additional cores as needed.
4. Review **Enable flashing** and **Stop at function**, then click **Debug**.

Without existing settings, the panel enables flashing and sets **Stop at function**
to `core0_main`. Existing launch-file values take precedence over remembered panel
values, which take precedence over these defaults. You can uncheck flashing or
change/clear the function before starting. SVD selection remains **Auto**.

Clicking **Debug** saves or updates the first AURIX entry in
`.vscode/launch.json` in the first workspace folder. You can then select it in
**Run and Debug** and launch it with **F5**. Existing configurations and extra
fields are retained; save any unsaved launch-file edits before starting.

**Apply** remembers panel values but does not save the launch file. F5 uses
launch-file settings such as tasks; the panel's Debug action uses its own settings.

![Debug Configuration](media/debug-configuration.png)

### Start debugging

Use the configuration panel's **Debug** button, or select a saved configuration
in **Run and Debug** and press **F5**.

![how-to-start](media/how-to-start.gif)

### Or create launch.json manually

**New:** The first time you click **Debug** in **Debug Configuration**, the
extension automatically creates `.vscode/launch.json` or updates an existing
AURIX entry. You can use **F5** afterward without writing the configuration yourself.

If you prefer to configure it manually, create `.vscode/launch.json` and replace the ELF path, device name and entry
function with the values for your project. Use the exact DAS name shown by
**Detect** for `targetDevice`, then press **F5** to start.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "aurix-tcf",
      "request": "launch",
      "name": "AURIX TCF Debug",
      "host": "127.0.0.1",
      "port": 1534,
      "autoStartAgent": true,
      "program": "${workspaceFolder}\\build\\TC375.elf",
      "targetDevice": "<exact DAS device name>",
      "entryFunction": "core0_main",
      "workspace": "${workspaceFolder}",
      "enableFlashing": true
    }
  ]
}
```

### Flashing support

**Enable flashing** programs the selected ELF before debugging and is checked
when the panel has no existing setting. Uncheck it to preserve programmed firmware;
manual no-flash startup may encounter the known Agent timeout described below.
For PPU/CDSP images, **Flash Hex** also programs the
matching `.hex` files beside their ELFs; generate those files beforehand.

**Warning:** If the first flash attempt fails, the extension retries once with
a full erase, which may erase existing target flash contents. Flashing output
is shown in **AURIX Flasher**.

### AI-assisted debugging (MCP)

You can ask the AI to use an existing debug session or start one for you.
**You do not need to start debugging manually first.**

```text
Check existing sessions
  +-- Session found: reuse it and debug
  +-- No session: check ELF, device and SVD -> ask for approval -> start and debug
```

For a program that appears stuck:

> My program gets stuck after startup. Use the current debug session to find
> where it is waiting and which variable or condition is preventing progress.
> Ask before resuming or stepping.

To investigate a problem without starting a session yourself:

> The LED on my board does not blink. Help me debug this project: check whether
> initialization and the main loop run, and whether the output configuration
> matches the code. A new Debug MCP session will reprogram the ELF; ask for
> approval before starting or changing execution, and do not write registers.

- **Build the ELF first.** MCP does not build or run launch-file tasks.
- **New sessions always flash (`-f`), even after prior programming.** `debug_start`
  has no `flash` option. Authorize the ELF/device and the
  [full-erase retry](#flashing-support).
- **Preserve a fault scene? Reuse an existing session.** Reuse does not flash;
  do not call `debug_start`.
- Startup may reset/run the target. Stop all reported cores before inspecting
  variables or registers.

MCP is enabled automatically in trusted local Windows workspaces.
Check **MCP: List Servers** if missing; disable with `aurix-tcf.mcp.enabled: false`.

#### Install the optional Debug skill

Run **AURIX&trade; TCF: Install / Update Debug Skill** from the Command Palette.
This adds `.github/skills/aurix-debug-workflow/SKILL.md` to the chosen project,
giving skill-capable clients a debugging workflow. AURIX AI Agent is not required.
It does not start a session. Run the same command to update the skill; replacing
an existing file requires confirmation.

#### Approvals

- An explicit "build, flash, then verify with the debugger" request covers the
  required startup reprogramming for the same task, device and task-built ELF.
  The Debug skill announces the additional programming and existing full-erase
  retry rather than asking for duplicate conversational approval. Explicit
  no-reflash, no-full-erase or preserve-scene constraints take precedence;
  changed scope and failed/uncertain startup retries are not covered.
- Your AI client may ask you to trust the MCP server or approve tool calls.
  Use **Chat: Manage Tool Approval**, where available, to manage individual tools
  rather than approving every call separately. Tell the AI whether it may pause,
  continue, step or change breakpoints for your task.
- Once you allow temporary breakpoints for a task, the skill does not ask again
  for each addition or cleanup. Your existing breakpoints are kept unless you
  authorize a change. Client tool approvals are separate and may still appear.
- Peripheral-register writes always require a separate **Write once**
  confirmation in the Debugger.

#### What you can do with MCP

- List, start and terminate debug sessions, or reuse a session started from the UI.
- Flash the selected ELF as a required part of an authorized new MCP session.
- Pause, resume, and step into, over or out of a function using the current stepping mode.
- List, add and remove source breakpoints, shared with the VS Code UI.
- Inspect core states, call stacks, local variables, globals and file-static variables.
- Read bounded memory ranges, core registers and peripheral registers.
- Read up to 8 globals and 32 named peripheral registers together with
  `debug_observe`, reducing repeated tool calls without reusing stale handles.
- Write a peripheral register with your explicit approval for each write.

Batch observations require all cores stopped; they never run the target or write
data. Any failure rejects the batch, and readings are not atomic with peripherals.

MCP startup currently supports **TriCore**; full PPU/CDSP support is not yet
available. It does not build, evaluate arbitrary expressions or write general
memory or core registers. Use an ELF matching the programmed firmware; MCP
cannot automatically verify that match.

Startup errors distinguish flashing failures from Agent startup failures.
An Agent timeout at `127.0.0.1:1534` means it did not become ready within its
15-second limit; increasing preparation time does not change that limit.
Flasher completion alone does not prove a successful debug session or full-image
verification. Do not automatically repeat a failed flash/start.

### Multicore stops and source focus

Use **CALL STACK** to select a core and frame. Source and disassembly views
follow that selection; switching editor tabs does not switch debug cores.
Check the reported state of each core rather than assuming a breakpoint has
stopped every core.

### Watch global variables

Add variables and expressions in the Run and Debug view's **WATCH** section.
Unavailable values are reported rather than replaced with guessed values.

![add-to-watch](media/add-to-watch.gif)

### Live Watch View

Use the Live Watch view to refresh selected global variables while the target
runs. Its Settings button controls the refresh interval (minimum 200 ms).
The active interval is shown in the view header.

![live-watch](media/live-watch.gif)

### Peripheral View

The Peripheral Viewer uses the matching SVD automatically, or a file you select.
Register access depends on the device, SVD permissions and backend support.
Pause the target before reading; cached or default display values are not proof
of a successful read.

![peripheral-view](media/peripheral-view.gif)

### Memory Inspector

While paused, run **Memory Inspector: Show Memory Inspector** from the Command
Palette, then enter an address or expression.

![memory-view](media/memory-view.gif)

### Disassembly View & Instruction Stepping Mode

While paused, right-click a source editor and select **Open Disassembly View**.
The view follows the selected frame. Use **Enable Instruction Stepping** to
step through instructions, and **Disable Instruction Stepping** to return to
source-level stepping.

![enable-instruction-stepping](media/enable-instruction-stepping.gif)

Set instruction breakpoints directly in the disassembly view, as you would in
source code. A step can also stop at a user breakpoint.

![set-instruction-bp](media/set-instruction-bp.gif)

### PPU / CDSP Cores

For UI debugging, open the **PPU/CDSP/SCR Cores** tab in the configuration panel
and assign the ELF files used for debug symbols:

- **PPU**: one ELF file
- **CDSP**: up to 12 ELF files (CDSP0 through CDSP11)

To program these images through integrated flashing, use the corresponding
**Flash Hex** option as described in [Flashing support](#flashing-support).
These UI features do not imply complete PPU/CDSP support in the MCP tools.

![cores-configuration](media/cores-configuration.png)

## Build from source

Development requires Node.js 20 or newer. End users do not need a separate
Python or Node.js installation for Debug MCP.

```bash
npm ci
npm run package
```

The package command builds `vscode-aurix-tcf-debug.vsix` in the project root.

## Backend binaries

The bundled `bin/` directory contains the TCF agent, AURIX Flasher, DAS components
and SVD files. Keep the complete `bin/aurixflasher/` directory beside
`bin/aurix-debugger.exe`, even for debug-only use: it is a startup dependency.

These tools come from AURIX&trade; Configuration Studio and are not covered by
this project's MIT license. Their applicable licenses must be checked
separately; the notices under `bin/aurixflasher/license/` do not establish
licensing for the debugger, DAS components or SVD files.

## License

The code in this repository is released under the MIT License - see
[`LICENSE`](LICENSE).

The prebuilt tools under `bin/` retain their own licenses. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Known issue:** Manual startup without flashing may time out waiting for the TCF agent; setting a stop-at-function (`entryFunction`) is not a guaranteed workaround.
