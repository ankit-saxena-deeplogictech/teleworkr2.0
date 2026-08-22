/**
 * Q — the survey domain, and the anonymity contract it refuses to break.
 *
 * Q is the riskiest module in the wireframe set: a survey module that reported
 * engagement by name would undo everything M1–M4 refused, while looking
 * helpful. So the anonymity contract is structural rather than procedural (Q1):
 *
 *   - The mode is a property of the survey, fixed at publish, and it cannot
 *     change afterwards — the promise was made to people who have already
 *     answered.
 *   - attributed    the response links to the person and the invitation
 *   - confidential  the invitation is marked responded; responses carry only a
 *                   client-held token — no link back (the honest default)
 *   - anonymous     no invitation rows exist at all; a response count is the
 *                   only progress signal, and nobody can be reminded
 *
 * The results side inherits M3's mechanisms rather than re-deciding them (Q4):
 * a cohort floor enforced at query level, filters that would breach it refused
 * with an explanation, distributions and counts rather than averages, free text
 * readable by the named owner only with every read logged, and no comparison
 * between teams — it does not exist as a feature.
 *
 * Deferred honestly: digest reminders (they ride the A9 catalogue and land
 * with the reminder run), and close-mid-flow handling of partial answers (the
 * survey's stated setting is honoured by the runs module).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);

const MODES = Object.freeze(["attributed", "confidential", "anonymous"]);
const QUESTION_TYPES = Object.freeze(["scale", "choice", "text"]);
const COHORT_FLOOR = 5;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RESULTS_AFTER_DAYS = 10;

// The anonymity contract, in the respondent's words, on every screen (Q1 item 4).
const MODE_CONTRACT = Object.freeze({
    attributed: {label: "Attributed", promise:
        "Your name is attached to your answers. HR can see what you answered, linked to you."},
    confidential: {label: "Confidential", promise:
        "Confidential — aggregates only. Nobody sees your individual answers, including whoever wrote this survey."},
    anonymous: {label: "Anonymous", promise:
        "Anonymous — aggregates only, and not even that you responded. Nobody can remind you, and you cannot withdraw your answer afterwards because nothing links it to you."}
});
const FREE_TEXT_WARNING = "Details that identify you can't be removed after you send this.";

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);
const _uuid = _ => serverutils.generateUUID(false);

// ---------------------------------------------------------------------------
// publishing (Q5) — the event that fixes the anonymity mode
// ---------------------------------------------------------------------------

/**
 * Publishes a survey version, resolves its audience into invitations (never in
 * anonymous mode) and moves the pointer. The pre-publish checks run first and
 * are returned alongside — a cohort below the floor is warned, a free-text
 * question in a small cohort is warned, and a question that asks a respondent
 * to identify another named person blocks the publish outright (Q5): that needs
 * a grievance process, not a form.
 *
 * @param {object} request {org_id, actor_person_id, survey_code, title, mode,
 *      sections, audience, opens_on, closes_on, results_visible_to}
 * @returns {object} {survey_version_id, version, invited, warnings}
 */
