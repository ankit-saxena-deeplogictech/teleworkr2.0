/**
 * Teleworkr app init.
 * (C) 2026 TekMonks. All rights reserved.
 */

exports.initSync = function(_app, approot) {
    global.LOGINAPP_CONSTANTS = {ENV: {}}; // legacy, kept for the login framework

    const TELEWORKR_APP_LIBDIR = `${approot}/lib`;
    global.TELEWORKR_CONSTANTS = require(`${TELEWORKR_APP_LIBDIR}/teleworkrconstants.js`);

    require(`${TELEWORKR_CONSTANTS.LIBDIR}/init.js`).initSync(approot);
}
