/**
 * AuthManager
 * 
 * This module aims to abstract login procedures. Results from Mojang's REST api
 * are retrieved through our Mojang module. These results are processed and stored,
 * if applicable, in the config using the ConfigManager. All login procedures should
 * be made through this module.
 * 
 * @module authmanager
 */
// Requirements
const ConfigManager          = require('./configmanager')
const { LoggerUtil }         = require('helios-core')
const { RestResponseStatus } = require('helios-core/common')
const { MojangRestAPI, MojangErrorCode } = require('helios-core/mojang')
const { MicrosoftAuth, MicrosoftErrorCode } = require('helios-core/microsoft')
const { AZURE_CLIENT_ID }    = require('./ipcconstants')
const { ElyRestAPI, ElyErrorCode, elyErrorDisplayable } = require('./elyauth')
const Lang = require('./langloader')

const log = LoggerUtil.getLogger('AuthManager')

// Error messages

function microsoftErrorDisplayable(errorCode) {
    switch (errorCode) {
        case MicrosoftErrorCode.NO_PROFILE:
            return {
                title: Lang.queryJS('auth.microsoft.error.noProfileTitle'),
                desc: Lang.queryJS('auth.microsoft.error.noProfileDesc')
            }
        case MicrosoftErrorCode.NO_XBOX_ACCOUNT:
            return {
                title: Lang.queryJS('auth.microsoft.error.noXboxAccountTitle'),
                desc: Lang.queryJS('auth.microsoft.error.noXboxAccountDesc')
            }
        case MicrosoftErrorCode.XBL_BANNED:
            return {
                title: Lang.queryJS('auth.microsoft.error.xblBannedTitle'),
                desc: Lang.queryJS('auth.microsoft.error.xblBannedDesc')
            }
        case MicrosoftErrorCode.UNDER_18:
            return {
                title: Lang.queryJS('auth.microsoft.error.under18Title'),
                desc: Lang.queryJS('auth.microsoft.error.under18Desc')
            }
        case MicrosoftErrorCode.UNKNOWN:
            return {
                title: Lang.queryJS('auth.microsoft.error.unknownTitle'),
                desc: Lang.queryJS('auth.microsoft.error.unknownDesc')
            }
    }
}

function mojangErrorDisplayable(errorCode) {
    switch(errorCode) {
        case MojangErrorCode.ERROR_METHOD_NOT_ALLOWED:
            return {
                title: Lang.queryJS('auth.mojang.error.methodNotAllowedTitle'),
                desc: Lang.queryJS('auth.mojang.error.methodNotAllowedDesc')
            }
        case MojangErrorCode.ERROR_NOT_FOUND:
            return {
                title: Lang.queryJS('auth.mojang.error.notFoundTitle'),
                desc: Lang.queryJS('auth.mojang.error.notFoundDesc')
            }
        case MojangErrorCode.ERROR_USER_MIGRATED:
            return {
                title: Lang.queryJS('auth.mojang.error.accountMigratedTitle'),
                desc: Lang.queryJS('auth.mojang.error.accountMigratedDesc')
            }
        case MojangErrorCode.ERROR_INVALID_CREDENTIALS:
            return {
                title: Lang.queryJS('auth.mojang.error.invalidCredentialsTitle'),
                desc: Lang.queryJS('auth.mojang.error.invalidCredentialsDesc')
            }
        case MojangErrorCode.ERROR_RATELIMIT:
            return {
                title: Lang.queryJS('auth.mojang.error.tooManyAttemptsTitle'),
                desc: Lang.queryJS('auth.mojang.error.tooManyAttemptsDesc')
            }
        case MojangErrorCode.ERROR_INVALID_TOKEN:
            return {
                title: Lang.queryJS('auth.mojang.error.invalidTokenTitle'),
                desc: Lang.queryJS('auth.mojang.error.invalidTokenDesc')
            }
        case MojangErrorCode.ERROR_ACCESS_TOKEN_HAS_PROFILE:
            return {
                title: Lang.queryJS('auth.mojang.error.tokenHasProfileTitle'),
                desc: Lang.queryJS('auth.mojang.error.tokenHasProfileDesc')
            }
        case MojangErrorCode.ERROR_CREDENTIALS_MISSING:
            return {
                title: Lang.queryJS('auth.mojang.error.credentialsMissingTitle'),
                desc: Lang.queryJS('auth.mojang.error.credentialsMissingDesc')
            }
        case MojangErrorCode.ERROR_INVALID_SALT_VERSION:
            return {
                title: Lang.queryJS('auth.mojang.error.invalidSaltVersionTitle'),
                desc: Lang.queryJS('auth.mojang.error.invalidSaltVersionDesc')
            }
        case MojangErrorCode.ERROR_UNSUPPORTED_MEDIA_TYPE:
            return {
                title: Lang.queryJS('auth.mojang.error.unsupportedMediaTypeTitle'),
                desc: Lang.queryJS('auth.mojang.error.unsupportedMediaTypeDesc')
            }
        case MojangErrorCode.ERROR_GONE:
            return {
                title: Lang.queryJS('auth.mojang.error.accountGoneTitle'),
                desc: Lang.queryJS('auth.mojang.error.accountGoneDesc')
            }
        case MojangErrorCode.ERROR_UNREACHABLE:
            return {
                title: Lang.queryJS('auth.mojang.error.unreachableTitle'),
                desc: Lang.queryJS('auth.mojang.error.unreachableDesc')
            }
        case MojangErrorCode.ERROR_NOT_PAID:
            return {
                title: Lang.queryJS('auth.mojang.error.gameNotPurchasedTitle'),
                desc: Lang.queryJS('auth.mojang.error.gameNotPurchasedDesc')
            }
        case MojangErrorCode.UNKNOWN:
            return {
                title: Lang.queryJS('auth.mojang.error.unknownErrorTitle'),
                desc: Lang.queryJS('auth.mojang.error.unknownErrorDesc')
            }
        default:
            throw new Error(`Unknown error code: ${errorCode}`)
    }
}