exports.publishSurveyAsync = async function(request) {
    const survey = _validateSurvey(request);
    const checks = await _prePublishChecksAsync(request.org_id, survey);
    const blocking = checks.filter(check => check.severity == "block");
    if (blocking.length) throw Object.assign(new Error(
        `The survey cannot be published: ${blocking.map(c => c.message).join(" ")}`),
        {warnings: checks});
    const warnings = checks.filter(check => check.severity == "warn");

    // Resolved outside the transaction: a publish is a point-in-time event, and
    // the invitation set is captured as it stood at the decision.
    const invitedPeople = survey.mode == "anonymous" ? [] :
        await _resolveAudienceAsync(request.org_id, survey.audience);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "survey.publish",
        audit: {action: "survey.published", object_type: "survey",
            object_ref: request.survey_code,
            detail: {title: survey.title, mode: survey.mode, questions: survey.questionCount,
                invited: invitedPeople.length, warnings: warnings.map(w => w.code)}},

        action: async exec => {
            const current = await exec.getQuery(
                "SELECT * FROM survey_pointer WHERE org_id=? AND survey_code=?",
                [request.org_id, request.survey_code]);
            const versions = await exec.getQuery(
                "SELECT MAX(version) AS max FROM survey_version WHERE org_id=? AND survey_code=?",
                [request.org_id, request.survey_code]);
            const versionNumber = (versions[0].max || 0) + 1;

            const version = {survey_version_id: _uuid(), org_id: request.org_id,
                survey_code: request.survey_code, version: versionNumber, status: "published",
                title: survey.title, mode: survey.mode, sections: JSON.stringify(survey.sections),
                audience: JSON.stringify(survey.audience), opens_on: survey.opens_on,
                closes_on: survey.closes_on, owner_person_id: request.actor_person_id,
                results_visible_to: request.results_visible_to || "invited",
                owner_response: null, published_at: _now(), published_by: request.actor_person_id,
                results_published_at: null, withdrawn_at: null, withdrawn_reason: null,
                created_at: _now(), created_by: request.actor_person_id};
            await exec.runCmd(`INSERT INTO survey_version (survey_version_id, org_id, survey_code,
                    version, status, title, mode, sections, audience, opens_on, closes_on,
                    owner_person_id, results_visible_to, owner_response, published_at, published_by,
                    results_published_at, withdrawn_at, withdrawn_reason, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [version.survey_version_id, version.org_id, version.survey_code, version.version,
                    version.status, version.title, version.mode, version.sections, version.audience,
                    version.opens_on, version.closes_on, version.owner_person_id,
                    version.results_visible_to, version.owner_response, version.published_at,
                    version.published_by, version.results_published_at, version.withdrawn_at,
                    version.withdrawn_reason, version.created_at, version.created_by]);
            if (current.length) await exec.runCmd(
                "UPDATE survey_version SET status='closed' WHERE survey_version_id=? AND status='published'",
                [current[0].survey_version_id]);
            await exec.runCmd(
                `INSERT INTO survey_pointer (org_id, survey_code, survey_version_id, updated_at)
                    VALUES (?,?,?,?)
                    ON CONFLICT (org_id, survey_code) DO UPDATE SET survey_version_id=excluded.survey_version_id,
                        updated_at=excluded.updated_at`,
                [request.org_id, request.survey_code, version.survey_version_id, _now()]);

            for (const person of invitedPeople)
                await exec.runCmd(`INSERT INTO survey_invitation (invitation_id, org_id, person_id,
                        survey_code, survey_version_id, status, responded_at)
                        VALUES (?,?,?,?,?,?,?)`,
                    [_uuid(), request.org_id, person.person_id, request.survey_code,
                        version.survey_version_id, "invited", null]);

            return {survey_version_id: version.survey_version_id, version: versionNumber,
                invited: invitedPeople.length, warnings};
        }});
}

/**
 * Extends the close date — the ONLY field that may change after publish, and
 * the extension is announced rather than silent (Q5).
 */
exports.extendCloseAsync = async function(request) {
    const version = await _pointerVersionAsync(request.org_id, request.survey_code);
    if (!version) throw new Error(`No published survey ${request.survey_code}.`);
    _assertISODate(request.new_closes_on, "new_closes_on");
    if (request.new_closes_on <= version.closes_on) throw new Error(
        "The close date may only be extended, never brought forward.");
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "survey.publish",
        audit: {action: "survey.close_extended", object_type: "survey",
            object_ref: request.survey_code,
            detail: {closes_on: request.new_closes_on, from: version.closes_on}},
        action: async exec => {
            await exec.runCmd("UPDATE survey_version SET closes_on=? WHERE survey_version_id=?",
                [request.new_closes_on, version.survey_version_id]);
            return {survey_code: request.survey_code, closes_on: request.new_closes_on};
        }});
}

/**
 * Withdraws a survey: responses are destroyed, respondents are told (the audit
 * entry and the withdrawn record are how), and the withdrawal itself is logged
 * (Q5).
 */
exports.withdrawSurveyAsync = async function(request) {
    const version = await _pointerVersionAsync(request.org_id, request.survey_code);
    if (!version || version.status == "withdrawn") throw new Error(`No live survey ${request.survey_code}.`);
    if (!request.reason) throw new Error("A withdrawal needs a reason. It is announced, not silent.");
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "survey.publish", reason: request.reason,
        audit: {action: "survey.withdrawn", object_type: "survey",
            object_ref: request.survey_code, detail: {reason: request.reason}},
        action: async exec => {
            await exec.runCmd(
                "DELETE FROM survey_response_event WHERE org_id=? AND survey_version_id=?",
                [request.org_id, version.survey_version_id]);
            await exec.runCmd(
                "DELETE FROM survey_invitation WHERE org_id=? AND survey_version_id=?",
                [request.org_id, version.survey_version_id]);
            await exec.runCmd(
                "UPDATE survey_version SET status='withdrawn', withdrawn_at=?, withdrawn_reason=? WHERE survey_version_id=?",
                [_now(), request.reason, version.survey_version_id]);
            return {survey_code: request.survey_code, withdrawn: true};
        }});
}

// ---------------------------------------------------------------------------
// the respondent side (Q2 list, Q3 questionnaire)
// ---------------------------------------------------------------------------

/**
 * The list, and the brief (Q2). The brief answers the four questions people
 * actually have before starting one — who sees it, how long, is it optional,
 * what happens next. The anonymity mode is stated in the list, not only inside
 * the survey.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {object} tokens Client-held respondent tokens keyed by survey_code,
 *      so confidential/anonymous progress can be reported without a server link
 * @returns {object} {open: [...], closed: [...]}
 */
exports.listForPersonAsync = async function(org_id, person_id, tokens={}) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT v.* FROM survey_pointer p JOIN survey_version v ON v.survey_version_id = p.survey_version_id
            WHERE p.org_id=? AND v.status IN ('published','closed','results_published','withdrawn')
            ORDER BY v.published_at DESC`, [org_id]);
    const today = _today();
    const open = [], closed = [];
    for (const version of rows) {
        const matches = await _personMatchesAsync(org_id, person_id, _json(version.audience));
        const invitation = await _invitationForAsync(org_id, person_id, version);
        const asked = invitation || (version.mode == "anonymous" && matches);
        if (!asked && !matches) continue;      // this person was never asked

        const progress = await _progressForAsync(org_id, person_id, version, tokens[version.survey_code]);
        const card = {survey_code: version.survey_code, title: version.title,
            version: version.version, mode: version.mode, mode_contract: MODE_CONTRACT[version.mode],
            opens_on: version.opens_on, closes_on: version.closes_on,
            questions: version.sections ? _questionCount(_json(version.sections)) : 0,
            minutes: version.sections ? Math.ceil(_questionCount(_json(version.sections)) * 0.5) : 0,
            progress, brief: _brief(version),
            status: version.status, results_published_at: version.results_published_at};

        const isOpen = version.status == "published" && version.opens_on <= today && version.closes_on >= today;
        (isOpen ? open : closed).push(card);
    }
    return {open, closed};
}

/**
 * The questionnaire (Q3). The anonymity mode is restated in the footer of every
 * page — that is the thing a person is deciding to trust with each answer, not
 * once at the start. Required questions exist only when the survey is
 * attributed and operational.
 *
 * @returns {object} {survey, sections, progress, footer, required_remaining}
 */
exports.surveyForPersonAsync = async function(org_id, person_id, survey_code, token=null) {
    const version = await _pointerVersionAsync(org_id, survey_code);
    if (!version || version.status != "published") throw new Error(
        `Survey ${survey_code} is not open.`);
    const today = _today();
    if (version.opens_on > today) throw new Error(`Survey ${survey_code} opens on ${version.opens_on}.`);
    if (version.closes_on < today) throw new Error(`Survey ${survey_code} closed on ${version.closes_on}.`);
    await _assertAskedAsync(org_id, person_id, version, token);

    const sections = _json(version.sections).map(section => ({
        id: section.id, title: section.title,
        questions: section.questions.map(question => ({
            id: question.id, text: question.text, type: question.type,
            options: question.options || null, required: Boolean(question.required),
            free_text: Boolean(question.free_text)}))}));
    const progress = await _progressForAsync(org_id, person_id, version, token);
    const required = _requiredQuestions(sections);
    const requiredRemaining = required.filter(q => !progress.answered.includes(q.id)).length;

    return {survey: {survey_code: version.survey_code, title: version.title,
            mode: version.mode, closes_on: version.closes_on},
        sections, progress, required_remaining: requiredRemaining,
        footer: MODE_CONTRACT[version.mode].promise,
        free_text_warning: FREE_TEXT_WARNING,
        note: version.mode == "anonymous" ? "Nobody can be reminded, and the response rate is the only progress signal." : null};
}

/**
 * Saves one answer — save as you go (Q3 item 2). Skipping is a first-class
 * answer, recorded distinctly from not reaching the question. A question may be
 * required only when the survey is attributed; a required question cannot be
 * skipped. Idempotent on client_event_id.
 *
 * @returns The stored response event
 */
exports.saveAnswerAsync = async function(org_id, person_id, request) {
    const {survey_code, token, question_id, value, skipped, client_event_id} = request;
    const version = await _pointerVersionAsync(org_id, survey_code);
    if (!version || version.status != "published") throw new Error(`Survey ${survey_code} is not open.`);
    _assertOpen(version);
    await _assertAskedAsync(org_id, person_id, version, token);

    const question = _questionOf(version, question_id);
    if (skipped) {
        if (question.required) throw new Error(
            version.mode == "attributed" ?
                "This question is required. Skip is recorded for everything else — a forced-answer survey produces the middle option, which is worse than no data." :
                "A required question cannot be skipped, and required questions exist only in attributed surveys.");
    } else _validateValue(question, value);

    return await _insertResponseAsync(org_id, person_id, version, {
        kind: skipped ? "skipped" : "answer", section_id: null, question_id,
        value: skipped ? null : value, client_event_id,
        respondent_token: token});
};

/**
 * Submits. Every required question must be answered — the count of what is
 * missing is named, never a bare refusal. After submission, editability follows
 * from the mode and is stated: attributed answers may change until close;
 * confidential and anonymous answers cannot, because there is no link back,
 * which is the whole guarantee (Q3 item 5).
 *
 * @returns {object} {submitted, results_publish_on, editable}
 */
exports.submitSurveyAsync = async function(org_id, person_id, request) {
    const {survey_code, token} = request;
    const version = await _pointerVersionAsync(org_id, survey_code);
    if (!version || version.status != "published") throw new Error(`Survey ${survey_code} is not open.`);
    _assertOpen(version);
    await _assertAskedAsync(org_id, person_id, version, token);

    const progress = await _progressForAsync(org_id, person_id, version, token);
    const required = _requiredQuestions(_json(version.sections));
    const missing = required.filter(q => !progress.answered.includes(q.id));
    if (missing.length) throw new Error(
        `${missing.length} required question${missing.length == 1 ? "" : "s"} unanswered. Answer them before submitting.`);
    if (progress.submitted) throw new Error("This survey has already been submitted.");

    return await dblayer.runInTransactionAsync(async exec => {
        const event = await _insertResponseViaAsync(exec, org_id, person_id, version, {
            kind: "submitted", section_id: null, question_id: null, value: null,
            client_event_id: null, respondent_token: token});
        if (version.mode == "attributed") {
            const invitation = await _invitationForViaAsync(exec, org_id, person_id, version);
            if (invitation) await exec.runCmd(
                "UPDATE survey_invitation SET status='responded', responded_at=? WHERE invitation_id=?",
                [_now(), invitation.invitation_id]);
        } else if (version.mode == "confidential") {
            const invitation = await _invitationForViaAsync(exec, org_id, person_id, version);
            if (invitation) await exec.runCmd(
                "UPDATE survey_invitation SET status='responded', responded_at=? WHERE invitation_id=?",
                [_now(), invitation.invitation_id]);
        }
        // anonymous mode: no invitation row exists to mark — response count only.
        return {submitted: true, results_publish_on: _promisedResultsOn(version),
            editable: version.mode == "attributed"};
    });
};

// ---------------------------------------------------------------------------
// the results side (Q4) — aggregate by construction
// ---------------------------------------------------------------------------

/**
 * The results screen, which is M3 with different inputs (Q4). A cohort below
 * the floor does not render — below five, a distribution is a list of
 * individuals wearing a chart. Free text is readable by the named owner only,
 * and every such read is logged to H4.
 *
 * @param {object} request {org_id, actor_person_id, survey_code}
 * @returns {object} {survey, owner_response, distributions, free_text (owner
 *      only), response_rate, runs, floor_met}
 */
exports.resultsAsync = async function(request) {
    const version = await _pointerVersionAsync(request.org_id, request.survey_code);
    if (!version || !["closed", "results_published"].includes(version.status)) throw new Error(
        version?.status == "published" ?
            "The survey is still open. Partial results stay hidden entirely until close — visible partial results change later answers (Q4)." :
            `Survey ${request.survey_code} has no results to show.`);

    const isOwner = request.actor_person_id == version.owner_person_id;
    const holdsPublish = Boolean((await permissions.activeGrantsAsync(request.org_id,
        request.actor_person_id, {capability: "survey.publish"})).length);
    if (!isOwner && !holdsPublish && !(await _invitationForAsync(request.org_id,
        request.actor_person_id, version)))
        await _assertAskedAsync(request.org_id, request.actor_person_id, version, null);

    const responded = await _respondedCountAsync(request.org_id, version);
    if (responded < COHORT_FLOOR) throw Object.assign(new Error(
        `Cohort ${responded} — below the floor of ${COHORT_FLOOR}. A distribution below five is a list of individuals wearing a chart, so this panel does not render.`),
        {floor_met: false, responded, floor: COHORT_FLOOR});

    const events = await dblayer.getQueryOrThrow(
        "SELECT * FROM survey_response_event WHERE org_id=? AND survey_version_id=?",
        [request.org_id, version.survey_version_id]);
    const distributions = _distributions(_json(version.sections), events, version.mode);

    let freeText = null;
    if (isOwner) {
        freeText = _freeTextAnswers(_json(version.sections), events);
        await audit.writeAsync({org_id: request.org_id, action: "survey.free_text_read",
            object_type: "survey", object_ref: request.survey_code,
            actor_person_id: request.actor_person_id,
            detail: {count: freeText.length}});    // owner-only, logged every time (Q4 item 4)
    }

    const invitations = version.mode == "anonymous" ? null :
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM survey_invitation WHERE org_id=? AND survey_version_id=?",
            [request.org_id, version.survey_version_id]))[0].c;
    const runs = (await dblayer.getQueryOrThrow(
        `SELECT COUNT(DISTINCT version) AS c FROM survey_version
            WHERE org_id=? AND survey_code=? AND status IN ('closed','results_published')`,
        [request.org_id, request.survey_code]))[0].c;

    return {survey: {survey_code: version.survey_code, title: version.title,
            mode: version.mode, closes_on: version.closes_on,
            results_published_at: version.results_published_at},
        owner_response: version.owner_response || null,
        owner_response_missing: version.status == "results_published" && !version.owner_response,
        distributions, free_text: freeText, floor_met: true,
        response_rate: {invited: invitations, responded,
            rate: invitations ? Math.round(responded / Math.max(invitations, 1) * 100) : null},
        runs};
};

