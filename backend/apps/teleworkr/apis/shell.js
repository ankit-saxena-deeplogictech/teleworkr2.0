/**
 * The shell API — A2 and A7. One call returns everything the frozen header and
 * nav need for first paint: who the caller is, the surfaces they can reach, where
 * they land, and the system banner slot.
 *
 * The live parts of the header have their own APIs and are polled separately —
 * the clock (clock.js), the notification count (notifications.js) and the overlap
 * chip (windows.js). Folding them in here would make one endpoint that has to be
 * re-fetched whenever any of them ticks.
 *
 * Operations:
 *  op - bootstrap - The caller's shell projection
 *  op - surfaces  - The full surface catalogue with what each requires, for the
 *      A7 coverage view. Reading the catalogue is not reading anyone's grants.
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const shell = require(`${TELEWORKR_CONSTANTS.LIBDIR}/shell.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        switch (jsonReq.op) {
            case "bootstrap": {
                // Identity is resolved by email, but an org that does not exist yet
                // cannot have a provisioned person in it — asking "who is this"
                // before asking "does this org exist" would throw "no person" for
                // the exact first-run case the org_missing projection exists to
                // answer. So the lookup is passed through, not resolved here: only
                // projectAsync knows whether a missing person means "no org" or
                // "not provisioned", because only it has checked the org first.
                const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
                const projection = await shell.projectAsync(
                    {org_id: jsonReq.org, person_id: person?.person_id || null, asOf: jsonReq.asOf});
                return {...CONSTANTS.TRUE_RESULT, ...projection};
            }
            case "surfaces": {
                const surfaces = Object.entries(shell.SURFACES).map(([id, surface]) => ({id,
                    label: surface.label, tab: surface.tab||null, console: surface.console||null,
                    screen: surface.screen, classification: surface.classification,
                    requires: surface.any_of || (surface.capability ? [surface.capability] : [])}));
                return {...CONSTANTS.TRUE_RESULT, surfaces, tabs: shell.TABS};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Shell operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const validateRequest = jsonReq => jsonReq && jsonReq.op && jsonReq.id && jsonReq.org;
