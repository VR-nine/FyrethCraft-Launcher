#!/usr/bin/env node

/**
 * Скрипт для извлечения release notes из CHANGELOG.md для текущей версии
 * Использование: node scripts/get-release-notes.js
 */

const fs = require('fs')
const path = require('path')

const packageJson = require('../package.json')
const version = packageJson.version
const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md')

if (!fs.existsSync(changelogPath)) {
    console.error('CHANGELOG.md не найден!')
    process.exit(1)
}

const changelog = fs.readFileSync(changelogPath, 'utf8')

// Ищем секцию для текущей версии
// Формат: ## [0.1.4] - 2026-01-12\n\n...содержимое...\n\n## [следующая версия] или конец файла
const versionPattern = new RegExp(`## \\[${version.replace(/\./g, '\\.')}\\][^]*?(?=\\n## |$)`, 's')
const match = changelog.match(versionPattern)

if (!match) {
    console.error(`Версия ${version} не найдена в CHANGELOG.md!`)
    process.exit(1)
}

let releaseNotes = match[0]

// Убираем заголовок версии (## [0.1.4] - 2026-01-12)
releaseNotes = releaseNotes.replace(/^## \[.*?\] - \d{4}-\d{2}-\d{2}\s*\n+/, '')

// Убираем ссылки в конце файла (если есть)
releaseNotes = releaseNotes.replace(/\n+\[.*?\]: .*$/gm, '')

// Очищаем от лишних пробелов в начале и конце
releaseNotes = releaseNotes.trim()

if (!releaseNotes) {
    console.error(`Release notes для версии ${version} пусты!`)
    process.exit(1)
}

console.log(releaseNotes)