/**
 * Publishes the results (Q5 item 3, Q4 item 6). The owner writes a short
 * response BEFORE results publish — publishing without one is possible and is
 * flagged here as the most reliable way to reduce the next response rate.
 *
 * @param {object} request {org_id, actor_person_id, survey_code, owner_response}
 * @returns {object} {results_published, owner_response_missing}
 */
exports.publishResultsAsync = async function(request) {
    const version = await _pointerVersionAsync(request.org_id, request.survey_code);
    if (!version || !["closed", "results_published"].includes(version.status)) throw new Error(
        `Survey ${request.survey_code} cannot publish results while it is open.`);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "survey.publish",
        audit: {action: "survey.results_published", object_type: "survey",
            object_ref: request.survey_code, detail: {}},

        action: async exec => {
            const ownerResponse = (request.owner_response || "").trim();
            if (ownerResponse) await exec.runCmd(
                "UPDATE survey_version SET owner_response=? WHERE survey_version_id=?",
                [ownerResponse, version.survey_version_id]);
            await exec.runCmd(
                "UPDATE survey_version SET status='results_published', results_published_at=? WHERE survey_version_id=?",
                [_now(), version.survey_version_id]);
            return {results_published: true,
                owner_response_missing: !ownerResponse && !version.owner_response};
        }});
};

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function _validateSurvey(request) {
    if (!request?.title || typeof request.title != "string") throw new Error("A survey needs a title.");
    if (!request.survey_code || !/^[a-z0-9-]{2,64}$/.test(request.survey_code)) throw new Error(
        "survey_code must be lowercase letters, digits and dashes (2-64).");
    if (!MODES.includes(request.mode)) throw new Error(
        `mode must be one of ${MODES.join(", ")} — it is fixed at publish and can never change afterwards.`);
    const sections = request.sections;
    if (!Array.isArray(sections) || !sections.length) throw new Error("A survey needs at least one section.");
    const ids = new Set();
    for (const section of sections) {
        if (!section?.id || !section?.title) throw new Error("Every section needs an id and a title.");
        if (!Array.isArray(section.questions) || !section.questions.length) throw new Error(
            `Section ${section.id} needs at least one question.`);
        for (const question of section.questions) {
            if (!question?.id || !question?.text) throw new Error(`Section ${section.id} has a question without id or text.`);
            if (ids.has(question.id)) throw new Error(`Duplicate question id ${question.id}.`);
            ids.add(question.id);
            if (!QUESTION_TYPES.includes(question.type)) throw new Error(
                `Question ${question.id}: type must be one of ${QUESTION_TYPES.join(", ")}.`);
            if (question.type != "text" && (!Array.isArray(question.options) || question.options.length < 2))
                throw new Error(`Question ${question.id} needs at least two options.`);
            if (question.type == "text") question.free_text = true;   // text IS free text
        }
    }
    _assertISODate(request.opens_on, "opens_on"); _assertISODate(request.closes_on, "closes_on");
    if (request.closes_on <= request.opens_on) throw new Error("closes_on must be after opens_on.");
    if (!request.audience || typeof request.audience != "object") throw new Error("A survey needs an audience rule.");
    request.questionCount = sections.reduce((sum, s) => sum + s.questions.length, 0);
    return request;
}

