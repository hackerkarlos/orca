#!/usr/bin/env bash
# Scratch IME capture under xvfb + real IBus. Not for merge.
set -x
mkdir -p test-results
gsettings set org.freedesktop.ibus.engine.hangul initial-input-mode 'hangul' || true
gsettings set org.freedesktop.ibus.engine.anthy.common input-mode 0 || true
gsettings list-recursively org.freedesktop.ibus.engine.anthy.common 2>/dev/null | grep -i input-mode || true
mkdir -p ~/.config/mozc && printf 'preedit_method: ROMAN\n' > /dev/null
xfwm4 --compositor=off >/dev/null 2>&1 &
for mode in 1 0; do
  ibus-daemon --xim --panel=disable --emoji-extension=disable -d -r
  sleep 4
  ibus list-engine | grep -iE 'hangul|pinyin|anthy|unikey|mozc' || true
  GTK_IM_MODULE=ibus XMODIFIERS=@im=ibus QT_IM_MODULE=ibus IBUS_ENABLE_SYNC_MODE=$mode CAPTURE_OUT=test-results/ime-capture-sync$mode.json \
    timeout 240 node_modules/electron/dist/electron --no-sandbox --ozone-platform=x11 ime-capture/capture-main.cjs || echo "capture exit $?"
  ibus exit || true
  sleep 2
done
ls -la test-results
