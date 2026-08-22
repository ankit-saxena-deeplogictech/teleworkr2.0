/**
 * Tests Q — the survey domain's backend, and the anonymity contract it refuses
 * to break: the mode is fixed at publish, confidential responses carry no link
 * back to the person, anonymous mode writes no invitation at all, the cohort
 * floor is enforced at query level, distributions are counts never averages,
 * and free text is owner-only with every read logged.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests surveys
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const surveys = require(`${TELEWORKR_CONSTANTS.LIBDIR}/surveys.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Survey test failed: ${label} ${detail||""}`);}
}

const _today = () => new Date().toISOString().substring(0, 10);
const _inDays = days => new Date(Date.now() + days*86400000).toISOString().substring(0, 10);

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 90)}`, true);}
}

const _sections = () => [
    {id: "s1", title: "Working patterns",
        questions: [
            {id: "q1", text: "My working hours suit the way my team works.", type: "scale",
                options: [{value: 1, label: "1 disagree"}, {value: 2, label: "2"},
                    {value: 3, label: "3 neutral"}, {value: 4, label: "4"}, {value: 5, label: "5 agree"}]},
            {id: "q2", text: "Which of these blocks you most often?", type: "choice",
                options: [{code: "a", text: "Meetings"}, {code: "b", text: "Approvals"},
                    {code: "c", text: "Tooling"}], free_text: false},
            {id: "q3", text: "Anything you'd change about how the team overlaps?", type: "text"}]},
    {id: "s2", title: "Load",
        questions: [{id: "q4", text: "I know what I'm meant to be working on.", type: "scale",
            options: [{value: 1, label: "1 disagree"}, {value: 2, label: "2"},
                {value: 3, label: "3 neutral"}, {value: 4, label: "4"}, {value: 5, label: "5 agree"}]}]}
];

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "surveys")) {
        LOG.console("Skipping surveys test case, not called.\n"); return true;
    }
    LOG.console("\nQ surveys\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testPublish(w);
        await _testModes(w);
        await _testQuestionnaire(w);
        await _testResults(w);
        await _testOwnerActions(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  survey tests threw: ${err}\n`); LOG.error(`Survey tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nSurvey tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** Q5: publish, pre-publish checks, the anonymity mode is fixed by the event. */
async function _testPublish(w) {
    LOG.console("\n publishing surveys\n");
    await _checkThrows("a question naming another person blocks publish",
        _ => surveys.publishSurveyAsync({org_id: w.org_id, actor_person_id: w.carol,
            survey_code: "who-is", title: "Who is it", mode: "confidential",
            sections: [{id: "s", title: "S", questions: [{id: "q", text: "Which of your colleagues should be promoted?",
                type: "text"}]}], audience: {contract_types: ["employee"]},
            opens_on: _today(), closes_on: _inDays(5)}));

    const published = await surveys.publishSurveyAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "checkin", title: "Quarterly team check-in", mode: "confidential",
        sections: _sections(), audience: {contract_types: ["employee"]},
        opens_on: _today(), closes_on: _inDays(5)});
    _check("a confidential publish resolves invitations for everyone asked",
        published.invited == 6 && published.version == 1, JSON.stringify(published));
    _check("no warning for a cohort above the floor",
        !published.warnings.some(warning => warning.code == "cohort_below_floor"),
        JSON.stringify(published.warnings));

    const tiny = await surveys.publishSurveyAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "tiny", title: "Lead pulse", mode: "confidential",
        sections: _sections(), audience: {roles: ["lead"]},
        opens_on: _today(), closes_on: _inDays(5)});
    _check("a cohort below the floor is warned, not silently made",
        tiny.invited == 1 && tiny.warnings.some(warning => warning.code == "cohort_below_floor"),
        JSON.stringify(tiny.warnings));

    const anon = await surveys.publishSurveyAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "culture", title: "Culture, honestly", mode: "anonymous",
        sections: _sections(), audience: {contract_types: ["employee"]},
        opens_on: _today(), closes_on: _inDays(5)});
    _check("an anonymous publish writes no invitation rows at all",
        anon.invited == 0 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM survey_invitation WHERE org_id=? AND survey_code='culture'",
            [w.org_id]))[0].c == 0);
}