// Functions

/**
 * Add a Mojang account. This will authenticate the given credentials with Mojang's
 * authserver. The resultant data will be stored as an auth account in the
 * configuration database.
 * 
 * @param {string} username The account username (email if migrated).
 * @param {string} password The account password.
 * @returns {Promise.<Object>} Promise which resolves the resolved authenticated account object.
 */
exports.addMojangAccount = async function(username, password) {
    try {
        const response = await MojangRestAPI.authenticate(username, password, ConfigManager.getClientToken())
        if(response.responseStatus === RestResponseStatus.SUCCESS) {

            const session = response.data
            if(session.selectedProfile != null){
                const ret = ConfigManager.addMojangAuthAccount(session.selectedProfile.id, session.accessToken, username, session.selectedProfile.name)
                if(ConfigManager.getClientToken() == null){
                    ConfigManager.setClientToken(session.clientToken)
                }
                ConfigManager.save()
                return ret
            } else {
                return Promise.reject(mojangErrorDisplayable(MojangErrorCode.ERROR_NOT_PAID))
            }

        } else {
            return Promise.reject(mojangErrorDisplayable(response.mojangErrorCode))
        }
        
    } catch (err){
        log.error(err)
        return Promise.reject(mojangErrorDisplayable(MojangErrorCode.UNKNOWN))
    }
}

const AUTH_MODE = { FULL: 0, MS_REFRESH: 1, MC_REFRESH: 2 }

/**
 * Perform the full MS Auth flow in a given mode.
 * 
 * AUTH_MODE.FULL = Full authorization for a new account.
 * AUTH_MODE.MS_REFRESH = Full refresh authorization.
 * AUTH_MODE.MC_REFRESH = Refresh of the MC token, reusing the MS token.
 * 
 * @param {string} entryCode FULL-AuthCode. MS_REFRESH=refreshToken, MC_REFRESH=accessToken
 * @param {*} authMode The auth mode.
 * @returns An object with all auth data. AccessToken object will be null when mode is MC_REFRESH.
 */
