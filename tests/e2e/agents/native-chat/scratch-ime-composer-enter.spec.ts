// Scratch QA (not for merge): one real IBus Enter in the native chat composer, per input method.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { SUPPORTED, openStubChat, test } from '../session-fixtures/structured-claude-stub'
import { presentNativeIbusWindow } from '../../terminal/lifecycle/terminal-native-ibus-window'

test.use({
  orcaAppExtraEnv: { GTK_IM_MODULE: 'ibus', QT_IM_MODULE: 'ibus', XMODIFIERS: '@im=ibus' }
})

const sh = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch (error) {
    return `ERR ${String((error as { stderr?: string }).stderr ?? error)}`
  }
}

type Step = ['type' | 'key', string]
const SCENARIOS: { name: string; engine: string; steps: Step[]; expectSent: boolean }[] = [
  { name: 'english', engine: 'xkb:us::eng', steps: [['type', 'hello'], ['key', 'Return']], expectSent: true },
  { name: 'vietnamese-unikey-telex', engine: 'Unikey', steps: [['type', 'xin chaof'], ['key', 'Return']], expectSent: true },
  { name: 'vietnamese-unikey-no-accent', engine: 'Unikey', steps: [['type', 'xin'], ['key', 'Return']], expectSent: true },
  { name: 'korean-hangul', engine: 'hangul', steps: [['type', 'gks'], ['key', 'Return']], expectSent: true },
  { name: 'pinyin-raw-letters-confirm', engine: 'libpinyin', steps: [['type', 'nihao'], ['key', 'Return']], expectSent: false },
  { name: 'pinyin-candidate-space', engine: 'libpinyin', steps: [['type', 'nihao'], ['key', 'space']], expectSent: false },
  { name: 'japanese-mozc-convert-confirm', engine: 'mozc-jp', steps: [['key', 'Hiragana'], ['type', 'nihongo'], ['key', 'space'], ['key', 'Return']], expectSent: false },
  { name: 'japanese-mozc-kana-confirm', engine: 'mozc-jp', steps: [['key', 'Hiragana'], ['type', 'nihongo'], ['key', 'Return']], expectSent: false }
]

test.describe('IME Enter in the native chat composer @headful', () => {
  test.skip(!SUPPORTED || process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1', 'scratch IBus QA')

  test('records what one Enter does per input method', async ({ electronApp, orcaPage: page, claudeStub }) => {
    test.setTimeout(240_000)
    await presentNativeIbusWindow(electronApp, page)
    const { composer, reply } = await openStubChat(page, claudeStub.command)
    const title = `ORCA_IME_QA_${randomUUID()}`
    await page.evaluate((t) => { document.title = t }, title)
    await expect.poll(() => page.title()).toBe(title)
    const results: Record<string, unknown>[] = []
    for (const scenario of SCENARIOS) {
      sh('ibus', ['engine', 'xkb:us::eng'])
      await composer.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Delete')
      const repliesBefore = await reply.count()
      sh('xdotool', ['search', '--onlyvisible', '--name', title, 'windowfocus', '--sync'])
      sh('ibus', ['engine', scenario.engine])
      await page.waitForTimeout(800)
      const active = sh('ibus', ['engine'])
      for (const [kind, arg] of scenario.steps) {
        if (kind === 'type') sh('xdotool', ['type', '--delay', '60', arg])
        else sh('xdotool', ['key', '--delay', '60', arg])
        await page.waitForTimeout(400)
      }
      await page.waitForTimeout(4_000)
      const repliesAfter = await reply.count()
      const composerText = await composer.evaluate((el) => (el as HTMLTextAreaElement).value ?? el.textContent)
      const sent = repliesAfter > repliesBefore
      results.push({ name: scenario.name, engine: active, sent, expectSent: scenario.expectSent, composerText, ok: sent === scenario.expectSent })
      sh('ibus', ['engine', 'xkb:us::eng'])
      await page.waitForTimeout(500)
    }
    mkdirSync('test-results', { recursive: true })
    writeFileSync(`test-results/ime-composer-enter-${process.env.QA_LABEL ?? 'run'}.json`, JSON.stringify(results, null, 1))
    console.log(JSON.stringify(results))
  })
})
