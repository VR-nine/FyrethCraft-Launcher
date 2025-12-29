/**
 * ElyAuth
 * 
 * Module for authentication via ely.by service.
 * Implements authentication protocol compatible with Mojang API.
 * 
 * @module elyauth
 */
// Requirements
const { LoggerUtil } = require('helios-core')
const { RestResponseStatus } = require('helios-core/common')
const { ELY_CONFIG } = require('./ipcconstants')
const Lang = require('./langloader')

const log = LoggerUtil.getLogger('ElyAuth')

/**
 * Error codes for ely.by
 */
const ElyErrorCode = {
    ILLEGAL_ARGUMENT: 'IllegalArgumentException',
    FORBIDDEN_OPERATION: 'ForbiddenOperationException',
    TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED', // Special case for 2FA
    UNKNOWN: 'Unknown'
}

/**
 * Class for working with ely.by REST API
 */
class ElyRestAPI {
    /**
     * User authentication via ely.by
     * 
     * @param {string} username User nickname or email
     * @param {string} password User password or password:token for 2FA
     * @param {string} clientToken Unique launcher token
     * @param {boolean} requestUser If true, includes user information in response
     * @returns {Promise<Object>} Authentication result
     */
    static async authenticate(username, password, clientToken, requestUser = true) {
        try {
            const requestBody = {
                username: username.trim(),
                password: password,
                clientToken: clientToken,
                requestUser: requestUser
            }

            log.info('Sending authentication request to ely.by...')
            
            const response = await fetch(`${ELY_CONFIG.AUTH_SERVER_URL}/auth/authenticate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            })

            let data
            try {
                const contentType = response.headers.get('content-type')
                if (contentType && contentType.includes('application/json')) {
                    data = await response.json()
                } else {
                    // Если ответ не JSON, создаём объект ошибки из текста ответа
                    const text = await response.text()
                    throw new Error(`Non-JSON response: ${text.substring(0, 100)}`)
                }
            } catch (parseError) {
                // Если не удалось распарсить JSON, возвращаем ошибку
                log.error('Failed to parse response as JSON:', parseError)
                return {
                    responseStatus: RestResponseStatus.ERROR,
                    elyErrorCode: ElyErrorCode.UNKNOWN,
                    error: {
                        error: 'ParseError',
                        errorMessage: `Failed to parse server response: ${parseError.message}`
                    }
                }
            }

            if (response.ok) {
                log.info('Authentication successful')
                return {
                    responseStatus: RestResponseStatus.SUCCESS,
                    data: data
                }
            } else {
                log.error('Authentication error:', data)
                
                // Handle special 2FA case - check for specific error message
                if (response.status === 401 && 
                    data.error === ElyErrorCode.FORBIDDEN_OPERATION && 
                    data.errorMessage && 
                    data.errorMessage === 'Account protected with two factor auth.') {
                    return {
                        responseStatus: RestResponseStatus.ERROR,
                        elyErrorCode: ElyErrorCode.TWO_FACTOR_REQUIRED,
                        error: data
                    }
                }
                
                // Handle invalid credentials case
                if (response.status === 401 && 
                    data.error === ElyErrorCode.FORBIDDEN_OPERATION && 
                    data.errorMessage && 
                    (data.errorMessage === 'Invalid credentials. Invalid username or password.' ||
                     data.errorMessage === 'Invalid credentials. Invalid email or password.')) {
                    return {
                        responseStatus: RestResponseStatus.ERROR,
                        elyErrorCode: ElyErrorCode.FORBIDDEN_OPERATION,
                        error: data
                    }
                }

                return {
                    responseStatus: RestResponseStatus.ERROR,
                    elyErrorCode: data.error || ElyErrorCode.UNKNOWN,
                    error: data
                }
            }
        } catch (error) {
            log.error('An error occurred while executing the authentication request:', error)
            return {
                responseStatus: RestResponseStatus.ERROR,
                elyErrorCode: ElyErrorCode.UNKNOWN,
                error: error
            }
        }
    }

    /**
     * Access token validation
     * 
     * @param {string} accessToken Access token
     * @param {string} clientToken Client token
     * @returns {Promise<Object>} Validation result
     */
    static async validate(accessToken, clientToken) {
        try {
            const requestBody = {
                accessToken: accessToken,
                clientToken: clientToken
            }

            log.info('Validate the token via ely.by...')
            
            const response = await fetch(`${ELY_CONFIG.AUTH_SERVER_URL}/auth/validate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            })

            if (response.ok) {
                log.info('The token is valid')
                return {
                    responseStatus: RestResponseStatus.SUCCESS,
                    data: true
                }
            } else {
                log.warn('Token is invalid')
                return {
                    responseStatus: RestResponseStatus.SUCCESS,
                    data: false
                }
            }
        } catch (error) {
            log.error('Error validating token:', error)
            return {
                responseStatus: RestResponseStatus.ERROR,
                elyErrorCode: ElyErrorCode.UNKNOWN,
                error: error
            }
        }
    }

    /**
     * Access token refresh
     * 
     * @param {string} accessToken Current access token
     * @param {string} clientToken Client token
     * @returns {Promise<Object>} Refresh result
     */
    static async refresh(accessToken, clientToken) {
        try {
            const requestBody = {
                accessToken: accessToken,
                clientToken: clientToken
            }

            log.info('Token update via ely.by...')
            
            const response = await fetch(`${ELY_CONFIG.AUTH_SERVER_URL}/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            })

            let data
            try {
                const contentType = response.headers.get('content-type')
                if (contentType && contentType.includes('application/json')) {
                    data = await response.json()
                } else {
                    // Если ответ не JSON, создаём объект ошибки из текста ответа
                    const text = await response.text()
                    throw new Error(`Non-JSON response: ${text.substring(0, 100)}`)
                }
            } catch (parseError) {
                // Если не удалось распарсить JSON, возвращаем ошибку
                log.error('Failed to parse response as JSON:', parseError)
                return {
                    responseStatus: RestResponseStatus.ERROR,
                    elyErrorCode: ElyErrorCode.UNKNOWN,
                    error: {
                        error: 'ParseError',
                        errorMessage: `Failed to parse server response: ${parseError.message}`
                    }
                }
            }

            if (response.ok) {
                log.info('Token successfully updated')
                return {
                    responseStatus: RestResponseStatus.SUCCESS,
                    data: data
                }
            } else {
                log.error('Token update error:', data)
                return {
                    responseStatus: RestResponseStatus.ERROR,
                    elyErrorCode: data.error || ElyErrorCode.UNKNOWN,
                    error: data
                }
            }
        } catch (error) {
            log.error('Error updating token:', error)
            return {
                responseStatus: RestResponseStatus.ERROR,
                elyErrorCode: ElyErrorCode.UNKNOWN,
                error: error
            }
        }
    }

    /**
     * Access token invalidation
     * 
     * @param {string} accessToken Access token
     * @param {string} clientToken Client token
     * @returns {Promise<Object>} Invalidation result
     */
    static async invalidate(accessToken, clientToken) {
        try {
            const requestBody = {
                accessToken: accessToken,
                clientToken: clientToken
            }

            log.info('Via the invalidation token ely.by...')
            
            const response = await fetch(`${ELY_CONFIG.AUTH_SERVER_URL}/auth/invalidate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            })

            if (response.ok) {
                log.info('Token successfully invalidated')
                return {
                    responseStatus: RestResponseStatus.SUCCESS,
                    data: true
                }
            } else {
                log.error('Token invalidation error')
                return {
                    responseStatus: RestResponseStatus.ERROR,
                    elyErrorCode: ElyErrorCode.UNKNOWN,
                    error: 'Failed to invalidate token'
                }
            }
        } catch (error) {
            log.error('Error invalidating token:', error)
            return {
                responseStatus: RestResponseStatus.ERROR,
                elyErrorCode: ElyErrorCode.UNKNOWN,
                error: error
            }
        }
    }
}