async function fullMicrosoftAuthFlow(entryCode, authMode) {
    try {

        let accessTokenRaw
        let accessToken
        if(authMode !== AUTH_MODE.MC_REFRESH) {
            const accessTokenResponse = await MicrosoftAuth.getAccessToken(entryCode, authMode === AUTH_MODE.MS_REFRESH, AZURE_CLIENT_ID)
            if(accessTokenResponse.responseStatus === RestResponseStatus.ERROR) {
                return Promise.reject(microsoftErrorDisplayable(accessTokenResponse.microsoftErrorCode))
            }
            accessToken = accessTokenResponse.data
            accessTokenRaw = accessToken.access_token
        } else {
            accessTokenRaw = entryCode
        }
        
        const xblResponse = await MicrosoftAuth.getXBLToken(accessTokenRaw)
        if(xblResponse.responseStatus === RestResponseStatus.ERROR) {
            return Promise.reject(microsoftErrorDisplayable(xblResponse.microsoftErrorCode))
        }
        const xstsResonse = await MicrosoftAuth.getXSTSToken(xblResponse.data)
        if(xstsResonse.responseStatus === RestResponseStatus.ERROR) {
            return Promise.reject(microsoftErrorDisplayable(xstsResonse.microsoftErrorCode))
        }
        
        // Extract XUID from XSTS response (Xbox User ID)
        // XUID can be in different places depending on the response format
        let xuid = null
        let isRealXuid = false // Track if we have real xid (not uhs)
        
        // Log full XSTS response structure for debugging (without sensitive data)
        if(xstsResonse.data) {
            const xstsKeys = Object.keys(xstsResonse.data)
            log.info(`XSTS Response keys: ${xstsKeys.join(', ')}`)
            
                // Try different possible locations for XUID
                if(xstsResonse.data.DisplayClaims) {
                    log.info(`XSTS DisplayClaims keys: ${Object.keys(xstsResonse.data.DisplayClaims).join(', ')}`)
                    
                    // Method 1: DisplayClaims.xui[0].xid (most common format according to Microsoft docs)
                    if(xstsResonse.data.DisplayClaims.xui) {
                        if(Array.isArray(xstsResonse.data.DisplayClaims.xui) && xstsResonse.data.DisplayClaims.xui.length > 0) {
                            const xuiObj = xstsResonse.data.DisplayClaims.xui[0]
                            if(xuiObj && xuiObj.xid) {
                                xuid = xuiObj.xid.toString()
                                isRealXuid = true
                                log.info(`✓ Extracted XUID from DisplayClaims.xui[0].xid: ${xuid}`)
                            } else if(xuiObj && xuiObj.uhs) {
                                // Fallback: Use uhs (User Hash String) as XUID
                                // This happens when account doesn't have xid in XSTS response
                                // Note: uhs is NOT a real XUID and may not work for skin loading
                                xuid = xuiObj.uhs.toString()
                                isRealXuid = false
                                log.warn(`DisplayClaims.xui[0].xid not found, using uhs as XUID: ${xuid} (Note: uhs is not a real XUID)`)
                            } else {
                                log.warn(`DisplayClaims.xui[0] exists but neither xid nor uhs found. Object keys: ${xuiObj ? Object.keys(xuiObj).join(', ') : 'null'}`)
                            }
                        } else if(typeof xstsResonse.data.DisplayClaims.xui === 'object' && xstsResonse.data.DisplayClaims.xui.xid) {
                            xuid = xstsResonse.data.DisplayClaims.xui.xid.toString()
                            isRealXuid = true
                            log.info(`✓ Extracted XUID from DisplayClaims.xui.xid: ${xuid}`)
                        }
                    }
                    
                    // Method 2: DisplayClaims.xuid (alternative format)
                    if(!xuid && xstsResonse.data.DisplayClaims.xuid) {
                        if(Array.isArray(xstsResonse.data.DisplayClaims.xuid) && xstsResonse.data.DisplayClaims.xuid.length > 0) {
                            xuid = xstsResonse.data.DisplayClaims.xuid[0].toString()
                            isRealXuid = true
                            log.info(`✓ Extracted XUID from DisplayClaims.xuid array: ${xuid}`)
                        } else if(typeof xstsResonse.data.DisplayClaims.xuid === 'string') {
                            xuid = xstsResonse.data.DisplayClaims.xuid
                            isRealXuid = true
                            log.info(`✓ Extracted XUID from DisplayClaims.xuid string: ${xuid}`)
                        } else if(typeof xstsResonse.data.DisplayClaims.xuid === 'number') {
                            xuid = xstsResonse.data.DisplayClaims.xuid.toString()
                            isRealXuid = true
                            log.info(`✓ Extracted XUID from DisplayClaims.xuid number: ${xuid}`)
                        }
                    }
                
                // Method 3: DisplayClaims.uhs (User Hash) - sometimes contains XUID
                if(!xuid && xstsResonse.data.DisplayClaims.uhs) {
                    log.info(`DisplayClaims.uhs found: ${Array.isArray(xstsResonse.data.DisplayClaims.uhs) ? xstsResonse.data.DisplayClaims.uhs[0] : xstsResonse.data.DisplayClaims.uhs}`)
                }
                
                if(!xuid) {
                    log.warn('⚠ XUID not found in XSTS DisplayClaims. Full structure:', JSON.stringify(xstsResonse.data.DisplayClaims, null, 2))
                }
            } else {
                log.warn('⚠ XSTS response missing DisplayClaims. Available keys:', xstsKeys.join(', '))
                // Try to find XUID in root level
                if(xstsResonse.data.xuid) {
                    xuid = xstsResonse.data.xuid.toString()
                    isRealXuid = true
                    log.info(`✓ Extracted XUID from root level: ${xuid}`)
                }
            }
        } else {
            log.error('❌ XSTS response data is null or undefined')
        }
        
        const mcTokenResponse = await MicrosoftAuth.getMCAccessToken(xstsResonse.data)
        if(mcTokenResponse.responseStatus === RestResponseStatus.ERROR) {
            return Promise.reject(microsoftErrorDisplayable(mcTokenResponse.microsoftErrorCode))
        }
        const mcProfileResponse = await MicrosoftAuth.getMCProfile(mcTokenResponse.data.access_token)
        if(mcProfileResponse.responseStatus === RestResponseStatus.ERROR) {
            return Promise.reject(microsoftErrorDisplayable(mcProfileResponse.microsoftErrorCode))
        }
        return {
            accessToken,
            accessTokenRaw,
            xbl: xblResponse.data,
            xsts: xstsResonse.data,
            xuid: xuid, // Xbox User ID extracted from XSTS
            isRealXuid: isRealXuid, // Flag indicating if xuid is real xid (not uhs)
            mcToken: mcTokenResponse.data,
            mcProfile: mcProfileResponse.data
        }
    } catch(err) {
        log.error(err)
        return Promise.reject(microsoftErrorDisplayable(MicrosoftErrorCode.UNKNOWN))
    }
}