/**
 * The Q5 pre-publish checks. A cohort below the floor is warned (their results
 * will never render), free text in a small cohort is warned, and a question
 * that asks a respondent to name another person blocks — that turns a survey
 * into an anonymous reporting channel, which needs a grievance process.
 */
async function _prePublishChecksAsync(org_id, survey) {
    const checks = [];
    const questions = survey.sections.flatMap(section => section.questions);
    const hasFreeText = questions.some(question => question.type == "text" || question.free_text);
    for (const question of questions) {
        if (/which of your|who (is|was)|colleague|co-worker|coworker|another named person|identify (a|the) person/i.test(question.text))
            checks.push({severity: "block", code: "names_people",
                message: `Question "${question.text}" asks a respondent to identify another named person. That turns a survey into an anonymous reporting channel — it needs a grievance process, not a form.`});
    }

    const audience = survey.audience;
    const roster = await spine.rosterAsOfAsync(org_id);
    let matching = 0;
    for (const person of roster) {
        const employment = await spine.employmentAsOfAsync(org_id, person.person_id);
        if (!employment) continue;
        const roles = new Set((await permissions.activeGrantsAsync(org_id, person.person_id))
            .map(grant => grant.source_role).filter(Boolean));
        if (_matchesAudience(employment, roles, audience)) matching++;
    }
    if (survey.mode != "anonymous" && matching < COHORT_FLOOR) checks.push({severity: "warn", code: "cohort_below_floor",
        message: `One audience group has ${matching} people. Their results will never render. Merge the group or accept that it is write-only.`});
    if (hasFreeText && matching > 0 && matching <= 8) checks.push({severity: "warn", code: "free_text_small_cohort",
        message: "Free-text questions in cohorts of 6–8 are flagged: respondents will be warned, and you should expect thin answers."});
    return checks;
}