/**
 * Convert ely.by errors to displayable messages
 * 
 * @param {string} errorCode Error code
 * @returns {Object} Object with error title and description
 */
function elyErrorDisplayable(errorCode) {
    switch (errorCode) {
        case ElyErrorCode.ILLEGAL_ARGUMENT:
            return {
                title: Lang.queryJS('auth.ely.error.illegalArgumentTitle'),
                desc: Lang.queryJS('auth.ely.error.illegalArgumentDesc')
            }
        case ElyErrorCode.FORBIDDEN_OPERATION:
            return {
                title: Lang.queryJS('auth.ely.error.forbiddenOperationTitle'),
                desc: Lang.queryJS('auth.ely.error.forbiddenOperationDesc')
            }
        case ElyErrorCode.TWO_FACTOR_REQUIRED:
            return {
                title: Lang.queryJS('auth.ely.error.twoFactorRequiredTitle'),
                desc: Lang.queryJS('auth.ely.error.twoFactorRequiredDesc')
            }
        case ElyErrorCode.UNKNOWN:
        default:
            return {
                title: Lang.queryJS('auth.ely.error.unknownTitle'),
                desc: Lang.queryJS('auth.ely.error.unknownDesc')
            }
    }
}

// Export API and utilities
module.exports = {
    ElyRestAPI,
    ElyErrorCode,
    elyErrorDisplayable
}
