#!/usr/bin/env node

/**
 * Скрипт для создания и отправки git тега после публикации
 */

const { execSync } = require('child_process')
const packageJson = require('../package.json')

const version = packageJson.version
const tag = `v${version}`

try {
  // Проверяем, существует ли тег
  try {
    execSync(`git rev-parse ${tag}`, { stdio: 'ignore' })
    console.log(`Тег ${tag} уже существует, удаляем старый...`)
    try {
      execSync(`git tag -d ${tag}`, { stdio: 'ignore' })
      execSync(`git push origin :refs/tags/${tag}`, { stdio: 'ignore' })
    } catch (e) {
      // Игнорируем ошибки при удалении
    }
  } catch (e) {
    // Тег не существует, продолжаем
  }
  
  // Убеждаемся, что все изменения закоммичены и запушены
  const status = execSync('git status --porcelain', { encoding: 'utf8' })
  if (status.trim()) {
    console.error('❌ ОШИБКА: Есть незакоммиченные изменения!')
    console.error('Сначала закоммитьте все изменения, затем запустите публикацию снова.')
    process.exit(1)
  }
  
  // Проверяем, что текущий коммит запушен
  try {
    const localCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    const remoteCommit = execSync('git rev-parse origin/master', { encoding: 'utf8' }).trim()
    if (localCommit !== remoteCommit) {
      console.error('❌ ОШИБКА: Локальные изменения не запушены в origin/master!')
      console.error('Сначала запушьте изменения: git push origin master')
      process.exit(1)
    }
  } catch (e) {
    console.warn('⚠️  Не удалось проверить синхронизацию с remote, продолжаем...')
  }
  
  // Создаём тег на текущем коммите (HEAD)
  console.log(`Создаём тег ${tag} на текущем коммите...`)
  execSync(`git tag -f ${tag}`, { stdio: 'inherit' })
  
  // Отправляем тег в GitHub
  console.log(`Отправляем тег ${tag} в GitHub...`)
  execSync(`git push origin ${tag} --force`, { stdio: 'inherit' })
  
  console.log(`✅ Тег ${tag} создан и отправлен. GitHub Actions запустится автоматически.`)
} catch (error) {
  console.error('Ошибка при создании тега:', error.message)
  process.exit(1)
}