/** Q1: what each mode actually promises — structurally, not procedurally. */
async function _testModes(w) {
    LOG.console("\n the anonymity modes\n");
    const confidential = await surveys.surveyForPersonAsync(w.org_id, w.alice, "checkin", "alice-token");
    _check("the questionnaire restates the mode on every page",
        /Nobody sees your individual answers/.test(confidential.footer) &&
        confidential.survey.mode == "confidential", JSON.stringify(confidential.footer));

    await _checkThrows("confidential answers need the client-held token",
        _ => surveys.saveAnswerAsync(w.org_id, w.alice, {survey_code: "checkin",
            question_id: "q1", value: 4, client_event_id: "no-token"}));

    await surveys.saveAnswerAsync(w.org_id, w.alice, {survey_code: "checkin", token: "alice-token",
        question_id: "q1", value: 4, client_event_id: "alice-q1"});
    const stored = (await dblayer.getQueryOrThrow(
        "SELECT * FROM survey_response_event WHERE org_id=? AND client_event_id='alice-q1'",
        [w.org_id]))[0];
    _check("a confidential answer carries no link back to the person",
        stored.person_id === null && stored.invitation_id === null &&
        stored.respondent_token == "alice-token", JSON.stringify(stored));

    const replay = await surveys.saveAnswerAsync(w.org_id, w.alice, {survey_code: "checkin",
        token: "alice-token", question_id: "q1", value: 4, client_event_id: "alice-q1"});
    _check("an answer replay returns the stored event, not a duplicate",
        replay.response_event_id == stored.response_event_id &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM survey_response_event WHERE org_id=? AND client_event_id='alice-q1'",
            [w.org_id]))[0].c == 1);

    await _checkThrows("a survey addressed only to leads refuses everyone else",
        _ => surveys.surveyForPersonAsync(w.org_id, w.alice, "tiny", "alice-token"));
}

/** Q3: save as you go, skip is a first-class answer, editability follows the mode. */
async function _testQuestionnaire(w) {
    LOG.console("\n the questionnaire\n");
    const attributed = await surveys.publishSurveyAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "office", title: "Office days — Q3", mode: "attributed",
        sections: [{id: "s", title: "S", questions: [
            {id: "day", text: "Which days would you come in?", type: "choice", required: true,
                options: [{code: "mon", text: "Monday"}, {code: "tue", text: "Tuesday"}]},
            {id: "note", text: "Anything else?", type: "text"}]}],
        audience: {contract_types: ["employee"]},
        opens_on: _today(), closes_on: _inDays(5)});
    _check("attributed mode resolved invitations", attributed.invited == 6, JSON.stringify(attributed));

    await _checkThrows("a required question cannot be skipped in an attributed survey",
        _ => surveys.saveAnswerAsync(w.org_id, w.erin, {survey_code: "office",
            question_id: "day", skipped: true, client_event_id: "skip-required"}));

    await surveys.saveAnswerAsync(w.org_id, w.erin, {survey_code: "office",
        question_id: "note", skipped: true, client_event_id: "skip-note"});
    await surveys.saveAnswerAsync(w.org_id, w.erin, {survey_code: "office",
        question_id: "day", value: "tue", client_event_id: "answer-day"});
    _check("skip is recorded distinctly from not reaching the question",
        (await dblayer.getQueryOrThrow(
            "SELECT kind, question_id FROM survey_response_event WHERE org_id=? AND client_event_id='skip-note'",
            [w.org_id]))[0].kind == "skipped");

    await _checkThrows("submitting with a required question unanswered names the count",
        _ => surveys.submitSurveyAsync(w.org_id, w.alice, {survey_code: "office"}));

    const submitted = await surveys.submitSurveyAsync(w.org_id, w.erin, {survey_code: "office"});
    _check("submission states editability follows from the mode",
        submitted.submitted === true && submitted.editable === true, JSON.stringify(submitted));
    const erinLink = (await dblayer.getQueryOrThrow(
        `SELECT e.* FROM survey_response_event e WHERE e.org_id=? AND e.client_event_id='answer-day'`,
        [w.org_id]))[0];
    _check("an attributed answer links the person and the invitation",
        erinLink.person_id == w.erin && erinLink.invitation_id, JSON.stringify(erinLink));

    const confidentialSubmit = await surveys.submitSurveyAsync(w.org_id, w.alice,
        {survey_code: "checkin", token: "alice-token"});
    _check("a confidential submission is final — no link back, no editing",
        confidentialSubmit.editable === false &&
        (await dblayer.getQueryOrThrow(
            "SELECT status FROM survey_invitation WHERE org_id=? AND person_id=? AND survey_code='checkin'",
            [w.org_id, w.alice]))[0].status == "responded");
}

