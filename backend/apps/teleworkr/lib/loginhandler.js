/**
 * Login listener that resolves the signed-in person's org context.
 *
 * It deliberately does not attach a list of views to the login result. A7 makes
 * roles a projection over capability × scope rather than a stored menu, so what a
 * person can reach is evaluated from their grants at request time. A nav array
 * baked into a login response is the same thing as a role fork, one release later.
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const login = require(`${TELEWORKR_CONSTANTS.APIDIR}/login.js`);
const identity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/identity.js`);

exports.initSync = _ => login.addLoginListener(`${TELEWORKR_CONSTANTS.LIBDIR}/loginhandler.js`, "employmentInjector");

/**
 * Provisions the signed-in person from their assertion where they have no
 * employment yet, and reads jurisdiction and manager from the record in force —
 * not from the assertion each caller happens to hold.
 * @param {object} result The login result, modified in place
 * @returns true if an employment is in force for this sign-in, false otherwise
 */
exports.employmentInjector = async function(result) {
    if (!result.tokenflag) return false;

    try {
        return await identity.provisionFromAssertionAsync(result);
    } catch (err) {
        LOG.error(`Error resolving employment for ${result.id} in ${result.org}: ${err}`);
        return false;
    }
}
