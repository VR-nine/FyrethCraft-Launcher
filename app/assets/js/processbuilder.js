const AdmZip                = require('adm-zip')
const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const { LoggerUtil }        = require('helios-core')
const { getMojangOS, isLibraryCompatible, mcVersionAtLeast }  = require('helios-core/common')
const { Type }              = require('helios-distribution-types')
const os                    = require('os')
const path                  = require('path')

const ConfigManager            = require('./configmanager')

const logger = LoggerUtil.getLogger('ProcessBuilder')

/**
 * Format UUID to ensure it has dashes (required for Microsoft accounts)
 * @param {string} uuid - UUID string
 * @returns {string} Formatted UUID with dashes
 */
function formatUUID(uuid) {
    if (!uuid) return uuid
    // Remove any existing dashes
    const clean = uuid.replace(/-/g, '')
    // Add dashes in the correct positions: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    if (clean.length === 32) {
        return `${clean.substring(0, 8)}-${clean.substring(8, 12)}-${clean.substring(12, 16)}-${clean.substring(16, 20)}-${clean.substring(20, 32)}`
    }
    return uuid
}

/**
 * Get the actual system architecture, not the process architecture.
 * On macOS, process.arch might be x64 if Electron runs under Rosetta,
 * but we need the actual system architecture (arm64 for Apple Silicon).
 * 
 * @returns {string} System architecture (arm64, x64, etc.)
 */
function getSystemArchitecture() {
    // On macOS, we need to detect the actual system architecture, not the process architecture
    // When Electron runs under Rosetta, both uname -m and os.arch() can return x64/x86_64
    if (process.platform === 'darwin') {
        try {
            // Method 1: Check if running under Rosetta translation
            // sysctl.proc_translated returns 1 if running under Rosetta (on Apple Silicon), 0 if native
            const procTranslated = child_process.execSync('sysctl -n sysctl.proc_translated', { encoding: 'utf8', timeout: 1000 }).trim()
            
            if (procTranslated === '1') {
                // Running under Rosetta means we're on Apple Silicon (arm64)
                logger.debug(`[ProcessBuilder]: macOS architecture check: Running under Rosetta (proc_translated=1), system is arm64`)
                return 'arm64'
            }
            
            // Method 2: Use 'arch' command which returns the actual system architecture
            // This works even when the current process is running under Rosetta
            try {
                const archResult = child_process.execSync('arch', { encoding: 'utf8', timeout: 1000 }).trim()
                logger.debug(`[ProcessBuilder]: macOS architecture check: arch=${archResult}, proc_translated=${procTranslated}, uname -m=${child_process.execSync('uname -m', { encoding: 'utf8', timeout: 1000 }).trim()}, os.arch()=${os.arch()}, process.arch=${process.arch}`)
                
                if (archResult === 'arm64') {
                    return 'arm64'
                } else if (archResult === 'i386' || archResult === 'x86_64') {
                    return 'x64'
                }
            } catch (archErr) {
                // If arch fails, fall through to uname
            }
            
            // Method 3: Fallback to uname -m (may return x86_64 under Rosetta)
            const unameResult = child_process.execSync('uname -m', { encoding: 'utf8', timeout: 1000 }).trim()
            logger.debug(`[ProcessBuilder]: macOS architecture check (uname fallback): uname -m=${unameResult}, os.arch()=${os.arch()}, process.arch=${process.arch}`)
            
            if (unameResult === 'arm64') {
                return 'arm64'
            } else if (unameResult === 'x86_64') {
                // If uname returns x86_64 but proc_translated was 0, it's a real Intel Mac
                return 'x64'
            }
        } catch (err) {
            // If all checks fail, log and fall back to os.arch()
            logger.warn(`[ProcessBuilder]: Could not check macOS architecture: ${err.message}, falling back to os.arch()=${os.arch()}`)
        }
    }
    
    // For other platforms, use os.arch() as fallback
    // os.arch() should be reliable on Linux and Windows
    const systemArch = os.arch()
    logger.debug(`[ProcessBuilder]: Using os.arch()=${systemArch} for platform ${process.platform}`)
    return systemArch
}

/**
 * Normalize architecture string for Mojang manifest format.
 * 
 * Mojang uses different architecture names than Node.js:
 * - Node.js: 'arm64' -> Mojang: 'aarch64' (macOS/Linux ARM)
 * - Node.js: 'x64' -> Mojang: 'x64' (Windows) or 'x86_64' (macOS/Linux)
 * 
 * @param {string} arch - Architecture from process.arch or getSystemArchitecture()
 * @param {string} platform - Platform from process.platform
 * @param {boolean} forMojangManifest - If true, return Mojang format; if false, return normalized for comparison
 * @returns {string} Normalized architecture string
 */
function normalizeArchitecture(arch, platform = process.platform, forMojangManifest = true) {
    // Normalize Node.js arch to standard format
    let normalized = arch
    
    // Convert to Mojang manifest format if needed
    if (forMojangManifest) {
        if (platform === 'darwin' || platform === 'linux') {
            // macOS and Linux use different naming
            if (arch === 'arm64') {
                return 'aarch64' // Mojang uses aarch64 for ARM
            } else if (arch === 'x64') {
                return 'x86_64' // Mojang uses x86_64 for Intel/AMD
            }
        } else if (platform === 'win32') {
            // Windows uses x64 for both Node.js and Mojang
            if (arch === 'x64') {
                return 'x64'
            }
        }
    } else {
        // For comparison: normalize both Node.js and Mojang formats to same value
        // Handle all possible formats: arm64, aarch64, x64, x86_64
        if (arch === 'aarch64') {
            return 'arm64' // Convert Mojang format to Node.js format
        } else if (arch === 'arm64') {
            return 'arm64' // Already in Node.js format
        } else if (arch === 'x86_64') {
            // Mojang format for macOS/Linux x64
            return 'x64' // Convert to Node.js format for comparison (works for all platforms)
        } else if (arch === 'x64') {
            // Could be Node.js format (Windows) or Mojang format (macOS/Linux)
            // For comparison, we treat all x64 as the same
            return 'x64'
        }
    }
    
    return normalized
}

/**
 * Compare two architecture strings, handling Mojang vs Node.js format differences.
 * 
 * @param {string} arch1 - First architecture (typically from manifest)
 * @param {string} arch2 - Second architecture (typically from process.arch)
 * @param {string} platform - Platform from process.platform
 * @returns {boolean} True if architectures match
 */
function compareArchitecture(arch1, arch2, platform = process.platform) {
    // Normalize both to same format for comparison
    const norm1 = normalizeArchitecture(arch1, platform, false)
    const norm2 = normalizeArchitecture(arch2, platform, false)
    return norm1 === norm2
}