/**
 * Calculate the expiry date. Advance the expiry time by 10 seconds
 * to reduce the liklihood of working with an expired token.
 * 
 * @param {number} nowMs Current time milliseconds.
 * @param {number} epiresInS Expires in (seconds)
 * @returns 
 */
function calculateExpiryDate(nowMs, epiresInS) {
    return nowMs + ((epiresInS-10)*1000)
}

/**
 * Add a Microsoft account. This will pass the provided auth code to Mojang's OAuth2.0 flow.
 * The resultant data will be stored as an auth account in the configuration database.
 * 
 * @param {string} authCode The authCode obtained from microsoft.
 * @returns {Promise.<Object>} Promise which resolves the resolved authenticated account object.
 */
exports.addMicrosoftAccount = async function(authCode) {

    const fullAuth = await fullMicrosoftAuthFlow(authCode, AUTH_MODE.FULL)

    // Advance expiry by 10 seconds to avoid close calls.
    const now = new Date().getTime()

    const ret = ConfigManager.addMicrosoftAuthAccount(
        fullAuth.mcProfile.id,
        fullAuth.mcToken.access_token,
        fullAuth.mcProfile.name,
        calculateExpiryDate(now, fullAuth.mcToken.expires_in),
        fullAuth.accessToken.access_token,
        fullAuth.accessToken.refresh_token,
        calculateExpiryDate(now, fullAuth.accessToken.expires_in),
        fullAuth.xuid, // Save XUID from XSTS response
        fullAuth.isRealXuid // Save flag indicating if xuid is real xid (not uhs)
    )
    ConfigManager.save()

    return ret
}

/**
 * Remove a Mojang account. This will invalidate the access token associated
 * with the account and then remove it from the database.
 * 
 * @param {string} uuid The UUID of the account to be removed.
 * @returns {Promise.<void>} Promise which resolves to void when the action is complete.
 */
