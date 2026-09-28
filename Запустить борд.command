#!/bin/bash
# Двойной клик — запускает Task Board и открывает его в браузере.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите его с nodejs.org или командой: brew install node"
  read -r -p "Нажмите Enter, чтобы закрыть окно…"
  exit 1
fi
node server.mjs "$@"
