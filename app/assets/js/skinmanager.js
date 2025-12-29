/**
 * SkinManager
 * 
 * Module for managing player skins from different sources.
 * Supports Mojang, Microsoft, and Ely.by skins.
 * 
 * @module skinmanager
 */

/**
 * Retry mechanism for skin fetching operations
 * 
 * @param {Function} operation Function to retry
 * @param {number} maxRetries Maximum number of retry attempts
 * @param {number} delay Delay between retries in milliseconds
 * @returns {Promise<any>} Result of the operation
 */
async function retryOperation(operation, maxRetries = 3, delay = 15000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await operation();
            return result;
        } catch (error) {
            lastError = error;
            
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    console.error(`SkinManager: All ${maxRetries} attempts failed`);
    throw lastError;
}

/**
 * Get the skin URL for an account
 * 
 * @param {Object} account Account object
 * @param {string} type Skin type ('head', 'body', 'avatar')
 * @param {number} size Image size
 * @returns {Promise<string>} Skin URL
 */

async function getSkinUrl(account, type = 'head', size = 40) {
    if (!account || !account.uuid) {
        return getDefaultSkinUrl(type, size)
    }

    switch (account.type) {
        case 'ely':
            // For Ely.by use username instead of UUID
            if (account.username) {
                const elyUrl = await getElySkinUrlByNickname(account.username, type, size)
                return elyUrl
            } else {
                // Fallback to default skin if username is not available
                return getDefaultSkinUrl(type, size)
            }
        case 'microsoft':
        case 'mojang':
        default:
            const mojangUrl = getMojangSkinUrl(account.uuid, type, size)
            return mojangUrl
    }
}

/**
 * Get skin URL from Mojang/mc-heads
 * 
 * @param {string} uuid Player UUID
 * @param {string} type Skin type
 * @param {number} size Size
 * @returns {string} Skin URL
 */
function getMojangSkinUrl(uuid, type, size) {
    const baseUrl = 'https://mc-heads.net'
    
    switch (type) {
        case 'head':
            return `${baseUrl}/head/${uuid}/${size}`
        case 'body':
            return `${baseUrl}/body/${uuid}/${size}`
        case 'avatar':
            return `${baseUrl}/body/${uuid}/right`
        default:
            return `${baseUrl}/head/${uuid}/${size}`
    }
}

/**
 * Get texture information from Ely.by API
 * 
 * @param {string} username Player nickname
 * @returns {Promise<Object>} Texture information
 */
async function getElyTexturesInfo(username) {
    return await retryOperation(async () => {
        // Use simple endpoint skinsystem.ely.by
        // Note: skinsystem.ely.by doesn't support HTTPS, must use HTTP
        const response = await fetch(`http://skinsystem.ely.by/profile/${username}`)
        
        if (!response.ok) {
            throw new Error(`Failed to get Ely.by textures info: ${response.status}`)
        }
        
        const data = await response.json()
        
        // Look for textures property in properties
        if (data.properties && Array.isArray(data.properties)) {
            const texturesProperty = data.properties.find(prop => prop.name === "textures")
            if (texturesProperty) {
                try {
                    // Decode base64 value
                    const decodedValue = JSON.parse(atob(texturesProperty.value))
                    return decodedValue
                } catch (decodeError) {
                    throw new Error(`Error decoding textures property: ${decodeError.message}`)
                }
            } else {
                throw new Error('No textures property found in profile')
            }
        } else {
            throw new Error('No properties found in profile')
        }
    }).catch(error => {
        console.error('SkinManager: Error getting Ely.by textures info after retries:', error)
        return null
    })
}

/**
 * Get skin URL from Ely.by by nickname
 * 
 * @param {string} nickname Player nickname
 * @param {string} type Skin type
 * @param {number} size Size
 * @returns {Promise<string>} Skin URL
 */
async function getElySkinUrlByNickname(nickname, type, size) {
    
    return await retryOperation(async () => {
        // Get textures info directly by nickname
        const texturesInfo = await getElyTexturesInfo(nickname)
        
        if (!texturesInfo || !texturesInfo.textures || !texturesInfo.textures.SKIN) {
            throw new Error(`No skin info found for nickname: ${nickname}`)
        }
        
        // Extract skin URL
        const skinUrl = texturesInfo.textures.SKIN.url
        
        // Return original skin URL directly
        return skinUrl
    }).catch(error => {
        console.error('SkinManager: Error getting Ely.by skin by nickname after retries:', error)
        return getDefaultSkinUrl(type, size)
    })
}


