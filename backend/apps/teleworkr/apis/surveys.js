/**
 * The surveys API — Q. The actor is the token's id (their email).
 *
 * Operations:
 *  op - list            - Q2: open surveys with the brief, and the closed list
 *  op - survey          - Q3: the questionnaire, mode restated on every page
 *  op - save_answer     - Q3: save as you go; skip is a first-class answer
 *  op - submit          - Q3: named missing count, editability follows the mode
 *  op - results         - Q4: aggregate by construction, floor enforced
 *  op - publish         - Q5: publish a survey; fixes the anonymity mode
 *  op - extend_close    - Q5: the only field that may change after publish
 *  op - publish_results - Q5/Q4: results, with the owner response
 *  op - withdraw        - Q5: responses destroyed, withdrawal logged
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const surveys = require(`${TELEWORKR_CONSTANTS.LIBDIR}/surveys.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "list": {
                const result = await surveys.listForPersonAsync(jsonReq.org, actor.person_id, jsonReq.tokens || {});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "survey": {
                const result = await surveys.surveyForPersonAsync(jsonReq.org, actor.person_id,
                    jsonReq.survey_code, jsonReq.token || null);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "save_answer": {
                const result = await surveys.saveAnswerAsync(jsonReq.org, actor.person_id, {
                    survey_code: jsonReq.survey_code, token: jsonReq.token || null,
                    question_id: jsonReq.question_id, value: jsonReq.value,
                    skipped: jsonReq.skipped === true, client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "submit": {
                const result = await surveys.submitSurveyAsync(jsonReq.org, actor.person_id, {
                    survey_code: jsonReq.survey_code, token: jsonReq.token || null});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "results": {
                const result = await surveys.resultsAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, survey_code: jsonReq.survey_code});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "publish": {
                const result = await surveys.publishSurveyAsync({
                    org_id: jsonReq.org, actor_person_id: actor.person_id,
                    survey_code: jsonReq.survey_code, title: jsonReq.title, mode: jsonReq.mode,
                    sections: jsonReq.sections, audience: jsonReq.audience,
                    opens_on: jsonReq.opens_on, closes_on: jsonReq.closes_on,
                    results_visible_to: jsonReq.results_visible_to});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "extend_close": {
                const result = await surveys.extendCloseAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, survey_code: jsonReq.survey_code,
                    new_closes_on: jsonReq.new_closes_on});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "publish_results": {
                const result = await surveys.publishResultsAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, survey_code: jsonReq.survey_code,
                    owner_response: jsonReq.owner_response});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "withdraw": {
                const result = await surveys.withdrawSurveyAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, survey_code: jsonReq.survey_code,
                    reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Survey operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["list", "survey", "save_answer", "submit", "results", "publish",
    "extend_close", "publish_results", "withdraw"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
