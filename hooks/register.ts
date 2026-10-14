import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Sample } from '../types'

// Values a drawing reads, kept for the session and across a reload
const samples = atom({ plugin: 'firmware-budget', key: 'samples' } as const, [] as Sample[])
const fault = atom({ plugin: 'firmware-budget', key: 'fault' } as const, null as string | null)

// What the manifest's userConfig resolves to, with defaults applied by the engine
type Options = {
  elf: string
  flash_budget: number
  ram_budget: number
  ram_start: number
  size_tool: string
  build_pattern: string
}

const COMMIT = /\bgit\s+commit\b/

// Parse SysV-format `size -A` output into flash and RAM use.
//
//   section          size        addr
//   .text          143832   268435456
//   .data            6968   536871184
//   ...
//
// Flash is every section the linker placed below `ramStart` (the XIP image),
// plus `.data`, whose initial image lives in flash and is copied to RAM at boot.
// RAM is every section placed at or above `ramStart`, which on the Pico SDK
// includes the vector table, .data, .bss and the SDK's minimum heap and stack
// reservations. Debug sections have address 0 and count for neither.
//
// Berkeley `size` (no -A) is not used because the Pico SDK linker script marks
// .data executable, and Berkeley size then folds it into the text column and
// reports data 0, which under-reports RAM by the size of .data.
export function parseSize(stdout: string, ramStart: number): { flash: number; ram: number } | null {
  let flash = 0
  let ram = 0
  let data = 0
  let rows = 0
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length !== 3) continue
    const name = cols[0] ?? ''
    const size = Number(cols[1])
    const addr = Number(cols[2])
    if (!name.startsWith('.') || Number.isNaN(size) || Number.isNaN(addr)) continue
    rows += 1
    if (addr === 0) continue
    if (addr >= ramStart) ram += size
    else flash += size
    if (name === '.data') data = size
  }
  if (rows === 0) return null
  return { flash: flash + data, ram }
}

export function toSample(parsed: { flash: number; ram: number }, n: number, label: string): Sample {
  return { n, flash: parsed.flash, ram: parsed.ram, label }
}

// A bar of `width` cells, filled in proportion to used / budget, capped at full
export function bar(used: number, budget: number, width: number): string {
  const fraction = budget > 0 ? Math.min(used / budget, 1) : 1
  const filled = Math.round(fraction * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function percent(used: number, budget: number): string {
  if (budget <= 0) return '?'
  return ((used / budget) * 100).toFixed(1) + '%'
}

export function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1) + ' KB'
}

function overBudget(s: Sample, o: Options): string | null {
  const reasons: string[] = []
  if (s.flash > o.flash_budget) reasons.push(`flash ${s.flash} B is over the ${o.flash_budget} B budget by ${s.flash - o.flash_budget} B`)
  if (s.ram > o.ram_budget) reasons.push(`RAM ${s.ram} B is over the ${o.ram_budget} B budget by ${s.ram - o.ram_budget} B`)
  return reasons.length ? reasons.join('; ') : null
}

// Run the size tool on the ELF and record a sample. Returns what went wrong, or null.
async function measure($: EngineInterface, o: Options, label: string): Promise<string | null> {
  let ran: { exitCode: number; stdout: string; stderr: string }
  try {
    ran = await $.process.run([o.size_tool, '-A', o.elf], { timeoutMs: 15000 })
  } catch (error) {
    const why = `${o.size_tool} could not start: ${String(error)}`
    await update($, fault, () => why)
    return why
  }
  if (ran.exitCode !== 0) {
    const why = `${o.size_tool} exited ${ran.exitCode}: ${ran.stderr.trim().split('\n')[0] ?? ''}`
    await update($, fault, () => why)
    return why
  }
  const parsed = parseSize(ran.stdout, o.ram_start)
  if (parsed === null) {
    const why = `${o.size_tool} -A output had no section rows`
    await update($, fault, () => why)
    return why
  }
  const history = await read($, samples)
  const sample = toSample(parsed, history.length + 1, label)
  await update($, samples, list => [...list, sample])
  await update($, fault, () => null)
  const over = overBudget(sample, o)
  if (over !== null) $.ui.toast(`firmware-budget: ${over}`)
  return null
}

