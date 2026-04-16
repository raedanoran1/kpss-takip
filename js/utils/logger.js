// Logger utility for development and production
// Production'da sadece error'lar loglanır, development'da tüm loglar

const isDevelopment = 
    chrome?.runtime?.getManifest?.()?.version?.includes('dev') || 
    chrome?.runtime?.getManifest?.()?.version?.includes('beta') ||
    typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

export const logger = {
    /**
     * Log info messages (only in development)
     */
    log: (...args) => {
        if (isDevelopment) {
            console.log('[KPSS]', ...args);
        }
    },
    
    /**
     * Log errors (always logged)
     */
    error: (...args) => {
        console.error('[KPSS ERROR]', ...args);
    },
    
    /**
     * Log warnings (only in development)
     */
    warn: (...args) => {
        if (isDevelopment) {
            console.warn('[KPSS WARN]', ...args);
        }
    },
    
    /**
     * Log debug messages (only in development)
     */
    debug: (...args) => {
        if (isDevelopment) {
            console.debug('[KPSS DEBUG]', ...args);
        }
    }
};
