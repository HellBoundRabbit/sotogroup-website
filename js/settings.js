// Settings utility for office portal
// Stores settings in localStorage with user-specific keys

const SETTINGS_KEY_PREFIX = 'soto_office_settings_';

function getSettingsKey() {
    // Try to get user ID from session or localStorage
    const userIdentity = localStorage.getItem('soto_user_identity');
    if (userIdentity) {
        try {
            const user = JSON.parse(userIdentity);
            return `${SETTINGS_KEY_PREFIX}${user.uid || 'default'}`;
        } catch (e) {
            console.warn('Failed to parse user identity:', e);
        }
    }
    return `${SETTINGS_KEY_PREFIX}default`;
}

function getSetting(key, defaultValue = false) {
    try {
        const settingsKey = getSettingsKey();
        const settings = JSON.parse(localStorage.getItem(settingsKey) || '{}');
        return settings[key] !== undefined ? settings[key] : defaultValue;
    } catch (e) {
        console.warn('Failed to get setting:', e);
        return defaultValue;
    }
}

function setSetting(key, value) {
    try {
        const settingsKey = getSettingsKey();
        const settings = JSON.parse(localStorage.getItem(settingsKey) || '{}');
        settings[key] = value;
        localStorage.setItem(settingsKey, JSON.stringify(settings));
        return true;
    } catch (e) {
        console.warn('Failed to set setting:', e);
        return false;
    }
}

// Specific setting for Asana API route input
function getUseAsanaApiForRoutes() {
    return getSetting('useAsanaApiForRoutes', false);
}

function setUseAsanaApiForRoutes(value) {
    return setSetting('useAsanaApiForRoutes', value);
}

// Make functions globally available
window.sotoSettings = {
    getSetting,
    setSetting,
    getUseAsanaApiForRoutes,
    setUseAsanaApiForRoutes
};

