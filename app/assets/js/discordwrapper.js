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
        // If client disconnected, mark as closed
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
    
    // Mark that we are in the process of closing
    isDestroying = true
    
    // Save reference to client before cleanup
    const clientToDestroy = client
    
    // Reset ready flag immediately to prevent new calls
    isReady = false
    
    // Clear references immediately to prevent new method calls
    client = null
    activity = null
    
    // Try to clear activity (may not work if connection is already closed)
    clientToDestroy.clearActivity().catch(() => {
        // Ignore errors - connection may already be closed
    })
    
    // Close the client
    // destroy() may create internal promises that are rejected
    // Wrap in try-catch and handle promise if it returns one
    try {
        const destroyResult = clientToDestroy.destroy()
        // If destroy() returns a promise, handle it
        if(destroyResult && typeof destroyResult.catch === 'function') {
            destroyResult.catch(() => {
                // Ignore errors - connection may already be closed
            })
        }
    } catch (error) {
        // Ignore synchronous errors during closing
    } finally {
        // Reset flag after closing attempt
        isDestroying = false
    }
}