async function _resolveAudienceAsync(org_id, audience) {
    const roster = await spine.rosterAsOfAsync(org_id);
    const invited = [];
    for (const person of roster) {
        const employment = await spine.employmentAsOfAsync(org_id, person.person_id);
        if (!employment) continue;
        const roles = new Set((await permissions.activeGrantsAsync(org_id, person.person_id))
            .map(grant => grant.source_role).filter(Boolean));
        if (_matchesAudience(employment, roles, audience)) invited.push(person);
    }
    return invited;
}

function _matchesAudience(employment, roles, audience) {
    if (!employment) return false;
    if (audience.jurisdictions?.length && !audience.jurisdictions.includes(employment.jurisdiction)) return false;
    if (audience.contract_types?.length && !audience.contract_types.includes(employment.contract_type)) return false;
    if (!audience.include_contractors && employment.contract_type != "employee") return false;
    if (audience.roles?.length && !audience.roles.some(role => roles.has(role))) return false;
    return true;
}

async function _personMatchesAsync(org_id, person_id, audience) {
    const employment = await spine.employmentAsOfAsync(org_id, person_id);
    const roles = new Set((await permissions.activeGrantsAsync(org_id, person_id))
        .map(grant => grant.source_role).filter(Boolean));
    return _matchesAudience(employment, roles, audience);
}