exports.removeMojangAccount = async function(uuid){
    try {
        const authAcc = ConfigManager.getAuthAccount(uuid)
        const response = await MojangRestAPI.invalidate(authAcc.accessToken, ConfigManager.getClientToken())
        if(response.responseStatus === RestResponseStatus.SUCCESS) {
            ConfigManager.removeAuthAccount(uuid)
            ConfigManager.save()
            return Promise.resolve()
        } else {
            log.error('Error while removing account', response.error)
            return Promise.reject(response.error)
        }
    } catch (err){
        log.error('Error while removing account', err)
        return Promise.reject(err)
    }
}

/**
 * Remove a Microsoft account. It is expected that the caller will invoke the OAuth logout
 * through the ipc renderer.
 * 
 * @param {string} uuid The UUID of the account to be removed.
 * @returns {Promise.<void>} Promise which resolves to void when the action is complete.
 */
exports.removeMicrosoftAccount = async function(uuid){
    try {
        ConfigManager.removeAuthAccount(uuid)
        ConfigManager.save()
        return Promise.resolve()
    } catch (err){
        log.error('Error while removing account', err)
        return Promise.reject(err)
    }
}

/**
 * Validate the selected account with Mojang's authserver. If the account is not valid,
 * we will attempt to refresh the access token and update that value. If that fails, a
 * new login will be required.
 * 
 * @returns {Promise.<boolean>} Promise which resolves to true if the access token is valid,
 * otherwise false.
 */
async function validateSelectedMojangAccount(){
    const current = ConfigManager.getSelectedAccount()
    const response = await MojangRestAPI.validate(current.accessToken, ConfigManager.getClientToken())

    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        const isValid = response.data
        if(!isValid){
            const refreshResponse = await MojangRestAPI.refresh(current.accessToken, ConfigManager.getClientToken())
            if(refreshResponse.responseStatus === RestResponseStatus.SUCCESS) {
                const session = refreshResponse.data
                ConfigManager.updateMojangAuthAccount(current.uuid, session.accessToken)
                ConfigManager.save()
            } else {
                // Check for rate limit error (429)
                if(refreshResponse.mojangErrorCode === MojangErrorCode.ERROR_RATELIMIT || 
                   (refreshResponse.error && refreshResponse.error.status === 429)) {
                    log.warn('Mojang API rate limit (429) detected. Skipping token refresh to avoid additional requests.')
                    log.info('Account validation skipped due to rate limiting. Token may still be valid.')
                    // Return true to avoid blocking launch, but don't refresh token
                    return true
                }
                log.error('Error while validating selected profile:', refreshResponse.error)
                log.info('Account access token is invalid.')
                return false
            }
            log.info('Account access token validated.')
            return true
        } else {
            log.info('Account access token validated.')
            return true
        }
    } else {
        // Check for rate limit error in validate response
        if(response.mojangErrorCode === MojangErrorCode.ERROR_RATELIMIT || 
           (response.error && response.error.status === 429)) {
            log.warn('Mojang API rate limit (429) detected during validation. Skipping to avoid additional requests.')
            log.info('Account validation skipped due to rate limiting. Assuming token is still valid.')
            // Return true to avoid blocking launch
            return true
        }
    }
    
    return false
}

/**
 * Validate the selected account with Microsoft's authserver. If the account is not valid,
 * we will attempt to refresh the access token and update that value. If that fails, a
 * new login will be required.
 * 
 * @returns {Promise.<boolean>} Promise which resolves to true if the access token is valid,
 * otherwise false.
 */