/** Q4: aggregate by construction — the floor, counts, and owner-only free text. */
async function _testResults(w) {
    LOG.console("\n results\n");
    await _checkThrows("results stay hidden while the survey is open",
        _ => surveys.resultsAsync({org_id: w.org_id, actor_person_id: w.alice, survey_code: "checkin"}));

    // the tiny survey is closed with zero responses — the floor refusal is its state
    await dblayer.runCmdOrThrow(
        "UPDATE survey_version SET status='closed' WHERE org_id=? AND survey_code='tiny'",
        [w.org_id]);
    const refused = await (async _ => {try {
        await surveys.resultsAsync({org_id: w.org_id, actor_person_id: w.bob, survey_code: "tiny"});
        return null;} catch (err) {return err;}})();
    _check("a cohort below the floor refuses with the floor named",
        /below the floor of 5/.test(refused?.message || "") && refused?.floor_met === false,
        refused?.message);

    // four more people answer and submit confidentially, on their own tokens
    for (const [who, token] of [["bob", "bob-token"], ["erin", "erin-token"],
        ["frank", "frank-token"], ["dave", "dave-token"]])
        await surveys.submitSurveyAsync(w.org_id, w[who], {survey_code: "checkin", token});

    // close the survey — the close run is the runs module's job, this is the state it lands in
    await dblayer.runCmdOrThrow(
        "UPDATE survey_version SET status='closed' WHERE org_id=? AND survey_code='checkin'",
        [w.org_id]);

    const results = await surveys.resultsAsync({org_id: w.org_id, actor_person_id: w.alice,
        survey_code: "checkin"});
    _check("five responses meet the floor and render",
        results.floor_met === true && results.response_rate.responded == 5,
        JSON.stringify(results.response_rate));
    const q1 = results.distributions.find(dist => dist.question_id == "q1");
    _check("distributions are counts, never averages",
        q1 && q1.counts.every(c => Number.isInteger(c.count)) && !("average" in results),
        JSON.stringify(q1));
    _check("free text is never handed to a non-owner",
        results.free_text === null);

    const owner = await surveys.resultsAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "checkin"});
    _check("the owner reads free text, and the read is logged",
        Array.isArray(owner.free_text) &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM audit_event WHERE org_id=? AND action='survey.free_text_read' AND actor_person_id=?",
            [w.org_id, w.carol]))[0].c == 1);

    // five anonymous respondents: tokens only, nobody knows who to remind
    for (const token of ["t1", "t2", "t3", "t4", "t5"]) {
        await surveys.saveAnswerAsync(w.org_id, w.frank, {survey_code: "culture", token,
            question_id: "q1", value: 3, client_event_id: `cult-${token}-q1`});
        await surveys.submitSurveyAsync(w.org_id, w.frank, {survey_code: "culture", token});
    }
    await dblayer.runCmdOrThrow(
        "UPDATE survey_version SET status='closed' WHERE org_id=? AND survey_code='culture'",
        [w.org_id]);
    const anonResults = await surveys.resultsAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "culture"});
    _check("anonymous mode reports the response count without invitations",
        anonResults.floor_met === true && anonResults.response_rate.responded == 5 &&
        anonResults.response_rate.invited === null, JSON.stringify(anonResults.response_rate));
}

/** Q5: the owner's tools — extension, results publish with the response, withdrawal. */
async function _testOwnerActions(w) {
    LOG.console("\n the owner's tools\n");
    await _checkThrows("the close date can only be extended",
        _ => surveys.extendCloseAsync({org_id: w.org_id, actor_person_id: w.carol,
            survey_code: "checkin", new_closes_on: _inDays(1)}));
    const extended = await surveys.extendCloseAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "checkin", new_closes_on: _inDays(7)});
    _check("an extension is the one post-publish edit, and it is announced",
        extended.closes_on == _inDays(7) &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM audit_event WHERE org_id=? AND action='survey.close_extended'",
            [w.org_id]))[0].c >= 1);

    const published = await surveys.publishResultsAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "checkin", owner_response: "The 08:30 sync lands outside two people's windows. Rotating from next month."});
    _check("results publish with the owner response",
        published.results_published === true && published.owner_response_missing === false,
        JSON.stringify(published));
    const version = (await dblayer.getQueryOrThrow(
        "SELECT status, owner_response FROM survey_version WHERE org_id=? AND survey_code='checkin'",
        [w.org_id]))[0];
    _check("the owner response is part of the published record",
        version.status == "results_published" && /08:30/.test(version.owner_response));

    const withdrawn = await surveys.withdrawSurveyAsync({org_id: w.org_id, actor_person_id: w.carol,
        survey_code: "office", reason: "The question set was wrong."});
    _check("withdrawal destroys responses and is logged",
        withdrawn.withdrawn === true &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM survey_response_event WHERE org_id=? AND survey_code='office'",
            [w.org_id]))[0].c == 0 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM audit_event WHERE org_id=? AND action='survey.withdrawn'",
            [w.org_id]))[0].c >= 1);

    const list = await surveys.listForPersonAsync(w.org_id, w.alice, {checkin: "alice-token"});
    _check("the list carries the brief and states the mode",
        list.closed.some(survey => survey.survey_code == "checkin" &&
            survey.mode == "confidential" &&
            /Results are published/.test(survey.brief.what_happens_next)),
        JSON.stringify(list.closed.map(s => s.survey_code)));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Survey test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin", "frank"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of [["alice", "employee"], ["bob", "lead"], ["carol", "hr"],
        ["dave", "admin"], ["erin", "employee"], ["frank", "employee"]])
        await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(
        Object.entries(people).map(([name, person]) => [name, person.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["survey_response_event", "survey_invitation", "survey_pointer", "survey_version",
        "course_progress_event", "certificate", "course_assignment", "course_pointer", "course_version"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM task WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM working_window WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin", "frank"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
