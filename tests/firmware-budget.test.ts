import { expect, test } from 'claude-code/testing'

import { bar, isBuild, parseSize, percent, toSample } from '../hooks/register'

// size -A output from the Chapter 10 noise suppression build, Pico 2, Release, 25 Sep 2026
const SIZE_OUT = `build/pico2-audio-spectrogram.elf  :
section                  size        addr
.text                  143832   268435456
.rodata                684052   268579288
.ARM.exidx                  8   269263340
.binary_info               36   269263348
.ram_vector_table         272   536870912
.uninitialized_data         0   536871184
.data                    6968   536871184
.tdata                      0   536878152
.tbss                       0   536878152
.bss                   115984   536878152
.heap                    2048   536994136
.scratch_x                  0   537395200
.scratch_y                  0   537399296
.stack1_dummy            2048   537395200
.stack_dummy             2048   537399296
.flash_end                 20   269270352
.ARM.attributes            52           0
.comment                   69           0
.debug_info            522658           0
.debug_line            390256           0
Total                 2546587
`
const RAM_START = 0x20000000

const BAND = {
  plugin: 'firmware-budget',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const RUN = { command: 'budget', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

const OPTIONS = {
  elf: 'build/pico2-audio-spectrogram.elf',
  flash_budget: 4194304,
  ram_budget: 532480,
  ram_start: RAM_START,
  size_tool: 'arm-none-eabi-size',
  build_pattern: '\\b(cmake\\s+--build|ninja|make)\\b',
}

test('parses size -A output into flash and RAM by address', async () => {
  const parsed = parseSize(SIZE_OUT, RAM_START)
  // flash: .text .rodata .ARM.exidx .binary_info .flash_end, plus the .data load image
  expect(parsed).toEqual({ flash: 834916, ram: 129368 })
  const s = toSample(parsed!, 1, 'make')
  expect(s.flash).toBe(834916)
  expect(s.ram).toBe(129368)
  expect(parseSize('arm-none-eabi-size: no such file', RAM_START)).toBe(null)
})

test('a full path to the build tool still counts as a build', async () => {
  const pattern = new RegExp(OPTIONS.build_pattern)
  expect(isBuild('cmake --build build', pattern)).toBe(true)
  expect(isBuild('/Users/dsuch/.pico-sdk/cmake/v3.31.5/CMake.app/Contents/bin/cmake --build build', pattern)).toBe(true)
  expect(isBuild('cd build && make -j4', pattern)).toBe(true)
  expect(isBuild('ls build', pattern)).toBe(false)
  expect(isBuild('cmake -S . -B build', pattern)).toBe(false)
})

test('bar and percent are proportional and capped', async () => {
  expect(bar(0, 100, 10)).toBe('░░░░░░░░░░')
  expect(bar(50, 100, 10)).toBe('█████░░░░░')
  expect(bar(250, 100, 10)).toBe('██████████')
  expect(percent(129368, 532480)).toBe('24.3%')
})

test('a successful build measures the ELF and the band draws it', { options: OPTIONS }, async ($, on) => {
  const argvs: string[][] = []
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    return { value: { exitCode: 0, stdout: SIZE_OUT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'built' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // What another band mod, or Claude Code, draws beneath this one
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['context: 41%'] }))

  await $.tool.call({ tool: 'Bash', command: 'cmake --build build' })
  expect(argvs).toEqual([['arm-none-eabi-size', '-A', 'build/pico2-audio-spectrogram.elf']])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /815\.3 KB \/ 4096\.0 KB/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /126\.3 KB \/ 520\.0 KB/ })).toBeDefined()
    // The other mod's band is kept under the bars
    expect(await ui.find({ type: 'Text', text: 'context: 41%' })).toBeDefined()
    await ui.unmount()
  }
})

test('a non-build command and a failed build do not measure', { options: OPTIONS }, async ($, on) => {
  let runs = 0
  on('process.run', () => {
    runs += 1
    return { value: { exitCode: 0, stdout: SIZE_OUT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', ($, e) => (e.tool === 'Bash' && e.command === 'make' ? { result: 'error', isError: true } : { result: 'ok' }))
  on('ui.log', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'ls build' })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(runs).toBe(0)
})

test('a commit is held while the last build is over budget', { options: { ...OPTIONS, ram_budget: 120000 } }, async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: SIZE_OUT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.log', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.tool.call({ tool: 'Bash', command: 'ninja -C build' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/RAM 129368 B is over the 120000 B budget by 9368 B/)

  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -m "shrink later"' })
  expect(commit.deny).toMatch(/refused this commit/)

  // Other commands still run
  const status = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(status.deny).toBeUndefined()
})

test('a commit runs when there is no measurement or the build is within budget', { options: OPTIONS }, async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: SIZE_OUT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.log', () => ({ value: undefined }))

  const before = await $.tool.call({ tool: 'Bash', command: 'git commit -m "no build yet"' })
  expect(before.deny).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'make -C build' })
  const after = await $.tool.call({ tool: 'Bash', command: 'git commit -m "within budget"' })
  expect(after.deny).toBeUndefined()
})

test('/budget check measures now and reports the history', { options: OPTIONS }, async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: SIZE_OUT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))

  const answer = await $.command.run({ ...RUN, args: 'check' })
  expect(answer.text).toMatch(/^flash 834916 \/ 4194304 B \(19\.9%\), ram 129368 \/ 532480 B \(24\.3%\)/)
  expect(answer.text).toMatch(/within budget/)
  expect(answer.text).toMatch(/1\. flash 834916 B \(0\)  ram 129368 B \(0\)  \/budget check/)
})

test('a size tool that fails is reported and does not record a sample', { options: OPTIONS }, async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: "arm-none-eabi-size: 'build/pico2-audio-spectrogram.elf': No such file", isStdoutTruncated: false, isStderrTruncated: false } }))

  const answer = await $.command.run({ ...RUN, args: 'check' })
  expect(answer.text).toMatch(/exited 1: arm-none-eabi-size: 'build\/pico2-audio-spectrogram.elf': No such file/)

  const empty = await $.command.run({ ...RUN, args: '' })
  expect(empty.text).toMatch(/^No measurement yet\. Last attempt failed:/)
})