async function validateSelectedMicrosoftAccount(){
    const current = ConfigManager.getSelectedAccount()
    const now = new Date().getTime()
    const mcExpiresAt = current.expiresAt
    const mcExpired = now >= mcExpiresAt

    log.info('=== Microsoft Account Validation ===')
    log.info('Account UUID:', current.uuid)
    log.info('Account Name:', current.displayName)
    log.info('MC Token (first 30 chars):', current.accessToken ? current.accessToken.substring(0, 30) + '...' : 'MISSING')
    log.info('MC Token Length:', current.accessToken ? current.accessToken.length : 0)
    log.info('MC Token Expires At:', mcExpiresAt ? new Date(mcExpiresAt).toISOString() : 'MISSING')
    log.info('MC Token Expired:', mcExpired)
    log.info('XUID:', current.microsoft?.xuid || 'MISSING')

    if(!mcExpired) {
        log.info('MC token is still valid, no refresh needed')
        return true
    }

    // MC token expired. Check MS token.

    const msExpiresAt = current.microsoft.expires_at
    const msExpired = now >= msExpiresAt

    log.info('MS Token Expires At:', msExpiresAt ? new Date(msExpiresAt).toISOString() : 'MISSING')
    log.info('MS Token Expired:', msExpired)

    if(msExpired) {
        // MS expired, do full refresh.
        log.info('Both MC and MS tokens expired, performing full refresh...')
        try {
            const res = await fullMicrosoftAuthFlow(current.microsoft.refresh_token, AUTH_MODE.MS_REFRESH)

            log.info('Full refresh successful')
            log.info('New MC Token (first 30 chars):', res.mcToken.access_token.substring(0, 30) + '...')
            log.info('New MC Token Length:', res.mcToken.access_token.length)
            log.info('New XUID:', res.xuid || 'NOT FOUND')

            ConfigManager.updateMicrosoftAuthAccount(
                current.uuid,
                res.mcToken.access_token,
                res.accessToken.access_token,
                res.accessToken.refresh_token,
                calculateExpiryDate(now, res.accessToken.expires_in),
                calculateExpiryDate(now, res.mcToken.expires_in),
                res.xuid, // Update XUID from XSTS response
                res.isRealXuid // Update flag indicating if xuid is real xid (not uhs)
            )
            ConfigManager.save()
            return true
        } catch(err) {
            log.error('Full refresh failed:', err)
            return false
        }
    } else {
        // Only MC expired, use existing MS token.
        log.info('Only MC token expired, refreshing MC token using existing MS token...')
        try {
            const res = await fullMicrosoftAuthFlow(current.microsoft.access_token, AUTH_MODE.MC_REFRESH)

            log.info('MC token refresh successful')
            log.info('New MC Token (first 30 chars):', res.mcToken.access_token.substring(0, 30) + '...')
            log.info('New MC Token Length:', res.mcToken.access_token.length)
            log.info('XUID:', res.xuid || current.microsoft.xuid || 'NOT FOUND')

            ConfigManager.updateMicrosoftAuthAccount(
                current.uuid,
                res.mcToken.access_token,
                current.microsoft.access_token,
                current.microsoft.refresh_token,
                current.microsoft.expires_at,
                calculateExpiryDate(now, res.mcToken.expires_in),
                res.xuid || current.microsoft.xuid, // Update XUID if available, otherwise keep existing
                res.isRealXuid !== undefined ? res.isRealXuid : current.microsoft.isRealXuid // Update flag if available, otherwise keep existing
            )
            ConfigManager.save()
            return true
        }
        catch(err) {
            log.error('MC token refresh failed:', err)
            return false
        }
    }
}

// Cache for validation results to avoid too frequent API calls
let validationCache = {
    lastValidation: 0,
    lastResult: null,
    cacheDuration: 5 * 60 * 1000 // 5 minutes cache
}

/**
 * Validate the selected auth account.
 * 
 * @returns {Promise.<boolean>} Promise which resolves to true if the access token is valid,
 * otherwise false.
 */
exports.validateSelected = async function(){
    const current = ConfigManager.getSelectedAccount()
    if(!current) {
        return false
    }

    // Check cache to avoid too frequent validations
    const now = Date.now()
    if(validationCache.lastValidation > 0 && 
       (now - validationCache.lastValidation) < validationCache.cacheDuration &&
       validationCache.lastResult !== null) {
        log.debug(`Using cached validation result (${Math.round((now - validationCache.lastValidation) / 1000)}s ago)`)
        return validationCache.lastResult
    }

    let result
    if(current.type === 'microsoft') {
        result = await validateSelectedMicrosoftAccount()
    } else if(current.type === 'ely') {
        result = await validateSelectedElyAccount()
    } else {
        result = await validateSelectedMojangAccount()
    }
    
    // Update cache
    validationCache.lastValidation = now
    validationCache.lastResult = result
    
    return result
}