/**
 * Get skin URL from Ely.by by skin hash
 * 
 * @param {string} skinHash Skin hash
 * @param {string} type Skin type
 * @param {number} size Size
 * @returns {string} Skin URL
 */
function getElySkinUrlByHash(skinHash, type, size) {
    // Ely.by uses format: https://ely.by/storage/skins/{hash}.png
    const baseUrl = 'https://ely.by/storage/skins'
    
    switch (type) {
        case 'head':
            return `${baseUrl}/${skinHash}.png`
        case 'body':
            return `${baseUrl}/${skinHash}.png`
        case 'avatar':
            return `${baseUrl}/${skinHash}.png`
        default:
            return `${baseUrl}/${skinHash}.png`
    }
}

/**
 * Check Ely.by API availability
 * 
 * @returns {Promise<boolean>} Whether Ely.by API is available
 */
async function checkElyByAvailability() {
    try {
        const response = await fetch('https://ely.by/storage/skins/test.png', { 
            method: 'HEAD',
            timeout: 5000 // 5 seconds timeout
        })
        return response.ok || response.status === 404 // 404 is also normal for test request
    } catch (error) {
        return false
    }
}

/**
 * Create URL for displaying only head from skin texture
 * 
 * @param {string} skinUrl Full skin texture URL
 * @param {number} size Head size
 * @returns {string} URL for head display
 */
function createHeadUrl(skinUrl, size = 40) {
    // For Ely.by and other sources that return full texture,
    // we can use CSS to crop the head
    // Head in Minecraft texture is located at coordinates 8,8 with size 8x8 pixels
    // from 64x64 pixel texture
    
    // Calculate the correct background size and position
    // The head is 8x8 pixels in a 64x64 texture, so we need to scale accordingly
    const backgroundSize = size * 8; // 8x scale for the head portion
    const backgroundPosition = -size; // Negative offset to show the head portion
    
    // Create CSS style for head cropping
    const headStyle = `
        background-image: url('${skinUrl}');
        background-size: ${backgroundSize}px ${backgroundSize}px;
        background-position: ${backgroundPosition}px ${backgroundPosition}px;
        width: ${size}px;
        height: ${size}px;
        image-rendering: pixelated;
        background-repeat: no-repeat;
    `
    
    return headStyle
}

/**
 * Update element with cropped player head
 * 
 * @param {HTMLElement} element Element to update
 * @param {Object} account Account object
 * @param {number} size Head size
 */
function updateHeadInElement(element, account, size = 40) {
    if (!element) {
        return
    }
    
    // Helper function to apply styles to element
    const applyStyles = (url, isMicrosoft = false, useCropping = false) => {
        if (isMicrosoft) {
            // Microsoft returns ready-to-use avatar, no cropping needed
            element.style.backgroundImage = `url('${url}')`
            element.style.backgroundSize = 'cover'
            element.style.backgroundPosition = 'center'
            element.style.width = `${size}px`
            element.style.height = `${size}px`
            element.style.imageRendering = 'pixelated'
            element.style.backgroundRepeat = 'no-repeat'
            element.style.transform = 'scaleX(-1)'
        } else if (useCropping) {
            // Ely.by and others return full skin texture, need cropping
            const backgroundSize = size * 8
            const backgroundPosition = -size
            
            element.style.backgroundImage = `url('${url}')`
            element.style.backgroundSize = `${backgroundSize}px ${backgroundSize}px`
            element.style.backgroundPosition = `${backgroundPosition}px ${backgroundPosition}px`
            element.style.width = `${size}px`
            element.style.height = `${size}px`
            element.style.imageRendering = 'pixelated'
            element.style.backgroundRepeat = 'no-repeat'
        } else {
            // Default style
            element.style.backgroundImage = `url('${url}')`
            element.style.backgroundSize = 'cover'
            element.style.backgroundPosition = 'center'
            element.style.width = `${size}px`
            element.style.height = `${size}px`
            element.style.imageRendering = 'pixelated'
            element.style.backgroundRepeat = 'no-repeat'
        }
    }
    
    // Helper function to check if image loads successfully
    const checkImageLoad = (url) => {
        return new Promise((resolve, reject) => {
            const img = new Image()
            img.onload = () => resolve(true)
            img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
            img.src = url
        })
    }
    
    // Use retry mechanism for getting skin URL
    retryOperation(async () => {
        const skinUrl = await getSkinUrl(account, 'head', size)
        
        // Check if image loads before applying
        try {
            await checkImageLoad(skinUrl)
            // Image loaded successfully, apply styles
            applyStyles(skinUrl, account.type === 'microsoft', account.type !== 'microsoft')
        } catch (loadError) {
            console.warn('SkinManager: Primary skin URL failed to load, using default skin:', loadError)
            throw loadError
        }
        
        return skinUrl
    }).catch(error => {
        console.error('SkinManager: Error getting skin URL after retries:', error)
        // In case of error use default skin
        const defaultUrl = getDefaultSkinUrl('head', size)
        applyStyles(defaultUrl, account.type === 'microsoft', false)
    })
}