async function _assertAskedAsync(org_id, person_id, version, token) {
    const audience = _json(version.audience);
    const matches = await _personMatchesAsync(org_id, person_id, audience);
    if (version.mode == "anonymous") {if (!matches) throw new Error("This survey was not addressed to you."); return;}
    const invitation = await _invitationForAsync(org_id, person_id, version);
    if (!invitation && !matches) throw new Error("This survey was not addressed to you.");
}

async function _invitationForAsync(org_id, person_id, version) {
    return await _invitationForViaAsync(null, org_id, person_id, version);
}

async function _invitationForViaAsync(exec, org_id, person_id, version) {
    const sql = `SELECT * FROM survey_invitation WHERE org_id=? AND person_id=? AND survey_version_id=?
        ORDER BY invitation_id ASC LIMIT 1`;
    const rows = exec ? await exec.getQuery(sql, [org_id, person_id, version.survey_version_id]) :
        await dblayer.getQueryOrThrow(sql, [org_id, person_id, version.survey_version_id]);
    return rows.length ? rows[0] : null;
}

async function _progressForAsync(org_id, person_id, version, token) {
    const rows = await dblayer.getQueryOrThrow(
        version.mode == "attributed" ?
            "SELECT * FROM survey_response_event WHERE org_id=? AND survey_version_id=? AND person_id=?"
                + " AND kind IN ('answer','skipped') ORDER BY recorded_at ASC" :
            "SELECT * FROM survey_response_event WHERE org_id=? AND survey_version_id=? AND respondent_token=?"
                + " AND kind IN ('answer','skipped') ORDER BY recorded_at ASC",
        version.mode == "attributed" ? [org_id, version.survey_version_id, person_id] :
            [org_id, version.survey_version_id, token || ""]);
    const answered = [], skipped = [];
    for (const row of rows) (row.kind == "skipped" ? skipped : answered).push(row.question_id);
    const submitted = await _submittedAsync(org_id, person_id, version, token);
    return {answered, skipped, answered_count: answered.length,
        question_total: _questionCount(_json(version.sections)), submitted};
}