function summary(history: Sample[], o: Options, lastFault: string | null): string {
  if (history.length === 0) {
    return lastFault ? `No measurement yet. Last attempt failed: ${lastFault}` : `No measurement yet. Build the firmware, or run /budget check.`
  }
  const rows = history.map((s, i) => {
    const before = i > 0 ? history[i - 1] : undefined
    const dFlash = before ? s.flash - before.flash : 0
    const dRam = before ? s.ram - before.ram : 0
    const sign = (d: number) => (d > 0 ? '+' : '') + d
    return `${s.n}. flash ${s.flash} B (${sign(dFlash)})  ram ${s.ram} B (${sign(dRam)})  ${s.label}`
  })
  const last = history[history.length - 1]
  if (last === undefined) return 'No measurement yet.'
  const head = `flash ${last.flash} / ${o.flash_budget} B (${percent(last.flash, o.flash_budget)}), ram ${last.ram} / ${o.ram_budget} B (${percent(last.ram, o.ram_budget)})`
  const over = overBudget(last, o)
  return [head, over ? `OVER BUDGET: ${over}` : 'within budget', ...rows].join('\n')
}

export const register: Register = (on, options) => {
  const o = options as unknown as Options
  const build = new RegExp(o.build_pattern)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({
        name: 'budget',
        description: 'Show flash and RAM use of the firmware ELF; "check" measures it now',
        argumentHint: '[check]',
      })
    } catch {
      // The name is taken; the band and the guard still work
    }
    return started
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    if (e.args.trim() === 'check') {
      const why = await measure($, o, '/budget check')
      if (why !== null) return { text: why }
    }
    return { text: summary(await read($, samples), o, await read($, fault)) }
  })

  // One hook for Bash. Before the call: hold a commit while the last build is
  // over budget, judged before next so a failure fails closed. After the call:
  // if it was a build that succeeded, measure the ELF.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (COMMIT.test(e.command)) {
      const history = await read($, samples)
      const last = history[history.length - 1]
      const over = last === undefined ? null : overBudget(last, o)
      if (over !== null) {
        return {
          deny: `firmware-budget refused this commit: ${over}. Reduce the firmware size, or ask the user to raise the budget in /config, then commit again.`,
        }
      }
    }
    const ran = await next(e)
    if (!build.test(e.command)) return ran
    if (ran.deny !== undefined || ran.isError === true) return ran
    const label = e.command.trim().replace(/\s+/g, ' ').slice(0, 40)
    const why = await measure($, o, label)
    if (why !== null) $.ui.log(why)
    return ran
  }).catch(($, e, next) =>
    next.called ? next(e) : COMMIT.test(e.command) ? { deny: 'firmware-budget: its commit guard failed, so the commit was not run.' } : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const history = await read($, samples)
    const lastFault = await read($, fault)
    const { Box, Text } = $.ui.resolve(e)

    if (history.length === 0) {
      if (lastFault === null) return next(e)
      return Box({ children: [Text({ dimColor: true, children: ['firmware-budget: ' + lastFault] })] })
    }

    const last = history[history.length - 1]
    if (last === undefined) return next(e)
    const prev = history.length > 1 ? history[history.length - 2] ?? null : null
    const delta = (now: number, before: number | null) => (before === null ? '' : ' ' + (now - before >= 0 ? '+' : '') + (now - before) + ' B')
    const line = (name: string, used: number, budget: number, before: number | null) => {
      const over = used > budget
      return Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ bold: true, children: [name.padEnd(5)] }),
          Text({ color: over ? 'red' : 'green', children: [bar(used, budget, 20)] }),
          Text({ children: [`${percent(used, budget).padStart(6)}  ${kb(used)} / ${kb(budget)}`] }),
          Text({ dimColor: true, children: [delta(used, before)] }),
        ],
      })
    }
    return Box({
      flexDirection: 'column',
      children: [
        line('flash', last.flash, o.flash_budget, prev ? prev.flash : null),
        line('ram', last.ram, o.ram_budget, prev ? prev.ram : null),
        Text({ dimColor: true, children: [`build ${last.n} · ${last.label}` + (lastFault ? ' · ' + lastFault : '')] }),
      ],
    })
  })
}
