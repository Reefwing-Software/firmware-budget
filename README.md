# firmware-budget

A Claude Code mod for embedded projects. After every build it runs the toolchain's `size` on your firmware ELF and draws flash and RAM use as two bars above the prompt, with the change since the last build. If the last build is over budget, it refuses `git commit` until the firmware fits or you raise the budget.

```
flash ████░░░░░░░░░░░░░░░░  19.9%  815.3 KB / 4096.0 KB  +1.2 KB
ram   █████░░░░░░░░░░░░░░░  24.3%  126.3 KB / 520.0 KB   +0 B
build 3 · cmake --build build
```

The numbers are what the linker produced, not what the model says it produced. The mod runs `size -A` and splits sections by address: everything placed below `ram_start` is flash (the XIP image), plus the `.data` load image; everything at or above it is RAM, which on the Pico SDK includes the vector table, `.data`, `.bss` and the SDK's minimum heap and stack reservations. Berkeley `size` is not used because the Pico SDK linker script marks `.data` executable, so Berkeley `size` folds it into `text` and reports `data 0`.

Tested with the Chapter 10 noise suppression project from *Embedded AI* (No Starch Press): a Pico 2 running RNNoise against a PDM microphone with a spectrogram on an LCD. Baseline: flash 834,916 B (19.9%), RAM 129,368 B (24.3%).

The guard runs inside Claude Code, before the permission check, and has no override in the prompt. Nothing in `CLAUDE.md` or the conversation can talk it past an over-budget ELF. The only ways through are to shrink the firmware or to change the budget in `/config`.

## Install

Tested with Claude Code 2.1.299. Mods need v2.1.287 or later.

```
/plugin install firmware-budget --marketplace Reefwing-Software/firmware-budget
```

Answer `y` to add the marketplace, then pick a scope. Claude Code then asks for the ELF path; the budgets default to a Pico 2. To set an option from the shell, the values go in as JSON on stdin:

```bash
echo '{"elf":"build/firmware.elf"}' | claude plugin configure firmware-budget@firmware-budget --values-stdin
```

To run it from a folder while developing:

```bash
claude --plugin-dir ./firmware-budget
```

## Configure

| Option | Default | What it is |
| --- | --- | --- |
| `elf` | none, asked at install | The linked ELF, relative to the project root, such as `build/firmware.elf` |
| `flash_budget` | `4194304` | Bytes of flash the firmware may use (Pico 2: 4 MB) |
| `ram_budget` | `532480` | Bytes of RAM the linker may place (RP2350: 520 KB) |
| `ram_start` | `536870912` | `0x20000000`; sections at or above it count as RAM |
| `size_tool` | `arm-none-eabi-size` | The binutils `size` for your toolchain |
| `build_pattern` | `\b(cmake\s+--build\|ninja\|make)\b` | A Bash command matching this is a build |

Change any of them in `/config`; the mod reloads with the new values.

## Commands

- `/budget` prints the latest measurement and every build this session, with deltas.
- `/budget check` measures the ELF now without a build.

## What it hooks

`claude plugin validate ./firmware-budget` lists it:

```
hooks: session.start, command.run{command=budget}, tool.call{tool=Bash}, ui.render{component=AbovePrompt}
calls: $.command.register, $.process.run, $.state.get, $.state.set, $.ui.log, $.ui.resolve, $.ui.toast
```

It runs one program, the `size` tool, with `-A` and the ELF path as its arguments. It reads no files itself, makes no network requests, and calls no model.

## Tests

```bash
claude plugin test ./firmware-budget
```

Eight tests, built on the real `size -A` output of the Chapter 10 noise suppression ELF, cover the parser, the bars, measurement after a successful build, no measurement after a failed or non-build command, the commit guard over and within budget, `/budget check`, and a `size` tool that fails.

## Limits

- The guard matches the text of a Bash command. It is a reflex for the agent, not a branch protection rule.
- The mod runs `size` with the session's own PATH, which in the Desktop app is the app's environment, not your shell's. The Pico SDK installer keeps its toolchain under `~/.pico-sdk` and off the PATH, so set `size_tool` to the full path, such as `~/.pico-sdk/toolchain/14_2_Rel1/bin/arm-none-eabi-size`. The failure shows as one dim line above the prompt and in `/budget`.
- The build pattern is tested with any directory stripped from each word of the command, so a full path to `cmake` still counts as a build.
- The band is shared with other mods. This one draws its bars above whatever the mods after it draw.
- The band draws in the terminal and the Desktop app's Code tab. In the VS Code extension the hooks run but nothing is drawn; `/budget` still prints.
- `size` reports what the linker placed. Heap use beyond the SDK's reservation, stack depth beyond the dummy section, and anything your firmware writes to flash at runtime are not in the numbers.

## Licence

MIT. See `LICENSE`.