async function _submittedAsync(org_id, person_id, version, token) {
    const rows = await dblayer.getQueryOrThrow(
        version.mode == "attributed" ?
            "SELECT response_event_id FROM survey_response_event WHERE org_id=? AND survey_version_id=? AND person_id=?"
                + " AND kind='submitted' LIMIT 1" :
            "SELECT response_event_id FROM survey_response_event WHERE org_id=? AND survey_version_id=? AND respondent_token=?"
                + " AND kind='submitted' LIMIT 1",
        version.mode == "attributed" ? [org_id, version.survey_version_id, person_id] :
            [org_id, version.survey_version_id, token || ""]);
    return Boolean(rows.length);
}

async function _respondedCountAsync(org_id, version) {
    if (version.mode == "anonymous") {
        const rows = await dblayer.getQueryOrThrow(
            "SELECT COUNT(DISTINCT respondent_token) AS c FROM survey_response_event WHERE org_id=?"
                + " AND survey_version_id=? AND kind='submitted'",
            [org_id, version.survey_version_id]);
        return rows[0].c;
    }
    const rows = await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM survey_invitation WHERE org_id=? AND survey_version_id=? AND status='responded'",
        [org_id, version.survey_version_id]);
    return rows[0].c;
}

async function _insertResponseAsync(org_id, person_id, version, spec) {
    return await dblayer.runInTransactionAsync(async exec =>
        await _insertResponseViaAsync(exec, org_id, person_id, version, spec));
}

