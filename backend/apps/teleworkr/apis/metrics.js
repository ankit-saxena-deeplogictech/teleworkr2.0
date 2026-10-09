/**
 * The metrics API — A10. Named metrics.js, not events.js: apis/events.js is
 * already the unrelated real-time UI-notification blackboard.
 *
 * No client-side emit op — every event is server-triggered only, at the
 * exact places the instrumented actions already happen. The capability
 * check (events.read_aggregate / events.operate) happens inside
 * lib/events.js itself, the same way lib/diversity.js's adverseImpactAsync
 * gates its own read.
 *
 * Operations:
 *  op - summary              - I3's seven buildable metrics over a date range
 *  op - preview_retention_run - what the 90-day rollup would do, no writes
 *  op - execute_retention_run - runs the rollup
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const events = require(`${TELEWORKR_CONSTANTS.LIBDIR}/events.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "summary": {
                const result = await events.summaryAsync(jsonReq.org, actor.person_id,
                    {from_date: jsonReq.from_date, to_date: jsonReq.to_date});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "preview_retention_run": {
                const result = await events.previewRetentionRunAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "execute_retention_run": {
                const result = await events.executeRetentionRunAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Metrics operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["summary", "preview_retention_run", "execute_retention_run"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