/**
 * Get the correct path to a resource file, handling both dev and production environments
 * @param {string} resourcePath - Path to the resource relative to app root
 * @returns {string} Full path to the resource
 */
function getResourcePath(resourcePath) {
    // In renderer process, we need to use remote to access app
    const { app } = require('@electron/remote')
    const appPath = app.getAppPath()

    // Try different possible locations
    const possiblePaths = [
        path.join(appPath, resourcePath), // Dev mode (root/resourcePath)
        path.join(appPath, 'resources', resourcePath), // Production mode
        path.join(process.resourcesPath, resourcePath) // Alternative production path
    ]

    for(const testPath of possiblePaths) {
        if(fs.existsSync(testPath)) {
            return testPath
        }
    }

    return null
}


/**
 * Only forge and fabric are top level mod loaders.
 *
 * Forge 1.13+ launch logic is similar to fabrics, for now using usingFabricLoader flag to
 * change minor details when needed.
 *
 * Rewrite of this module may be needed in the future.
 */
class ProcessBuilder {

    constructor(distroServer, vanillaManifest, modManifest, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.rawServer.id)
        this.commonDir = ConfigManager.getCommonDirectory()
        this.server = distroServer
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'forgeMods.list') // 1.13+
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.llDir = path.join(this.gameDir, 'liteloaderModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.usingFabricLoader = false
        this.llPath = null
    }

    /**
     * Convienence method to run the functions typically used to build a process.
     */
    async build(){
        fs.ensureDirSync(this.gameDir)
        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true
        this.setupLiteLoader()
        logger.info('Using liteloader:', this.usingLiteLoader)
        this.usingFabricLoader = this.server.modules.some(mdl => mdl.rawModule.type === Type.Fabric)
        logger.info('Using fabric loader:', this.usingFabricLoader)
        const modObj = this.resolveModConfiguration(ConfigManager.getModConfiguration(this.server.rawServer.id).mods, this.server.modules)

        // Mod list below 1.13
        // Fabric only supports 1.14+
        if(!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            this.constructJSONModList('forge', modObj.fMods, true)
            if(this.usingLiteLoader){
                this.constructJSONModList('liteloader', modObj.lMods, true)
            }
        }

        const uberModArr = modObj.fMods.concat(modObj.lMods)

        // Fyreth: Fetch join_token before building arguments
        const joinToken = await this._fetchJoinToken()

        let args = await this.constructJVMArguments(uberModArr, tempNativePath, joinToken)

        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            //args = args.concat(this.constructModArguments(modObj.fMods))
            args = args.concat(this.constructModList(modObj.fMods))
        }

        // Hide access token
        const loggableArgs = [...args]
        const accessTokenIndex = loggableArgs.findIndex(x => x === this.authUser.accessToken)
        if (accessTokenIndex > -1) {
            loggableArgs[accessTokenIndex] = '**********'
        }

        // Hide join token
        const joinTokenArgPrefix = '-Dfyreth.join_token='
        const joinTokenIndex = loggableArgs.findIndex(x => x.startsWith(joinTokenArgPrefix))
        if (joinTokenIndex > -1) {
            loggableArgs[joinTokenIndex] = joinTokenArgPrefix + '**********'
        }

        logger.info('Launch Arguments:', loggableArgs)


        const child = child_process.spawn(ConfigManager.getJavaExecutable(this.server.rawServer.id), args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if(ConfigManager.getLaunchDetached()){
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
            data.trim().split('\n').forEach(x => {
                console.log(`\x1b[32m[Minecraft]\x1b[0m ${x}`)
                // Check for Mojang API rate limiting errors
                if (x.includes('Status: 429') || x.includes('Too Many Requests') || x.includes('request is blocked')) {
                    logger.warn('[ProcessBuilder]: Mojang API rate limit detected (429). Skin loading may fail. Wait a few minutes and try again.')
                }
                // Check for skin/profile loading errors
                if (x.includes("Couldn't look up profile properties") || x.includes("Failed to fetch user properties") || x.includes("Failed to request yggdrasil public key")) {
                    logger.warn('[ProcessBuilder]: Skin/profile loading error detected. This may be due to Mojang API rate limiting (429).')
                }
            })
        })
        child.stderr.on('data', (data) => {
            data.trim().split('\n').forEach(x => {
                console.log(`\x1b[31m[Minecraft]\x1b[0m ${x}`)
                // Check for Mojang API rate limiting errors in stderr
                if (x.includes('Status: 429') || x.includes('Too Many Requests') || x.includes('request is blocked')) {
                    logger.warn('[ProcessBuilder]: Mojang API rate limit detected (429). Skin loading may fail. Wait a few minutes and try again.')
                }
            })
        })
        child.on('close', (code, signal) => {
            logger.info('Exited with code', code)
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.info('Temp dir deleted successfully.')
                }
            })
        })

        return child
    }

    /**
     * Get the platform specific classpath separator. On windows, this is a semicolon.
     * On Unix, this is a colon.
     *
     * @returns {string} The classpath separator for the current operating system.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }

    /**
     * Determine if an optional mod is enabled from its configuration value. If the
     * configuration value is null, the required object will be used to
     * determine if it is enabled.
     *
     * A mod is enabled if:
     *   * The configuration is not null and one of the following:
     *     * The configuration is a boolean and true.
     *     * The configuration is an object and its 'value' property is true.
     *   * The configuration is null and one of the following:
     *     * The required object is null.
     *     * The required object's 'def' property is null or true.
     *
     * @param {Object | boolean} modCfg The mod configuration object.
     * @param {Object} required Optional. The required object from the mod's distro declaration.
     * @returns {boolean} True if the mod is enabled, false otherwise.
     */
    static isModEnabled(modCfg, required = null){
        return modCfg != null ? ((typeof modCfg === 'boolean' && modCfg) || (typeof modCfg === 'object' && (typeof modCfg.value !== 'undefined' ? modCfg.value : true))) : required != null ? required.def : true
    }

    /**
     * Function which performs a preliminary scan of the top level
     * mods. If liteloader is present here, we setup the special liteloader
     * launch options. Note that liteloader is only allowed as a top level
     * mod. It must not be declared as a submodule.
     */
    setupLiteLoader(){
        for(let ll of this.server.modules){
            if(ll.rawModule.type === Type.LiteLoader){
                if(!ll.getRequired().value){
                    const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                    if(ProcessBuilder.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], ll.getRequired())){
                        if(fs.existsSync(ll.getPath())){
                            this.usingLiteLoader = true
                            this.llPath = ll.getPath()
                        }
                    }
                } else {
                    if(fs.existsSync(ll.getPath())){
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
    }

    /**
     * Resolve an array of all enabled mods. These mods will be constructed into
     * a mod list format and enabled at launch.
     *
     * @param {Object} modCfg The mod configuration object.
     * @param {Array.<Object>} mdls An array of modules to parse.
     * @returns {{fMods: Array.<Object>, lMods: Array.<Object>}} An object which contains
     * a list of enabled forge mods and litemods.
     */
    resolveModConfiguration(modCfg, mdls){
        let fMods = []
        let lMods = []

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                const o = !mdl.getRequired().value
                const e = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                if(!o || (o && e)){
                    if(mdl.subModules.length > 0){
                        const v = this.resolveModConfiguration(modCfg[mdl.getVersionlessMavenIdentifier()].mods, mdl.subModules)
                        fMods = fMods.concat(v.fMods)
                        lMods = lMods.concat(v.lMods)
                        if(type === Type.LiteLoader){
                            continue
                        }
                    }
                    if(type === Type.ForgeMod || type === Type.FabricMod){
                        fMods.push(mdl)
                    } else {
                        lMods.push(mdl)
                    }
                }
            }
        }

        return {
            fMods,
            lMods
        }
    }

    _lteMinorVersion(version) {
        return Number(this.modManifest.id.split('-')[0].split('.')[1]) <= Number(version)
    }

    /**
     * Test to see if this version of forge requires the absolute: prefix
     * on the modListFile repository field.
     */
    _requiresAbsolute(){
        try {
            if(this._lteMinorVersion(9)) {
                return false
            }
            const ver = this.modManifest.id.split('-')[2]
            const pts = ver.split('.')
            const min = [14, 23, 3, 2655]
            for(let i=0; i<pts.length; i++){
                const parsed = Number.parseInt(pts[i])
                if(parsed < min[i]){
                    return false
                } else if(parsed > min[i]){
                    return true
                }
            }
        } catch (err) {
            // We know old forge versions follow this format.
            // Error must be caused by newer version.
        }

        // Equal or errored
        return true
    }

    /**
     * Construct a mod list json object.
     *
     * @param {'forge' | 'liteloader'} type The mod list type to construct.
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     * @param {boolean} save Optional. Whether or not we should save the mod list file.
     */
    constructJSONModList(type, mods, save = false){
        const modList = {
            repositoryRoot: ((type === 'forge' && this._requiresAbsolute()) ? 'absolute:' : '') + path.join(this.commonDir, 'modstore')
        }

        const ids = []
        if(type === 'forge'){
            for(let mod of mods){
                ids.push(mod.getExtensionlessMavenIdentifier())
            }
        } else {
            for(let mod of mods){
                ids.push(mod.getMavenIdentifier())
            }
        }
        modList.modRef = ids

        if(save){
            const json = JSON.stringify(modList, null, 4)
            fs.writeFileSync(type === 'forge' ? this.fmlDir : this.llDir, json, 'UTF-8')
        }

        return modList
    }

    // /**
    //  * Construct the mod argument list for forge 1.13
    //  *
    //  * @param {Array.<Object>} mods An array of mods to add to the mod list.
    //  */
    // constructModArguments(mods){
    //     const argStr = mods.map(mod => {
    //         return mod.getExtensionlessMavenIdentifier()
    //     }).join(',')

    //     if(argStr){
    //         return [
    //             '--fml.mavenRoots',
    //             path.join('..', '..', 'common', 'modstore'),
    //             '--fml.mods',
    //             argStr
    //         ]
    //     } else {
    //         return []
    //     }

    // }

    /**
     * Construct the mod argument list for forge 1.13 and Fabric
     *
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     */
    constructModList(mods) {
        const writeBuffer = mods.map(mod => {
            return this.usingFabricLoader ? mod.getPath() : mod.getExtensionlessMavenIdentifier()
        }).join('\n')

        if(writeBuffer) {
            fs.writeFileSync(this.forgeModListFile, writeBuffer, 'UTF-8')
            return this.usingFabricLoader ? [
                '--fabric.addMods',
                `@${this.forgeModListFile}`
            ] : [
                '--fml.mavenRoots',
                path.join('..', '..', 'common', 'modstore'),
                '--fml.modLists',
                this.forgeModListFile
            ]
        } else {
            return []
        }

    }

    _processAutoConnectArg(args){
        if(ConfigManager.getAutoConnect() && this.server.rawServer.autoconnect){
            if(mcVersionAtLeast('1.20', this.server.rawServer.minecraftVersion)){
                args.push('--quickPlayMultiplayer')
                args.push(`${this.server.hostname}:${this.server.port}`)
            } else {
                args.push('--server')
                args.push(this.server.hostname)
                args.push('--port')
                args.push(this.server.port)
            }
        }
    }

    /**
     * Fetch a Fyreth join token from the Auth API.
     *
     * @returns {Promise<string>} The generated token.
     * @throws {Error} If token acquisition fails.
     */
    async _fetchJoinToken() {
        const baseUrl = 'http://216.230.233.112:28080'
        const timeout = 5000

        if (!this.authUser.uuid || !this.authUser.displayName) {
            throw new Error('Incomplete authUser data. uuid and displayName are required.')
        }

        const userTypeMap = {
            'microsoft': 'msa',
            'ely': 'ely',
            'mojang': 'mojang'
        }
        const userType = userTypeMap[this.authUser.type] || 'mojang'

        try {
            // 1. Handshake
            const handshakeRes = await fetch(`${baseUrl}/v1/handshake`, { signal: AbortSignal.timeout(timeout) })
            if (!handshakeRes.ok) {
                throw new Error(`Handshake failed with status ${handshakeRes.status}`)
            }
            const handshakeData = await handshakeRes.json()
            const challenge = handshakeData.challenge

            if (!challenge) {
                throw new Error('Auth API handshake did not return a challenge.')
            }

            // 2. Issue Token
            // Prepare request body
            // Ensure UUID is in the correct format (with dashes) for Velocity
            const formattedUuid = formatUUID(this.authUser.uuid.trim())
            const requestBody = {
                    challenge: challenge,
                uuid: formattedUuid,
                    name: this.authUser.displayName,
                    userType: userType
            }
            
            // Add XUID and accessToken for Microsoft accounts (server may need them for skin loading)
            if(this.authUser.type === 'microsoft') {
                // Add XUID if available
                if(this.authUser.microsoft?.xuid) {
                    requestBody.xuid = this.authUser.microsoft.xuid.toString()
                }
                
                // Add accessToken so Velocity can load skin directly from Mojang API
                if(this.authUser.accessToken) {
                    requestBody.accessToken = this.authUser.accessToken
                }
            }
            
            const issueRes = await fetch(`${baseUrl}/v1/issue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(timeout)
            })

            if (!issueRes.ok) {
                const errorData = await issueRes.json().catch(() => ({}))
                throw new Error(errorData.error || `Issue token failed with status ${issueRes.status}`)
            }

            const issueData = await issueRes.json()
            const joinToken = issueData.join_token

            if (!joinToken) {
                throw new Error('Auth API did not return a join_token.')
            }

            return joinToken
        } catch (err) {
            logger.error('Error fetching join_token:', err)
            throw new Error(`Auth API error: ${err.message}`)
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @param {string} joinToken The Fyreth join token.
     * @returns {Promise<Array.<string>>} A promise that resolves to an array containing the full JVM arguments for this process.
     */
    async constructJVMArguments(mods, tempNativePath, joinToken){
        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            return await this._constructJVMArguments113(mods, tempNativePath, joinToken)
        } else {
            return await this._constructJVMArguments112(mods, tempNativePath, joinToken)
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.12 and below.
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @param {string} joinToken The Fyreth join token.
     * @returns {Promise<Array.<string>>} A promise that resolves to an array containing the full JVM arguments for this process.
     */
    async _constructJVMArguments112(mods, tempNativePath, joinToken){

        let args = []

        // Classpath Argument
        args.push('-cp')
        const cpArgs = await this.classpathArg(mods, tempNativePath)
        args.push(cpArgs.join(ProcessBuilder.getClasspathSeparator()))

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=HeliosLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + tempNativePath)

        // Fyreth: Add join_token
        if (joinToken) {
            args.push(`-Dfyreth.join_token=${joinToken}`)
        }

        // Ely.by: Add authlib-injector for client
        if(this.authUser.type === 'ely') {
            const authlibInjectorPath = getResourcePath('libraries/authlib-injector-1.2.7.jar')

            if(authlibInjectorPath) {
                // Authlib-injector configuration for Ely.by
                // Format: -javaagent:path=apiRoot
                // apiRoot should be just the domain (ely.by) - authlib-injector will resolve endpoints automatically
                args.unshift(`-javaagent:${authlibInjectorPath}=ely.by`)
                logger.info('Ely.by: Using authlib-injector for client:', authlibInjectorPath)
                logger.info('Ely.by: API domain: ely.by')
            } else {
                logger.warn('Ely.by: authlib-injector.jar not found. Expected locations:')
                logger.warn('  - libraries/authlib-injector-1.2.7.jar (dev mode)')
                logger.warn('  - resources/libraries/authlib-injector-1.2.7.jar (production mode)')
                logger.warn('Ely.by: Download it from https://github.com/yushijinhun/authlib-injector/releases')
            }
        }

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Forge Arguments
        args = args.concat(this._resolveForgeArgs())

        return args
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.13+
     *
     * Note: Required Libs https://github.com/MinecraftForge/MinecraftForge/blob/af98088d04186452cb364280340124dfd4766a5c/src/fmllauncher/java/net/minecraftforge/fml/loading/LibraryFinder.java#L82
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @param {string} joinToken The Fyreth join token.
     * @returns {Promise<Array.<string>>} A promise that resolves to an array containing the full JVM arguments for this process.
     */
    async _constructJVMArguments113(mods, tempNativePath, joinToken){

        const argDiscovery = /\${*(.*)}/

        // JVM Arguments First
        let args = this.vanillaManifest.arguments.jvm

        // Debug securejarhandler
        // args.push('-Dbsl.debug=true')

        if(this.modManifest.arguments.jvm != null) {
            for(const argStr of this.modManifest.arguments.jvm) {
                args.push(argStr
                    .replaceAll('${library_directory}', this.libPath)
                    .replaceAll('${classpath_separator}', ProcessBuilder.getClasspathSeparator())
                    .replaceAll('${version_name}', this.modManifest.id)
                )
            }
        }

        //args.push('-Dlog4j.configurationFile=D:\\WesterosCraft\\game\\common\\assets\\log_configs\\client-1.12.xml')

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=HeliosLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))

        // Fyreth: Add join_token
        if (joinToken) {
            args.push(`-Dfyreth.join_token=${joinToken}`)
        }

        // Ely.by: Add authlib-injector for client
        if(this.authUser.type === 'ely') {
            const authlibInjectorPath = getResourcePath('libraries/authlib-injector-1.2.7.jar')

            if(authlibInjectorPath) {
                // Authlib-injector configuration for Ely.by
                // Format: -javaagent:path=apiRoot
                // apiRoot should be just the domain (ely.by) - authlib-injector will resolve endpoints automatically
                args.unshift(`-javaagent:${authlibInjectorPath}=ely.by`)
                logger.info('Ely.by: Using authlib-injector for client:', authlibInjectorPath)
                logger.info('Ely.by: API domain: ely.by')
            } else {
                logger.warn('Ely.by: authlib-injector.jar not found. Expected locations:')
                logger.warn('  - libraries/authlib-injector-1.2.7.jar (dev mode)')
                logger.warn('  - resources/libraries/authlib-injector-1.2.7.jar (production mode)')
                logger.warn('Ely.by: Download it from https://github.com/yushijinhun/authlib-injector/releases')
            }
        }

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Vanilla Arguments
        args = args.concat(this.vanillaManifest.arguments.game)

        // Pre-resolve classpath as it's needed in the argument processing loop
        const classpathStr = (await this.classpathArg(mods, tempNativePath)).join(ProcessBuilder.getClasspathSeparator())

        for(let i=0; i<args.length; i++){
            if(typeof args[i] === 'object' && args[i].rules != null){

                let checksum = 0
                for(let rule of args[i].rules){
                    if(rule.os != null){
                        if(rule.os.name === getMojangOS()
                            && (rule.os.version == null || new RegExp(rule.os.version).test(os.release))){
                            if(rule.action === 'allow'){
                                checksum++
                            }
                        } else {
                            if(rule.action === 'disallow'){
                                checksum++
                            }
                        }
                    } else if(rule.features != null){
                        // We don't have many 'features' in the index at the moment.
                        // This should be fine for a while.
                        if(rule.features.has_custom_resolution != null && rule.features.has_custom_resolution === true){
                            if(ConfigManager.getFullscreen()){
                                args[i].value = [
                                    '--fullscreen',
                                    'true'
                                ]
                            }
                            checksum++
                        }
                    }
                }

                // TODO splice not push
                if(checksum === args[i].rules.length){
                    if(typeof args[i].value === 'string'){
                        args[i] = args[i].value
                    } else if(typeof args[i].value === 'object'){
                        //args = args.concat(args[i].value)
                        args.splice(i, 1, ...args[i].value)
                    }

                    // Decrement i to reprocess the resolved value
                    i--
                } else {
                    args[i] = null
                }

            } else if(typeof args[i] === 'string'){
                if(argDiscovery.test(args[i])){
                    const identifier = args[i].match(argDiscovery)[1]
                    let val = null
                    switch(identifier){
                        case 'auth_player_name':
                            val = this.authUser.displayName.trim()
                            break
                        case 'version_name':
                            //val = vanillaManifest.id
                            val = this.server.rawServer.id
                            break
                        case 'game_directory':
                            val = this.gameDir
                            break
                        case 'assets_root':
                            val = path.join(this.commonDir, 'assets')
                            break
                        case 'assets_index_name':
                            val = this.vanillaManifest.assets
                            break
                        case 'auth_uuid':
                            // Ensure UUID is in the correct format with dashes for all account types
                            const rawUuid = this.authUser.uuid.trim()
                            val = formatUUID(rawUuid)
                            break
                        case 'auth_access_token':
                        if (!this.authUser.accessToken) {
                            logger.error('Access token is missing for Microsoft account!')
                        }
                            val = this.authUser.accessToken
                            break
                        case 'user_type':
                            val = this.authUser.type === 'microsoft' ? 'msa' : (this.authUser.type === 'ely' ? 'ely' : 'mojang')
                            break
                    case 'clientid':
                        // clientid is only needed for Microsoft accounts
                        // Return null for non-Microsoft accounts so the parameter is not included
                        val = this.authUser.type === 'microsoft' ? '00000000402b5328' : null
                        break
                    case 'auth_xuid':
                        // For Microsoft accounts, use XUID or fallback to UUID
                        if(this.authUser.type === 'microsoft') {
                            const xuid = this.authUser.microsoft?.xuid
                            
                            if(xuid) {
                                // Use XUID from XSTS response (could be xid or uhs)
                                val = xuid.toString()
                            } else {
                                // Fallback to UUID without dashes if no XUID at all
                                val = this.authUser.uuid.trim().replace(/-/g, '')
                            }
                        } else {
                            // Return null for non-Microsoft accounts so the parameter is not included
                            val = null
                        }
                            break
                        case 'version_type':
                            val = this.vanillaManifest.type
                            break
                        case 'resolution_width':
                            val = ConfigManager.getGameWidth()
                            break
                        case 'resolution_height':
                            val = ConfigManager.getGameHeight()
                            break
                        case 'natives_directory':
                            val = args[i].replace(argDiscovery, tempNativePath)
                            break
                        case 'launcher_name':
                            val = args[i].replace(argDiscovery, 'Helios-Launcher')
                            break
                        case 'launcher_version':
                            val = args[i].replace(argDiscovery, this.launcherVersion)
                            break
                        case 'classpath':
                            val = classpathStr
                            break
                    }
                    if(val != null){
                        args[i] = val
                    }
                }
            }
        }

        // Autoconnect
        this._processAutoConnectArg(args)


        // Forge Specific Arguments
        args = args.concat(this.modManifest.arguments.game)

        // Helper function to resolve placeholder value
        const resolvePlaceholder = (key) => {
            switch(key) {
                case 'auth_uuid':
                    const rawUuid = this.authUser.uuid.trim()
                    return formatUUID(rawUuid)
                case 'auth_access_token':
                    return this.authUser.accessToken
                case 'auth_player_name':
                    return this.authUser.username || this.authUser.displayName
                case 'user_type':
                    return this.authUser.type === 'microsoft' ? 'msa' : (this.authUser.type === 'ely' ? 'ely' : 'mojang')
                case 'clientid':
                    // Only for Microsoft accounts
                    return this.authUser.type === 'microsoft' ? '00000000402b5328' : null
                case 'auth_xuid':
                    // Only for Microsoft accounts
                    if(this.authUser.type === 'microsoft') {
                        const xuid = this.authUser.microsoft?.xuid
                        
                        if(xuid) {
                            // Use XUID from XSTS response (could be xid or uhs)
                            return xuid.toString()
                        }
                        
                        // Fallback to UUID without dashes if no XUID at all
                        return this.authUser.uuid.trim().replace(/-/g, '')
                    } else {
                        return null
                    }
                default:
                    return null
            }
        }

        // Process placeholders in game arguments (e.g., ${clientid}, ${auth_xuid})
        // These might not have been processed in the main loop
        const gameArgDiscovery = /\$\{([^}]+)\}/g
        for(let i = 0; i < args.length; i++) {
            if(typeof args[i] === 'string') {
                // Check if this is a standalone placeholder (e.g., ${clientid})
                if(args[i].startsWith('${') && args[i].endsWith('}')) {
                    const key = args[i].substring(2, args[i].length - 1)
                    const replacement = resolvePlaceholder(key)
                    if(replacement != null) {
                        args[i] = replacement
                    } else {
                        // Mark for removal - will be filtered out later
                        args[i] = null
                        logger.warn(`Removing unresolved placeholder: ${args[i]}`)
                    }
                } else if(args[i].includes('${')) {
                    // Handle placeholders within strings
                    let val = args[i]
                    let match
                    // Reset regex
                    gameArgDiscovery.lastIndex = 0
                    while((match = gameArgDiscovery.exec(args[i])) !== null) {
                        const placeholder = match[0] // e.g., ${clientid}
                        const key = match[1] // e.g., clientid
                        const replacement = resolvePlaceholder(key)
                        
                        if(replacement != null) {
                            val = val.replace(placeholder, replacement)
                        } else {
                            // Remove placeholder if no replacement found
                            val = val.replace(placeholder, '')
                        }
                    }
                    
                    // Update the argument
                    if(val !== args[i]) {
                        args[i] = val
                    }
                }
            }
        }

        // Filter null values, empty strings, and unresolved placeholders
        // Also remove flag arguments (like --clientId, --xuid) if their value was null
        const filteredArgs = []
        for(let i = 0; i < args.length; i++) {
            const arg = args[i]
            
            // Check if current argument is null or empty
            if(arg == null) {
                // If previous argument was a flag (starts with --), remove it too
                if(filteredArgs.length > 0 && typeof filteredArgs[filteredArgs.length - 1] === 'string' && filteredArgs[filteredArgs.length - 1].startsWith('--')) {
                    const removedFlag = filteredArgs.pop()
                    logger.warn(`Removing flag ${removedFlag} because its value is null`)
                }
                continue
            }
            
            if(typeof arg === 'string') {
                // Remove empty strings
                if(arg.trim() === '') {
                    // If previous argument was a flag, remove it too
                    if(filteredArgs.length > 0 && filteredArgs[filteredArgs.length - 1].startsWith('--')) {
                        const removedFlag = filteredArgs.pop()
                        logger.warn(`Removing flag ${removedFlag} because its value is empty`)
                    }
                    continue
                }
                // Remove unresolved placeholders (e.g., ${clientid}, ${auth_xuid})
                if(arg.startsWith('${') && arg.endsWith('}')) {
                    logger.warn(`Removing unresolved placeholder: ${arg}`)
                    // Also remove the previous argument if it's a flag (e.g., --clientId)
                    if(filteredArgs.length > 0 && filteredArgs[filteredArgs.length - 1].startsWith('--')) {
                        const removedFlag = filteredArgs.pop()
                        logger.warn(`Removing flag ${removedFlag} because its value was unresolved`)
                    }
                    continue
                }
            }
            filteredArgs.push(arg)
        }
        args = filteredArgs

        // Helper function to find safe insertion point for JVM arguments
        // This works on all platforms to ensure JVM args are inserted before -cp or main class
        const findJVMArgInsertIndex = () => {
            // First, try to find -cp and insert before it
            const cpIndex = args.findIndex(arg => arg === '-cp')
            if(cpIndex > 0){
                return cpIndex
            }
            
            // If no -cp, find the main class (first non-flag argument that doesn't start with -)
            const mainClassIndex = args.findIndex(arg => typeof arg === 'string' && !arg.startsWith('-') && !arg.startsWith('--'))
            if(mainClassIndex > 0){
                return mainClassIndex
            }
            
            // Fallback: insert at the end
            return args.length
        }
        
        // Ensure java.library.path is set on all platforms
        // This should be set via natives_directory placeholder, but verify as a safety measure
        const hasLibraryPath = args.some(arg => typeof arg === 'string' && arg.startsWith('-Djava.library.path='))
        if(!hasLibraryPath){
            const insertIndex = findJVMArgInsertIndex()
            // On macOS, insert after -XstartOnFirstThread if it exists, otherwise use calculated index
            if(process.platform === 'darwin'){
                const xstartIndex = args.findIndex(arg => arg === '-XstartOnFirstThread')
                if(xstartIndex >= 0){
                    args.splice(xstartIndex + 1, 0, '-Djava.library.path=' + tempNativePath)
                } else {
                    args.splice(insertIndex, 0, '-Djava.library.path=' + tempNativePath)
                }
            } else {
                args.splice(insertIndex, 0, '-Djava.library.path=' + tempNativePath)
            }
            logger.warn('[ProcessBuilder]: natives_directory placeholder was not resolved, added -Djava.library.path manually')
        }
        
        // On macOS, LWJGL requires explicit library path setting
        // This is a standard practice for macOS, not a workaround
        // See: https://github.com/LWJGL/lwjgl3/issues/481
        // On Windows and Linux, -Djava.library.path is usually sufficient
        if(process.platform === 'darwin'){
            const hasLWJGLPath = args.some(arg => typeof arg === 'string' && arg.startsWith('-Dorg.lwjgl.librarypath='))
            if(!hasLWJGLPath){
                // On macOS, insert after -XstartOnFirstThread and -Djava.library.path if they exist
                const xstartIndex = args.findIndex(arg => arg === '-XstartOnFirstThread')
                const libraryPathIndex = args.findIndex(arg => typeof arg === 'string' && arg.startsWith('-Djava.library.path='))
                
                if(libraryPathIndex >= 0){
                    // Insert right after -Djava.library.path
                    args.splice(libraryPathIndex + 1, 0, '-Dorg.lwjgl.librarypath=' + tempNativePath)
                } else if(xstartIndex >= 0){
                    // Insert after -XstartOnFirstThread
                    args.splice(xstartIndex + 1, 0, '-Dorg.lwjgl.librarypath=' + tempNativePath)
                } else {
                    // Fallback to calculated index
                    const insertIndex = findJVMArgInsertIndex()
                    args.splice(insertIndex, 0, '-Dorg.lwjgl.librarypath=' + tempNativePath)
                }
            }
        }

        return args
    }

    /**
     * Resolve the arguments required by forge.
     *
     * @returns {Array.<string>} An array containing the arguments required by forge.
     */
    _resolveForgeArgs(){
        const mcArgs = this.modManifest.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/

        // Replace the declared variables with their proper values.
        for(let i=0; i<mcArgs.length; ++i){
            if(argDiscovery.test(mcArgs[i])){
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch(identifier){
                    case 'auth_player_name':
                        val = this.authUser.displayName.trim()
                        break
                    case 'version_name':
                        //val = vanillaManifest.id
                        val = this.server.rawServer.id
                        break
                    case 'game_directory':
                        val = this.gameDir
                        break
                    case 'assets_root':
                        val = path.join(this.commonDir, 'assets')
                        break
                    case 'assets_index_name':
                        val = this.vanillaManifest.assets
                        break
                    case 'auth_uuid':
                        // Ensure UUID is in the correct format with dashes for all account types
                        const rawUuidForge = this.authUser.uuid.trim()
                        val = formatUUID(rawUuidForge)
                        break
                    case 'auth_access_token':
                        if (!this.authUser.accessToken) {
                            logger.error('Access token is missing for Microsoft account!')
                        }
                        val = this.authUser.accessToken
                        break
                    case 'user_type':
                        val = this.authUser.type === 'microsoft' ? 'msa' : (this.authUser.type === 'ely' ? 'ely' : 'mojang')
                        break
                    case 'user_properties': // 1.8.9 and below.
                        val = '{}'
                        break
                    case 'version_type':
                        val = this.vanillaManifest.type
                        break
                    case 'clientid':
                        // clientid is only needed for Microsoft accounts
                        // Return null for non-Microsoft accounts so the parameter is not included
                        val = this.authUser.type === 'microsoft' ? '00000000402b5328' : null
                        break
                    case 'auth_xuid':
                        // For Microsoft accounts, use real XUID from XSTS if available
                        // If XUID is not available, use UUID without dashes as fallback
                        // Minecraft requires --xuid for Microsoft accounts to load skins correctly
                        if(this.authUser.type === 'microsoft') {
                            const xuid = this.authUser.microsoft?.xuid
                            if(xuid) {
                                val = xuid.toString()
                            } else {
                                // Fallback to Minecraft UUID without dashes
                                // This is required for Microsoft accounts even if real XUID is not available
                                val = this.authUser.uuid.trim().replace(/-/g, '')
                            }
                        } else {
                            // Return null for non-Microsoft accounts so the parameter is not included
                            val = null
                        }
                        break
                }
                if(val != null){
                    mcArgs[i] = val
                }
            }
        }

        // Autoconnect to the selected server.
        this._processAutoConnectArg(mcArgs)

        // Prepare game resolution
        if(ConfigManager.getFullscreen()){
            mcArgs.push('--fullscreen')
            mcArgs.push(true)
        } else {
            mcArgs.push('--width')
            mcArgs.push(ConfigManager.getGameWidth())
            mcArgs.push('--height')
            mcArgs.push(ConfigManager.getGameHeight())
        }

        // Mod List File Argument
        mcArgs.push('--modListFile')
        if(this._lteMinorVersion(9)) {
            mcArgs.push(path.basename(this.fmlDir))
        } else {
            mcArgs.push('absolute:' + this.fmlDir)
        }


        // LiteLoader
        if(this.usingLiteLoader){
            mcArgs.push('--modRepo')
            mcArgs.push(this.llDir)

            // Set first arg to liteloader tweak class
            mcArgs.unshift('com.mumfrey.liteloader.launch.LiteLoaderTweaker')
            mcArgs.unshift('--tweakClass')
        }

        return mcArgs
    }

    /**
     * Ensure that the classpath entries all point to jar files.
     *
     * @param {Array.<String>} list Array of classpath entries.
     */
    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for(let i=0; i<list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if(extIndex > -1 && extIndex  !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }

    /**
     * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
     * libraries as well as the libraries declared by the server. Since mods are permitted to declare libraries,
     * this method requires all enabled mods as an input
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Promise<Array.<string>>} A promise that resolves to an array containing the paths of each library required by this process.
     */
    async classpathArg(mods, tempNativePath){
        let cpArgs = []

        if(!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) || this.usingFabricLoader) {
            // Add the version.jar to the classpath.
            // Must not be added to the classpath for Forge 1.17+.
            const version = this.vanillaManifest.id
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        }


        if(this.usingLiteLoader){
            cpArgs.push(this.llPath)
        }

        // Resolve the Mojang declared libraries.
        const mojangLibs = await this._resolveMojangLibraries(tempNativePath)

        // Resolve the server declared libraries.
        const servLibs = this._resolveServerLibraries(mods)

        // Merge libraries, server libs with the same
        // maven identifier will override the mojang ones.
        // Ex. 1.7.10 forge overrides mojang's guava with newer version.
        const finalLibs = {...mojangLibs, ...servLibs}
        cpArgs = cpArgs.concat(Object.values(finalLibs))

        this._processClassPathList(cpArgs)

        return cpArgs
    }

    /**
     * Resolve the libraries defined by Mojang's version data. This method will also extract
     * native libraries and point to the correct location for its classpath.
     *
     * TODO - clean up function
     *
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Promise<{[id: string]: string}>} A promise that resolves to an object containing the paths of each library mojang declares.
     */
    async _resolveMojangLibraries(tempNativePath){
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}
        const extractPromises = []

        const libArr = this.vanillaManifest.libraries
        fs.ensureDirSync(tempNativePath)
        for(let i=0; i<libArr.length; i++){
            const lib = libArr[i]
            if(isLibraryCompatible(lib.rules, lib.natives)){

                // Pre-1.19 has a natives object.
                if(lib.natives != null) {
                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    // Get actual system architecture (not process.arch which might be x64 under Rosetta)
                    const systemArch = getSystemArchitecture()
                    // Normalize architecture for Mojang manifest format
                    const archStr = normalizeArchitecture(systemArch, process.platform, true)
                    const nativeKey = lib.natives[getMojangOS()]
                    if (!nativeKey) {
                        continue // Skip if no native for this OS
                    }
                    const classifierKey = nativeKey.replace('${arch}', archStr)
                    logger.debug(`[ProcessBuilder]: Pre-1.19 native: OS=${getMojangOS()}, systemArch=${systemArch} (process.arch=${process.arch}), normalized=${archStr}, classifierKey=${classifierKey}`)
                    
                    // Additional safety check for macOS arm64: explicitly reject x86_64/x64 classifiers
                    if (process.platform === 'darwin' && systemArch === 'arm64' && (classifierKey.includes('x86_64') || classifierKey.includes('x64'))) {
                        logger.debug(`[ProcessBuilder]: Pre-1.19: Skipping library ${lib.name} - x86_64/x64 classifier not compatible with arm64 Mac (classifierKey: ${classifierKey})`)
                        continue
                    }
                    
                    const artifact = lib.downloads.classifiers[classifierKey]
                    if (!artifact) {
                        // Try alternative classifier keys for macOS arm64
                        if (process.platform === 'darwin' && systemArch === 'arm64') {
                            const altClassifierKey = nativeKey.replace('${arch}', 'aarch64')
                            logger.debug(`[ProcessBuilder]: Pre-1.19: Trying alternative classifier key for arm64: ${altClassifierKey}`)
                            const altArtifact = lib.downloads.classifiers[altClassifierKey]
                            if (altArtifact) {
                                logger.info(`[ProcessBuilder]: Pre-1.19: Using alternative classifier key ${altClassifierKey} for arm64 Mac`)
                                // Use the alternative artifact
                                const to = path.join(this.libPath, altArtifact.path)
                                if (!fs.existsSync(to)) {
                                    logger.warn(`[ProcessBuilder]: Pre-1.19: Artifact file not found: ${to}`)
                                    continue
                                }
                                // Extract from alternative artifact
                                let zip = new AdmZip(to)
                                let zipEntries = zip.getEntries()
                                for(let i=0; i<zipEntries.length; i++){
                                    const fileName = zipEntries[i].entryName
                                    let shouldExclude = false
                                    exclusionArr.forEach(function(exclusion){
                                        if(fileName.indexOf(exclusion) > -1){
                                            shouldExclude = true
                                        }
                                    })
                                    if(!shouldExclude){
                                        const filePath = path.join(tempNativePath, fileName)
                                        const fileData = zipEntries[i].getData()
                                        extractPromises.push(
                                            fs.promises.writeFile(filePath, fileData).catch(err => {
                                                logger.error('Error while extracting native library:', err)
                                            })
                                        )
                                    }
                                }
                                continue // Skip to next library
                            }
                        }
                        logger.warn(`[ProcessBuilder]: No artifact found for classifier key: ${classifierKey}. Available keys: ${Object.keys(lib.downloads.classifiers || {}).join(', ')}`)
                        continue
                    }

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        // Extract the file.
                        if(!shouldExclude){
                            const filePath = path.join(tempNativePath, fileName)
                            const fileData = zipEntries[i].getData()
                            extractPromises.push(
                                fs.promises.writeFile(filePath, fileData).catch(err => {
                                    logger.error('Error while extracting native library:', err)
                                })
                            )
                        }

                    }
                }
                // 1.19+ logic
                else if(lib.name.includes('natives-')) {

                    const regexTest = nativesRegex.exec(lib.name)
                    if (!regexTest) {
                        continue
                    }
                    const osFromName = regexTest[1] // e.g., 'macos', 'linux', 'windows'
                    const arch = regexTest[2] ?? 'x64'

                    // First check if OS matches
                    const mojangOS = getMojangOS()
                    const osMatches = osFromName === mojangOS || 
                        (osFromName === 'macos' && mojangOS === 'osx') ||
                        (osFromName === 'osx' && mojangOS === 'macos')
                    
                    if (!osMatches) {
                        logger.debug(`[ProcessBuilder]: Skipping library ${lib.name} - OS mismatch (${osFromName} vs ${mojangOS})`)
                        continue
                    }

                    // Get actual system architecture (not process.arch which might be x64 under Rosetta)
                    const systemArch = getSystemArchitecture()
                    // Compare architectures using normalized comparison
                    // This handles differences between Mojang format (aarch64) and Node.js format (arm64)
                    const archMatch = compareArchitecture(arch, systemArch, process.platform)
                    logger.debug(`[ProcessBuilder]: 1.19+ native check: lib.name=${lib.name}, OS=${osFromName}, extracted arch=${arch}, systemArch=${systemArch} (process.arch=${process.arch}), match=${archMatch}`)
                    
                    // Additional safety check for macOS arm64: explicitly reject x86_64/x64 libraries
                    // (compareArchitecture should already filter these, but this provides extra safety)
                    if (process.platform === 'darwin' && systemArch === 'arm64' && (arch === 'x86_64' || arch === 'x64')) {
                        logger.debug(`[ProcessBuilder]: Skipping library ${lib.name} - x86_64/x64 not compatible with arm64 Mac`)
                        continue
                    }
                    
                    if(!archMatch) {
                        logger.debug(`[ProcessBuilder]: Skipping library ${lib.name} - architecture mismatch (${arch} vs ${systemArch})`)
                        continue
                    }
                    logger.info(`[ProcessBuilder]: Using library ${lib.name} for architecture ${arch} on ${process.platform} (systemArch=${systemArch}, process.arch=${process.arch})`)

                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
                    const artifact = lib.downloads.artifact

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        if(zipEntries[i].isDirectory) {
                            continue
                        }

                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        const extractName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/')) : fileName

                        // Extract the file.
                        if(!shouldExclude){
                            const filePath = path.join(tempNativePath, extractName)
                            const fileData = zipEntries[i].getData()
                            extractPromises.push(
                                fs.promises.writeFile(filePath, fileData).catch(err => {
                                    logger.error('Error while extracting native library:', err)
                                })
                            )
                        }

                    }
                }
                // No natives
                else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }
            }
        }

        // Wait for all native library extractions to complete
        // This ensures all files are extracted before the process is launched
        if(extractPromises.length > 0){
            await Promise.all(extractPromises)
            logger.info(`[ProcessBuilder]: Extracted ${extractPromises.length} native library files to ${tempNativePath}`)
            
            // On macOS, verify that LWJGL libraries are present and check architecture
            if(process.platform === 'darwin'){
                const lwjglLibs = ['liblwjgl.dylib', 'liblwjgl_opengl.dylib', 'liblwjgl_glfw.dylib']
                for(const lib of lwjglLibs){
                    const libPath = path.join(tempNativePath, lib)
                    if(!fs.existsSync(libPath)){
                        logger.warn(`[ProcessBuilder]: LWJGL library not found: ${lib} at ${libPath}`)
                    } else {
                        // Check library architecture on macOS
                        try {
                            const { execSync } = require('child_process')
                            const fileInfo = execSync(`file "${libPath}"`, { encoding: 'utf8' })
                            logger.debug(`[ProcessBuilder]: ${lib} architecture: ${fileInfo.trim()}`)
                            
                            // Verify it matches expected architecture
                            // Check for architecture in file info (handles both arm64 and aarch64 naming)
                            const expectedArch = getSystemArchitecture()
                            const isArm64 = expectedArch === 'arm64'
                            const isX64 = expectedArch === 'x64'
                            
                            if(isArm64 && !fileInfo.includes('arm64') && !fileInfo.includes('arm64e') && !fileInfo.includes('aarch64')) {
                                logger.error(`[ProcessBuilder]: Architecture mismatch! Expected arm64/aarch64 but got different architecture for ${lib}`)
                            } else if(isX64 && process.platform !== 'win32' && !fileInfo.includes('x86_64') && !fileInfo.includes('x64')) {
                                logger.error(`[ProcessBuilder]: Architecture mismatch! Expected x86_64/x64 but got different architecture for ${lib}`)
                            } else if(isX64 && process.platform === 'win32' && !fileInfo.includes('x64') && !fileInfo.includes('x86_64')) {
                                logger.error(`[ProcessBuilder]: Architecture mismatch! Expected x64 but got different architecture for ${lib}`)
                            }
                        } catch(err) {
                            logger.warn(`[ProcessBuilder]: Could not check architecture for ${lib}:`, err.message)
                        }
                    }
                }
            }
        }

        return libs
    }

    /**
     * Resolve the libraries declared by this server in order to add them to the classpath.
     * This method will also check each enabled mod for libraries, as mods are permitted to
     * declare libraries.
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
     */
    _resolveServerLibraries(mods){
        const mdls = this.server.modules
        let libs = {}

        // Locate Forge/Fabric/Libraries
        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeHosted || type === Type.Fabric || type === Type.Library){
                libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath()
                if(mdl.subModules.length > 0){
                    const res = this._resolveModuleLibraries(mdl)
                    libs = {...libs, ...res}
                }
            }
        }

        //Check for any libraries in our mod list.
        for(let i=0; i<mods.length; i++){
            if(mods.sub_modules != null){
                const res = this._resolveModuleLibraries(mods[i])
                libs = {...libs, ...res}
            }
        }

        return libs
    }

    /**
     * Recursively resolve the path of each library required by this module.
     *
     * @param {Object} mdl A module object from the server distro index.
     * @returns {{[id: string]: string}} An object containing the paths of each library this module requires.
     */
    _resolveModuleLibraries(mdl){
        if(!mdl.subModules.length > 0){
            return {}
        }
        let libs = {}
        for(let sm of mdl.subModules){
            if(sm.rawModule.type === Type.Library){

                if(sm.rawModule.classpath ?? true) {
                    libs[sm.getVersionlessMavenIdentifier()] = sm.getPath()
                }
            }
            // If this module has submodules, we need to resolve the libraries for those.
            // To avoid unnecessary recursive calls, base case is checked here.
            if(mdl.subModules.length > 0){
                const res = this._resolveModuleLibraries(sm)
                libs = {...libs, ...res}
            }
        }
        return libs
    }

}

module.exports = ProcessBuilder