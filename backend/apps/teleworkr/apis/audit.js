/**
 * The audit log API — H4. The actor is the token's id (their email).
 *
 * Operations:
 *  op - query            - the log at the caller's own level (own/policy/all), decided by audit.js itself
 *  op - coverage         - the published logged-event list — what's always audited, and the category names
 *  op - verify_integrity - recomputes the hash chain; admin-only, gated here since the lib function isn't
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "query": {
                const rows = await audit.queryAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    subject_person_id: jsonReq.subject_person_id, object_type: jsonReq.object_type,
                    action: jsonReq.action, category: jsonReq.category, from: jsonReq.from, to: jsonReq.to,
                    limit: jsonReq.limit});
                const entries = rows.map(row => ({...row, detail: row.detail ? JSON.parse(row.detail) : {}}));
                return {...CONSTANTS.TRUE_RESULT, entries};
            }
            case "coverage": {
                return {...CONSTANTS.TRUE_RESULT, ...audit.coverage()};
            }
            case "verify_integrity": {
                // verifyIntegrityAsync itself carries no capability check — it's a trusted-caller
                // primitive today (tests, other server code). Gated here, at the boundary that
                // actually makes it reachable over the network for the first time.
                await permissions.requireAsync({org_id: jsonReq.org, actor_person_id: actor.person_id, capability: "audit.read_all"});
                const result = await audit.verifyIntegrityAsync(jsonReq.org);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Audit operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["query", "coverage", "verify_integrity"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
