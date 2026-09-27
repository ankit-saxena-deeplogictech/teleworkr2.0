/**
 * The sessions & incidents API — L4. The actor is the token's id (their email).
 *
 * Operations:
 *  op - my_sessions        - the caller's own sessions
 *  op - sign_out           - sign out one of the caller's own sessions
 *  op - revoke_for         - bulk (advisory) revoke by person/role/whole org
 *  op - detection_feed     - the recent sign-in feed, tiered
 *  op - incidents          - every incident for the org
 *  op - incident_detail    - one incident's full timeline and regulatory clock
 *  op - open_incident      - open a new incident
 *  op - contain_sessions   - the Contain phase, from inside an incident
 *  op - assess             - the Assess phase
 *  op - notify             - the Notify phase
 *  op - add_note           - a free-text timeline entry
 *  op - close_incident     - close an incident with a conclusion
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const sessions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/sessions.js`);
const incidents = require(`${TELEWORKR_CONSTANTS.LIBDIR}/incidents.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "my_sessions": {
                const result = await sessions.mySessionsAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "sign_out": {
                const result = await sessions.signOutSessionAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    session_id: jsonReq.session_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "revoke_for": {
                const result = await sessions.revokeSessionsForAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    person_id: jsonReq.person_id, role_name: jsonReq.role_name, whole_org: jsonReq.whole_org, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "detection_feed": {
                const result = await sessions.detectionFeedAsync(jsonReq.org, actor.person_id, {days: jsonReq.days});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "incidents": {
                const result = await incidents.incidentsAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "incident_detail": {
                const result = await incidents.incidentDetailAsync(jsonReq.org, actor.person_id, jsonReq.incident_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "open_incident": {
                const incident = await incidents.openIncidentAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    title: jsonReq.title, awareness_at: jsonReq.awareness_at});
                return {...CONSTANTS.TRUE_RESULT, incident};
            }
            case "contain_sessions": {
                const result = await incidents.containSessionsAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    incident_id: jsonReq.incident_id, person_id: jsonReq.person_id, role_name: jsonReq.role_name,
                    whole_org: jsonReq.whole_org, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "assess": {
                const result = await incidents.assessAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    incident_id: jsonReq.incident_id, person_id: jsonReq.person_id, from: jsonReq.from, to: jsonReq.to});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "notify": {
                const result = await incidents.notifyAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    incident_id: jsonReq.incident_id, person_ids: jsonReq.person_ids, message: jsonReq.message});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "add_note": {
                const result = await incidents.addNoteAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    incident_id: jsonReq.incident_id, text: jsonReq.text});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "close_incident": {
                const result = await incidents.closeIncidentAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    incident_id: jsonReq.incident_id, conclusion: jsonReq.conclusion});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Security operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["my_sessions", "sign_out", "revoke_for", "detection_feed", "incidents", "incident_detail",
    "open_incident", "contain_sessions", "assess", "notify", "add_note", "close_incident"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
