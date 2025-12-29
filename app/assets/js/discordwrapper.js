// Work in progress
const { LoggerUtil } = require('helios-core')

const logger = LoggerUtil.getLogger('DiscordWrapper')

const { Client } = require('discord-rpc-patch')

const Lang = require('./langloader')

let client
let activity
let isReady = false
let isDestroying = false

exports.initRPC = function(genSettings, servSettings, initialDetails = Lang.queryJS('discord.waiting')){
    client = new Client({ transport: 'ipc' })
    isReady = false

    activity = {
        details: initialDetails,
        state: Lang.queryJS('discord.state', {shortId: servSettings.shortId}),
        largeImageKey: servSettings.largeImageKey,
        largeImageText: servSettings.largeImageText,
        smallImageKey: genSettings.smallImageKey,
        smallImageText: genSettings.smallImageText,
        startTimestamp: new Date().getTime(),
        instance: false
    }

    client.on('ready', () => {
        logger.info('Discord RPC Connected')
        isReady = true
        try {
            client.setActivity(activity)
        } catch (error) {
            logger.warn('Failed to set initial activity:', error.message)
        }
    })

    client.on('disconnected', () => {
        logger.info('Discord RPC Disconnected')
        isReady = false
        // Если клиент отключился, помечаем как закрытый
        if(!isDestroying) {
            client = null
            activity = null
        }
    })
    
    client.login({clientId: genSettings.clientId}).catch(error => {
        isReady = false
        if(error.message.includes('ENOENT')) {
            logger.info('Unable to initialize Discord Rich Presence, no client detected.')
        } else {
            logger.info('Unable to initialize Discord Rich Presence: ' + error.message, error)
        }
    })
}

exports.updateDetails = function(details){
    if(!client || !isReady || !activity) return
    try {
        activity.details = details
        client.setActivity(activity)
    } catch (error) {
        logger.warn('Failed to update Discord activity:', error.message)
    }
}

exports.shutdownRPC = function(){
    if(!client || isDestroying) return
    
    // Помечаем, что мы в процессе закрытия
    isDestroying = true
    
    // Сохраняем ссылку на клиент перед очисткой
    const clientToDestroy = client
    
    // Сбрасываем флаг готовности сразу, чтобы предотвратить новые вызовы
    isReady = false
    
    // Очищаем ссылки сразу, чтобы предотвратить новые вызовы методов
    client = null
    activity = null
    
    // Попытка очистить активность (может не сработать, если соединение уже закрыто)
    clientToDestroy.clearActivity().catch(() => {
        // Игнорируем ошибки - соединение может быть уже закрыто
    })
    
    // Закрываем клиент
    // destroy() может создавать внутренние промисы, которые отклоняются
    // Оборачиваем в try-catch и обрабатываем промис, если он возвращается
    try {
        const destroyResult = clientToDestroy.destroy()
        // Если destroy() возвращает промис, обрабатываем его
        if(destroyResult && typeof destroyResult.catch === 'function') {
            destroyResult.catch(() => {
                // Игнорируем ошибки - соединение может быть уже закрыто
            })
        }
    } catch (error) {
        // Игнорируем синхронные ошибки при закрытии
    } finally {
        // Сбрасываем флаг после попытки закрытия
        isDestroying = false
    }
}