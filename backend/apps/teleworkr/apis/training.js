/**
 * The training API — P. The actor is the token's id (their email).
 *
 * Operations:
 *  op - catalogue       - P2: required band then recommended, for the caller
 *  op - course          - P3: detail, module list, pass policy, what a lead sees
 *  op - start_module    - P4: module_started; self-enrols optional courses
 *  op - save_attempt    - P4: grades and stores one attempt (idempotent)
 *  op - complete_module - P4: progress event + training time entry, one txn
 *  op - pass_course     - P4: certificate issued, assignment closed
 *  op - certificates    - P5: the caller's certificates with expiry countdown
 *  op - export_record   - P5: the portable self-serve training record
 *  op - verify          - P5: public — a code proves existence, nothing else
 *  op - track           - P6: completion status only (training.track)
 *  op - assign          - P6: manual assignment with a visible reason
 *  op - publish         - P1/P6: publish or supersede a course version
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const training = require(`${TELEWORKR_CONSTANTS.LIBDIR}/training.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = jsonReq.op == "verify" ? null : await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "verify": {
                const result = await training.verifyCertificateAsync(jsonReq.code);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "catalogue": {
                const result = await training.catalogueForPersonAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "course": {
                const result = await training.courseDetailAsync(jsonReq.org, actor.person_id, jsonReq.course_code);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "start_module": {
                const result = await training.startModuleAsync(jsonReq.org, actor.person_id,
                    jsonReq.course_code, jsonReq.module_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "save_attempt": {
                const result = await training.saveAttemptAsync(jsonReq.org, actor.person_id, {
                    course_code: jsonReq.course_code, module_id: jsonReq.module_id,
                    answers: jsonReq.answers, elapsed_seconds: jsonReq.elapsed_seconds,
                    client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "complete_module": {
                const result = await training.completeModuleAsync(jsonReq.org, actor.person_id, {
                    course_code: jsonReq.course_code, module_id: jsonReq.module_id,
                    elapsed_seconds: jsonReq.elapsed_seconds, client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "pass_course": {
                const result = await training.passCourseAsync(jsonReq.org, actor.person_id, jsonReq.course_code);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "certificates": {
                const result = await training.certificatesForPersonAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, certificates: result};
            }
            case "export_record": {
                const result = await training.exportRecordAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "track": {
                const result = await training.trackingAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "assign": {
                const result = await training.assignCourseAsync({
                    org_id: jsonReq.org, actor_person_id: actor.person_id,
                    subject_person_id: jsonReq.subject_person_id, course_code: jsonReq.course_code,
                    due_date: jsonReq.due_date, reason: jsonReq.reason, source_rule: jsonReq.source_rule});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "publish": {
                const result = await training.publishCourseAsync({
                    org_id: jsonReq.org, actor_person_id: actor.person_id,
                    course_code: jsonReq.course_code, title: jsonReq.title, kind: jsonReq.kind,
                    modules: jsonReq.modules, pass_mark: jsonReq.pass_mark,
                    validity_years: jsonReq.validity_years, jurisdictions: jsonReq.jurisdictions,
                    recommended_roles: jsonReq.recommended_roles, invalidates: jsonReq.invalidates,
                    reissue_days: jsonReq.reissue_days});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Training operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["verify", "catalogue", "course", "start_module", "save_attempt", "complete_module",
    "pass_course", "certificates", "export_record", "track", "assign", "publish"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) &&
    (jsonReq.op == "verify" ? jsonReq.code : jsonReq.id && jsonReq.org);