async function _insertResponseViaAsync(exec, org_id, person_id, version, spec) {
    if (spec.client_event_id) {
        const existing = await exec.getQuery(
            "SELECT * FROM survey_response_event WHERE org_id=? AND client_event_id=?",
            [org_id, spec.client_event_id]);
        if (existing.length) return existing[0];
    }
    const attributed = version.mode == "attributed";
    const invitation = attributed ? await _invitationForViaAsync(exec, org_id, person_id, version) : null;
    if (version.mode != "attributed" && !spec.respondent_token) throw new Error(
        "This survey's answers carry a resume token you hold. Supply the token — the server keeps no link back to you.");
    const event = {response_event_id: _uuid(), org_id, person_id: attributed ? person_id : null,
        survey_code: version.survey_code, survey_version_id: version.survey_version_id,
        invitation_id: invitation?.invitation_id || null,
        respondent_token: attributed ? null : spec.respondent_token,
        kind: spec.kind, section_id: spec.section_id, question_id: spec.question_id,
        value: spec.value === undefined || spec.value === null ? null : JSON.stringify(spec.value),
        client_event_id: spec.client_event_id || null, recorded_at: _now()};
    try {
        await exec.runCmd(`INSERT INTO survey_response_event (response_event_id, org_id, person_id,
                survey_code, survey_version_id, invitation_id, respondent_token, kind, section_id,
                question_id, value, client_event_id, recorded_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [event.response_event_id, event.org_id, event.person_id, event.survey_code,
                event.survey_version_id, event.invitation_id, event.respondent_token, event.kind,
                event.section_id, event.question_id, event.value, event.client_event_id, event.recorded_at]);
    } catch (err) {
        if (spec.client_event_id) {
            const raced = await exec.getQuery(
                "SELECT * FROM survey_response_event WHERE org_id=? AND client_event_id=?",
                [org_id, spec.client_event_id]);
            if (raced.length) return raced[0];
        }
        throw err;
    }
    return event;
}

function _questionOf(version, question_id) {
    const question = _json(version.sections).flatMap(s => s.questions).find(q => q.id == question_id);
    if (!question) throw new Error(`Question ${question_id} is not part of ${version.survey_code}.`);
    return question;
}

function _validateValue(question, value) {
    if (question.type == "text") {
        if (typeof value != "string" || !value.trim()) throw new Error(`Question ${question.id} needs an answer.`);
        return;
    }
    const options = question.options || [];
    if (question.type == "scale") {
        if (!Number.isInteger(value) || !options.some(option => option.value === value)) throw new Error(
            `Question ${question.id}: the answer must be one of the scale points.`);
    } else if (!options.some(option => option.code === value)) throw new Error(
        `Question ${question.id}: the answer must be one of the offered options.`);
}

function _requiredQuestions(sections) {
    return sections.flatMap(section => section.questions).filter(q => q.required);
}

/** Q4: counts, never averages. A mean of 3.2 hides the split — the split is the finding. */
function _distributions(sections, events, mode) {
    const answered = new Map(events.filter(e => e.kind == "answer")
        .map(e => [e.question_id, _json(e.value)]));
    const distributions = [];
    for (const section of sections) for (const question of section.questions) {
        if (question.type == "text") continue;         // free text never renders as a distribution
        const counts = Object.fromEntries(question.options.map(option =>
            [option.code || String(option.value), {value: option.code || option.value,
                label: option.label || String(option.value), count: 0}]));
        let respondedTo = 0;
        for (const [id, value] of answered) if (id == question.id) {
            const key = String(value); respondedTo++;
            if (counts[key]) counts[key].count++;
        }
        distributions.push({question_id: question.id, text: question.text,
            counts: Object.values(counts), responded: respondedTo});
    }
    return distributions;
}

function _freeTextAnswers(sections, events) {
    const textQuestions = new Set(sections.flatMap(s => s.questions)
        .filter(q => q.type == "text" || q.free_text).map(q => q.id));
    return events.filter(e => e.kind == "answer" && textQuestions.has(e.question_id))
        .map(e => ({question_id: e.question_id, value: _json(e.value)}));
}

function _brief(version) {
    return {
        who_sees: version.mode == "attributed" ?
            "Your name against your answers — HR sees what you answered." :
            version.mode == "confidential" ?
                "Aggregates to your lead and HR. Nobody sees your individual answers, including whoever wrote this survey." :
                "Aggregates only. Not even that you responded — nobody can remind you.",
        minutes: Math.ceil(_questionCount(_json(version.sections)) * 0.5),
        optional: "Yes. Not answering is recorded as not answering, and nothing else follows from it.",
        what_happens_next: `Results are published to everyone who was asked, by ${_promisedResultsOn(version)}, with what's being done about them.`,
        reminders: version.mode == "anonymous" ? "None. In anonymous mode nobody knows who to remind." :
            "At most two, both quiet digest rows, never an interrupt."};
}

function _promisedResultsOn(version) {
    const d = new Date(`${version.closes_on}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + RESULTS_AFTER_DAYS);
    return d.toISOString().substring(0, 10);
}

function _assertOpen(version) {
    const today = _today();
    if (version.opens_on > today) throw new Error(`The survey opens on ${version.opens_on}.`);
    if (version.closes_on < today) throw new Error(`The survey closed on ${version.closes_on}.`);
}

function _assertISODate(date, label="date") {
    if ((typeof date != "string") || (!ISO_DATE.test(date))) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

async function _pointerVersionAsync(org_id, survey_code) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT v.* FROM survey_pointer p JOIN survey_version v ON v.survey_version_id = p.survey_version_id
            WHERE p.org_id=? AND p.survey_code=?`, [org_id, survey_code]);
    return rows.length ? rows[0] : null;
}

const _questionCount = sections => sections.reduce((sum, section) => sum + section.questions.length, 0);
const _json = value => {if (!value) return null; try {return JSON.parse(value);} catch {return null;}};

exports.MODES = MODES;
exports.MODE_CONTRACT = MODE_CONTRACT;
exports.COHORT_FLOOR = COHORT_FLOOR;
exports.FREE_TEXT_WARNING = FREE_TEXT_WARNING;
