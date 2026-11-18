// Scratch: record real IBus key/composition event sequences in Chromium (Electron). Not for merge.
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const out = process.env.CAPTURE_OUT || 'ime-capture.json'
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).trim() } catch (e) { return 'ERR ' + String(e.stderr || e.message).trim() }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><title>IMECAP</title><textarea id=t style="width:600px;height:200px"></textarea><script>
window.__log=[];const t=document.getElementById('t');
for (const ty of ['keydown','keyup','compositionstart','compositionupdate','compositionend','beforeinput','input']) {
  t.addEventListener(ty,(e)=>{window.__log.push({type:ty,key:e.key,code:e.code,keyCode:e.keyCode,isComposing:e.isComposing,data:e.data,inputType:e.inputType,value:t.value,ts:Math.round(e.timeStamp*10)/10})},true)
}
t.focus();</script>`

// [name, engine, steps]; a step is ['type', text] or ['key', keysym]
const SCENARIOS = [
  ['english-baseline', 'xkb:us::eng', [['type', 'abc'], ['key', 'Return']]],
  ['anthy-hiragana-convert-confirm-enter', 'anthy', [['type', 'nihongo'], ['key', 'space'], ['key', 'Return']]],
  ['anthy-hiragana-kana-confirm-enter', 'anthy', [['type', 'nihongo'], ['key', 'Return']]],
  ['mozc-convert-confirm-enter', 'mozc-jp', [['key', 'Hiragana'], ['type', 'nihongo'], ['key', 'space'], ['key', 'Return']]],
  ['mozc-kana-confirm-enter', 'mozc-jp', [['key', 'Hiragana'], ['type', 'nihongo'], ['key', 'Return']]],
  ['mozc-confirm-then-enter', 'mozc-jp', [['key', 'Hiragana'], ['type', 'nihongo'], ['key', 'space'], ['key', 'Return'], ['key', 'Return']]],
  ['pinyin-raw-enter', 'libpinyin', [['type', 'nihao'], ['key', 'Return']]],
  ['unikey-telex-enter', 'Unikey', [['type', 'xin chaof'], ['key', 'Return']]]
]


app.whenReady().then(async () => { try {
  const results = { electron: process.versions.electron, chrome: process.versions.chrome, sync: process.env.IBUS_ENABLE_SYNC_MODE ?? null, ibus: sh('ibus', ['version']), engines: sh('ibus', ['list-engine']).split('\n').filter((l) => /hangul|pinyin|anthy|unikey|Unikey|mozc|xkb:us::eng/i.test(l)), scenarios: [] }
  const win = new BrowserWindow({ width: 800, height: 400, show: true, webPreferences: { contextIsolation: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  await sleep(1500)
  const wid = sh('xdotool', ['search', '--sync', '--onlyvisible', '--name', 'IMECAP']).split('\n')[0]
  for (const [name, engine, steps] of SCENARIOS) {
    await win.webContents.executeJavaScript(`(()=>{window.__log=[];const el=document.getElementById('t');el.value='';el.blur();el.focus();return true})()`)
    sh('xdotool', ['windowactivate', '--sync', wid]); sh('xdotool', ['windowfocus', '--sync', wid])
    const set = sh('ibus', ['engine', engine]); await sleep(800)
    const active = sh('ibus', ['engine'])
    for (const [kind, arg] of steps) {
      if (kind === 'type') sh('xdotool', ['type', '--delay', '60', arg])
      else sh('xdotool', ['key', '--delay', '60', arg])
      await sleep(500)
    }
    await sleep(800)
    const log = await win.webContents.executeJavaScript('window.__log')
    results.scenarios.push({ name, engine, set, active, steps, log })
    sh('ibus', ['engine', 'xkb:us::eng']); await sleep(300)
  }
  fs.writeFileSync(out, JSON.stringify(results, null, 1))
  } catch (e) { fs.writeFileSync(out, JSON.stringify({ error: String(e && e.stack || e) })) }
  app.quit()
})