/**
 * Add an Ely.by account. This performs authentication using 
 * credentials via the Ely.by authorization server. The resulting data 
 * will be saved as an authentication account in the configuration database.
 * 
 * @param {string} username Username (nickname or email).
 * @param {string} password User password.
 * @param {string} totpToken Optional TOTP token for two-factor authentication.
 * @returns {Promise.<Object>} Promise resolved with the authenticated account object.
 */

exports.addElyAccount = async function(username, password, totpToken = null) {
    try {
        // If TOTP token is provided, add it to password
        const passwordWithToken = totpToken ? `${password}:${totpToken}` : password
        
        const response = await ElyRestAPI.authenticate(username, passwordWithToken, ConfigManager.getClientToken())
        
        if(response.responseStatus === RestResponseStatus.SUCCESS) {
            const session = response.data
            
            if(session.selectedProfile != null) {
                const ret = ConfigManager.addElyAuthAccount(
                    session.selectedProfile.id, 
                    session.accessToken, 
                    username, 
                    session.selectedProfile.name
                )
                
                if(ConfigManager.getClientToken() == null) {
                    ConfigManager.setClientToken(session.clientToken)
                }
                
                ConfigManager.save()
                return ret
            } else {
                return Promise.reject(elyErrorDisplayable(ElyErrorCode.FORBIDDEN_OPERATION))
            }
        } else {
            // Check if two-factor authentication is required
            if(response.elyErrorCode === ElyErrorCode.TWO_FACTOR_REQUIRED) {
                return Promise.reject({
                    requiresTwoFactor: true,
                    error: elyErrorDisplayable(ElyErrorCode.TWO_FACTOR_REQUIRED)
                })
            }
            
            // For invalid credentials, return specific error
            if(response.elyErrorCode === ElyErrorCode.FORBIDDEN_OPERATION) {
                return Promise.reject(elyErrorDisplayable(ElyErrorCode.FORBIDDEN_OPERATION))
            }
            
            // For other errors, return standard error
            return Promise.reject(elyErrorDisplayable(response.elyErrorCode))
        }
        
    } catch (err) {
        log.error(err)
        return Promise.reject(elyErrorDisplayable(ElyErrorCode.UNKNOWN))
    }
}

/**
 * Remove an Ely.by account. This invalidates the access token associated
 * with the account and then removes it from the database.
 * 
 * @param {string} uuid UUID of the account to remove.
 * @returns {Promise.<void>} Promise that resolves to void when the action is completed.
 */
exports.removeElyAccount = async function(uuid) {
    try {
        const authAcc = ConfigManager.getAuthAccount(uuid)
        const response = await ElyRestAPI.invalidate(authAcc.accessToken, ConfigManager.getClientToken())
        
        if(response.responseStatus === RestResponseStatus.SUCCESS) {
            ConfigManager.removeAuthAccount(uuid)
            ConfigManager.save()
            return Promise.resolve()
        } else {
            log.error('Error while removing an account', response.error)
            return Promise.reject(response.error)
        }
    } catch (err) {
        log.error('Error while removing an account', err)
        return Promise.reject(err)
    }
}

/**
 * Validate the selected Ely.by account with the Ely.by authorization server. 
 * If the account is not valid, an attempt will be made to refresh the access token 
 * and update its value. If this fails, a new login will be required.
 * 
 * @returns {Promise.<boolean>} Promise that resolves to true if the access token is valid,
 * otherwise false.
 */
async function validateSelectedElyAccount() {
    const current = ConfigManager.getSelectedAccount()
    const response = await ElyRestAPI.validate(current.accessToken, ConfigManager.getClientToken())

    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        const isValid = response.data
        if(!isValid) {
            const refreshResponse = await ElyRestAPI.refresh(current.accessToken, ConfigManager.getClientToken())
            if(refreshResponse.responseStatus === RestResponseStatus.SUCCESS) {
                const session = refreshResponse.data
                ConfigManager.updateElyAuthAccount(current.uuid, session.accessToken)
                ConfigManager.save()
            } else {
                log.error('Error validating selected profile:', refreshResponse.error)
                log.info('The account access token is invalid')
                return false
            }
            log.info('The account access token has been validated')
            return true
        } else {
            log.info('Account access token validated')
            return true
        }
    }
    
    return false
}
