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
    console.log(`Тег ${tag} уже существует, пропускаем создание`)
  } catch (e) {
    // Тег не существует, создаём его
    console.log(`Создаём тег ${tag}...`)
    execSync(`git tag ${tag}`, { stdio: 'inherit' })
    
    // Отправляем тег в GitHub
    console.log(`Отправляем тег ${tag} в GitHub...`)
    execSync(`git push origin ${tag}`, { stdio: 'inherit' })
    
    console.log(`✅ Тег ${tag} создан и отправлен. GitHub Actions запустится автоматически.`)
  }
} catch (error) {
  console.error('Ошибка при создании тега:', error.message)
  process.exit(1)
}