/**
 * Get skin URL from Ely.by
 * 
 * @param {string} uuid Player UUID
 * @param {string} type Skin type
 * @param {number} size Size
 * @returns {string} Skin URL
 */
function getElySkinUrl(uuid, type, size) {
    // Ely.by uses skin system on skinsystem.ely.by
    // URL format: https://skinsystem.ely.by/skins/{nickname}.png
    // But we need nickname, not UUID
    
    // To get skin by UUID we need to get nickname first
    // For now use fallback to mc-heads.net
    
    switch (type) {
        case 'head':
            return `https://mc-heads.net/head/${uuid}/${size}`
        case 'body':
            return `https://mc-heads.net/body/${uuid}/${size}`
        case 'avatar':
            return `https://mc-heads.net/body/${uuid}/right`
        default:
            return `https://mc-heads.net/head/${uuid}/${size}`
    }
}

/**
 * Get default skin URL
 * 
 * @param {string} type Skin type
 * @param {number} size Size
 * @returns {string} Default skin URL
 */
function getDefaultSkinUrl(type, size) {
    // Return default Steve skin
    const steveUuid = 'c06f89064c8a49119c29ea1dbd1aab82' // Steve's UUID
    return getMojangSkinUrl(steveUuid, type, size)
}

/**
 * Update skin in element
 * 
 * @param {HTMLElement} element Element to update
 * @param {Object} account Account object
 * @param {string} type Skin type
 * @param {number} size Size
 */
function updateSkinInElement(element, account, type = 'head', size = 40) {
    if (!element) {
        return
    }
    
    // Use retry mechanism for getting skin URL
    retryOperation(async () => {
        const skinUrl = await getSkinUrl(account, type, size)
        
        if (element.tagName === 'IMG') {
            element.src = skinUrl
            element.alt = account.displayName || 'Player'
            
            // Add error handler for fallback to default skin
            element.onerror = () => {
                element.src = getDefaultSkinUrl(type, size)
            }
        } else {
            // Set background image
            element.style.backgroundImage = `url('${skinUrl}')`
        }
        
        return skinUrl
    }).catch(error => {
        console.error('SkinManager: Error getting skin URL after retries:', error)
        // In case of error use default skin
        const defaultUrl = getDefaultSkinUrl(type, size)
        if (element.tagName === 'IMG') {
            element.src = defaultUrl
        } else {
            element.style.backgroundImage = `url('${defaultUrl}')`
        }
    })
}

/**
 * Check if skin is available
 * 
 * @param {string} url Skin URL
 * @returns {Promise<boolean>} Whether skin is available
 */
async function checkSkinAvailability(url) {
    try {
        const response = await fetch(url, { method: 'HEAD' })
        return response.ok
    } catch (error) {
        return false
    }
}

// Export functions
module.exports = {
    getSkinUrl,
    getMojangSkinUrl,
    getElySkinUrlByNickname,
    getElySkinUrlByHash,
    getElyTexturesInfo,
    getDefaultSkinUrl,
    updateSkinInElement,
    updateHeadInElement,
    createHeadUrl,
    checkSkinAvailability,
    checkElyByAvailability,
    retryOperation
}
