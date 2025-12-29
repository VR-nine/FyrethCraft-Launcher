// NOTE FOR THIRD-PARTY
// REPLACE THIS CLIENT ID WITH YOUR APPLICATION ID.
// SEE https://github.com/dscalzi/HeliosLauncher/blob/master/docs/MicrosoftAuth.md
// TODO: Replace this Client ID with your own, registered in Microsoft Azure
exports.AZURE_CLIENT_ID = '211863ee-f9dd-4c72-a0c6-3a344a32a17c'
// SEE NOTE ABOVE.


// Opcodes
exports.MSFT_OPCODE = {
    OPEN_LOGIN: 'MSFT_AUTH_OPEN_LOGIN',
    OPEN_LOGOUT: 'MSFT_AUTH_OPEN_LOGOUT',
    REPLY_LOGIN: 'MSFT_AUTH_REPLY_LOGIN',
    REPLY_LOGOUT: 'MSFT_AUTH_REPLY_LOGOUT'
}
// Reply types for REPLY opcode.
exports.MSFT_REPLY_TYPE = {
    SUCCESS: 'MSFT_AUTH_REPLY_SUCCESS',
    ERROR: 'MSFT_AUTH_REPLY_ERROR'
}
// Error types for ERROR reply.
exports.MSFT_ERROR = {
    ALREADY_OPEN: 'MSFT_AUTH_ERR_ALREADY_OPEN',
    NOT_FINISHED: 'MSFT_AUTH_ERR_NOT_FINISHED'
}

exports.SHELL_OPCODE = {
    TRASH_ITEM: 'TRASH_ITEM'
}

// Ely.by Configuration
exports.ELY_CONFIG = {
    AUTH_SERVER_URL: 'https://authserver.ely.by',
    SESSION_SERVER_URL: 'https://authserver.ely.by',
    ERROR_CODES: {
        ILLEGAL_ARGUMENT: 'IllegalArgumentException',
        FORBIDDEN_OPERATION: 'ForbiddenOperationException'
    }
}