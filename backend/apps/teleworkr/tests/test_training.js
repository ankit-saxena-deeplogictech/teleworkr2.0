/**
 * Tests P — the training & certificates backend: versioned course publish with
 * the publisher's stated invalidation choice, assignment with a visible reason,
 * the append-only progress ledger (save & resume IS the ledger), training time
 * landing on the timesheet as a training-category entry, certificates as
 * records with a verification code, and the P6 tracking board where completion
 * status is visible by name and everything past it is not.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests training
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const training = require(`${TELEWORKR_CONSTANTS.LIBDIR}/training.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Training test failed: ${label} ${detail||""}`);}
}

const _today = () => new Date().toISOString().substring(0, 10);
const _inDays = days => new Date(Date.now() + days*86400000).toISOString().substring(0, 10);

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true);}
}

const _modules = () => [
    {id: "m1", title: "What counts as client data", minutes: 9,
        questions: [{id: "m1q1", text: "Is a client list client data?", type: "choice",
            options: [{code: "a", text: "Yes"}, {code: "b", text: "No"}], answer: "a"}]},
    {id: "m2", title: "Storing and sharing it", minutes: 15,
        questions: [{id: "m2q1", text: "Encrypt at rest?", type: "choice",
            options: [{code: "a", text: "Always"}, {code: "b", text: "Never"}], answer: "a"},
            {id: "m2q2", text: "Share links expire?", type: "choice",
                options: [{code: "a", text: "Yes"}, {code: "b", text: "No"}], answer: "a"}]}
];

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "training")) {
        LOG.console("Skipping training test case, not called.\n"); return true;
    }
    LOG.console("\nP training\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testPublishAndVersioning(w);
        await _testAssignment(w);
        await _testCatalogue(w);
        await _testPlayer(w);
        await _testCertificates(w);
        await _testTracking(w);
        await _testReissue(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  training tests threw: ${err}\n`); LOG.error(`Training tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nTraining tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** Publish, version immutability, and the publisher's invalidation choice. */
async function _testPublishAndVersioning(w) {
    LOG.console("\n publishing courses\n");
    await _checkThrows("a course without a title is refused",
        _ => training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
            course_code: "no-title", kind: "statutory", modules: _modules()}));
    await _checkThrows("a course with questions needs a pass mark",
        _ => training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
            course_code: "no-pass", title: "No pass", kind: "statutory", modules: _modules()}));
    await _checkThrows("an employee cannot publish",
        _ => training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.alice,
            course_code: "hcd", title: "Handling client data", kind: "statutory",
            modules: _modules(), pass_mark: 80, validity_years: 1}));

    const v1 = await training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
        course_code: "hcd", title: "Handling client data", kind: "statutory",
        modules: _modules(), pass_mark: 80, validity_years: 1,
        jurisdictions: ["IN"], recommended_roles: []});
    _check("publishing v1 returns version 1", v1.version == 1 && v1.reassigned == 0, JSON.stringify(v1));

    const v2 = await training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
        course_code: "hcd", title: "Handling client data", kind: "statutory",
        modules: _modules(), pass_mark: 80, validity_years: 1, invalidates: "minor"});
    _check("a minor republish supersedes without reassigning",
        v2.version == 2 && v2.reassigned == 0 && v2.invalidates == "minor", JSON.stringify(v2));

    const rows = await dblayer.getQueryOrThrow(
        "SELECT status FROM course_version WHERE org_id=? AND course_code='hcd' ORDER BY version", [w.org_id]);
    _check("v1 is superseded, v2 is the pointer",
        rows[0].status == "superseded" && rows[1].status == "published",
        JSON.stringify(rows));
}

/** Manual assignment: reason required and visible, employment required. */
async function _testAssignment(w) {
    LOG.console("\n assigning courses\n");
    await _checkThrows("an assignment without a reason is refused (L2)",
        _ => training.assignCourseAsync({org_id: w.org_id, actor_person_id: w.bob,
            subject_person_id: w.alice, course_code: "hcd", due_date: _inDays(10)}));
    await _checkThrows("an unknown course cannot be assigned",
        _ => training.assignCourseAsync({org_id: w.org_id, actor_person_id: w.bob,
            subject_person_id: w.alice, course_code: "nope", due_date: _inDays(10),
            reason: "lead_suggested"}));
    await _checkThrows("an employee cannot assign",
        _ => training.assignCourseAsync({org_id: w.org_id, actor_person_id: w.alice,
            subject_person_id: w.erin, course_code: "hcd", due_date: _inDays(10),
            reason: "lead_suggested"}));

    const assignment = await training.assignCourseAsync({org_id: w.org_id, actor_person_id: w.bob,
        subject_person_id: w.alice, course_code: "hcd", due_date: _inDays(10),
        reason: "lead_suggested", source_rule: "Lead suggestion — onboarding"});
    _check("a lead can assign with a visible reason",
        assignment.reason == "lead_suggested" && assignment.due_date == _inDays(10),
        JSON.stringify(assignment));
    const auditRow = (await dblayer.getQueryOrThrow(
        "SELECT action, reason FROM audit_event WHERE org_id=? AND object_type='course_assignment'",
        [w.org_id]))[0];
    _check("the assignment is audited with its reason",
        auditRow?.action == "training.assigned" && auditRow.reason == "lead_suggested");
}

/** P2: required above, recommended only by role or jurisdiction. */
async function _testCatalogue(w) {
    LOG.console("\n the catalogue separates obligation from opportunity\n");
    await training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
        course_code: "facilitation", title: "Facilitating a remote workshop", kind: "optional",
        modules: [{id: "f1", title: "Room and rails", minutes: 20, questions: []}],
        recommended_roles: ["employee"]});
    await training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
        course_code: "other-jurisdiction", title: "Something for Japan", kind: "optional",
        modules: [{id: "o1", title: "Japanese data rules", minutes: 10, questions: []}],
        jurisdictions: ["JP"]});

    const alice = await training.catalogueForPersonAsync(w.org_id, w.alice);
    _check("the required band carries the rule behind it",
        alice.required.length == 1 && alice.required[0].course_code == "hcd" &&
        alice.required[0].source_rule == "Lead suggestion — onboarding" &&
        alice.required[0].state == "not_started",
        JSON.stringify(alice.required));
    _check("recommended is by role and jurisdiction only",
        alice.recommended.some(row => row.course_code == "facilitation") &&
        !alice.recommended.some(row => row.course_code == "other-jurisdiction"),
        JSON.stringify(alice.recommended));

    const detail = await training.courseDetailAsync(w.org_id, w.alice, "hcd");
    _check("the detail states the failure policy before the first question",
        detail.course.pass_mark == 80 && /never visible to your manager/.test(detail.policy.failure) &&
        /paid working time/.test(detail.time_policy) &&
        detail.lead_sees.includes("Certificate and its expiry"),
        JSON.stringify(detail.policy));
}

/** P4: the player — attempts, completion writing training time, the pass. */
async function _testPlayer(w) {
    LOG.console("\n the player\n");
    await _checkThrows("a statutory course cannot be self-enrolled",
        _ => training.startModuleAsync(w.org_id, w.erin, "hcd", "m1"));

    const started = await training.startModuleAsync(w.org_id, w.alice, "hcd", "m1");
    _check("starting pins the version onto the assignment",
        started.assignment.course_version_id && started.progress_event.kind == "module_started");

    await _checkThrows("an unknown module is refused",
        _ => training.saveAttemptAsync(w.org_id, w.alice, {course_code: "hcd", module_id: "m9",
            answers: {}, elapsed_seconds: 60, client_event_id: "a-unknown"}));

    const fail = await training.saveAttemptAsync(w.org_id, w.alice, {course_code: "hcd",
        module_id: "m1", answers: {m1q1: "b"}, elapsed_seconds: 60, client_event_id: "a-fail"});
    _check("a wrong answer fails below the pass mark", fail.score == 0 && fail.passed === false);

    const retry = await training.saveAttemptAsync(w.org_id, w.alice, {course_code: "hcd",
        module_id: "m1", answers: {m1q1: "b"}, elapsed_seconds: 60, client_event_id: "a-fail"});
    _check("an attempt replay returns the stored attempt, not a duplicate",
        retry.progress_event.progress_event_id == fail.progress_event.progress_event_id &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM course_progress_event WHERE org_id=? AND client_event_id='a-fail'",
            [w.org_id]))[0].c == 1);

    const pass = await training.saveAttemptAsync(w.org_id, w.alice, {course_code: "hcd",
        module_id: "m1", answers: {m1q1: "a"}, elapsed_seconds: 90, client_event_id: "a-pass"});
    _check("a passing attempt is at or above the pass mark", pass.score == 100 && pass.passed === true);

    const done = await training.completeModuleAsync(w.org_id, w.alice, {course_code: "hcd",
        module_id: "m1", elapsed_seconds: 420, client_event_id: "a-m1-done"});
    const entry = (await dblayer.getQueryOrThrow(
        "SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? AND category='training'",
        [w.org_id, w.alice]))[0];
    _check("completing a module writes a training-category time entry",
        entry && entry.duration_seconds == 420 && /hcd/.test(entry.note),
        JSON.stringify(entry));
    const replay = await training.completeModuleAsync(w.org_id, w.alice, {course_code: "hcd",
        module_id: "m1", elapsed_seconds: 420, client_event_id: "a-m1-done"});
    _check("a completion replay returns the stored pair without a second time entry",
        replay.progress_event.progress_event_id == done.progress_event.progress_event_id &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM time_entry_event WHERE org_id=? AND category='training' AND note LIKE '%hcd%'",
            [w.org_id]))[0].c == 1);

    await _checkThrows("passing before all modules are passed is refused",
        _ => training.passCourseAsync(w.org_id, w.alice, "hcd"));

    await training.saveAttemptAsync(w.org_id, w.alice, {course_code: "hcd", module_id: "m2",
        answers: {m2q1: "a", m2q2: "a"}, elapsed_seconds: 300, client_event_id: "a-m2-pass"});
    await training.completeModuleAsync(w.org_id, w.alice, {course_code: "hcd",
        module_id: "m2", elapsed_seconds: 600, client_event_id: "a-m2-done"});

    const certificate = await training.passCourseAsync(w.org_id, w.alice, "hcd");
    _check("passing issues a certificate pinned to the version passed",
        certificate.verification_code && certificate.course_version_id,
        JSON.stringify(certificate));
    _check("the assignment is closed by the pass",
        (await dblayer.getQueryOrThrow(
            "SELECT status FROM course_assignment WHERE org_id=? AND person_id=? AND course_code='hcd'",
            [w.org_id, w.alice]))[0].status == "completed");

    const verified = await training.verifyCertificateAsync(certificate.verification_code);
    _check("verification proves existence and discloses nothing else",
        verified.exists === true && verified.course_title == "Handling client data" &&
        !verified.person_id && !verified.person_name, JSON.stringify(verified));
}

/** P5: certificates as records, with the expiry countdown state. */
async function _testCertificates(w) {
    LOG.console("\n certificates\n");
    const certificates = await training.certificatesForPersonAsync(w.org_id, w.alice);
    _check("the certificate list carries the countdown state",
        certificates.length == 1 && certificates[0].course_code == "hcd" &&
        certificates[0].state == "valid" && certificates[0].days_left > 300 &&
        certificates[0].warning === null,   // a full year out: warned at 90/30/7, not yet
        JSON.stringify(certificates));

    const exported = await training.exportRecordAsync(w.org_id, w.alice);
    _check("the export is the portable record — person, certificates and the ledger",
        exported.certificates.length == 1 &&
        exported.courses.some(course => course.course_code == "hcd") &&
        exported.courses.find(course => course.course_code == "hcd").events.some(e =>
            e.kind == "course_passed"), JSON.stringify(exported.courses));
}

/** P6: tracking is completion status only, and leave pauses deadlines. */
async function _testTracking(w) {
    LOG.console("\n the tracking board\n");
    await training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
        course_code: "infosec", title: "Information security basics", kind: "statutory",
        modules: [{id: "i1", title: "Basics", minutes: 10, questions: []}], validity_years: 1});
    await training.assignCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
        subject_person_id: w.alice, course_code: "infosec", due_date: _inDays(6),
        reason: "statutory", source_rule: "Statutory, India, refreshed annually"});
    // alice takes approved leave inside her training window — the deadline pauses
    await dblayer.runCmdOrThrow(`INSERT INTO leave_request (leave_request_id, org_id, person_id,
            leave_type, from_date, to_date, days_requested, days_deducted, status, created_at, submitted_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [`lv-${w.stamp}`, w.org_id, w.alice, "EL", _inDays(2), _inDays(3), 2, 2, "approved",
            Math.floor(Date.now()/1000), Math.floor(Date.now()/1000)]);

    await _checkThrows("an employee cannot read the tracking board",
        _ => training.trackingAsync({org_id: w.org_id, actor_person_id: w.alice}));

    const board = await training.trackingAsync({org_id: w.org_id, actor_person_id: w.carol});
    const row = board.rows.find(r => r.person_id == w.alice && r.course_code == "infosec");
    _check("the deadline pauses during approved leave, projected never stored",
        row.leave_days == 2 && row.effective_due == _inDays(8) &&
        row.due_date == _inDays(6), JSON.stringify(row));
    _check("completion status is visible, scores never are",
        row.state == "open" && !("score" in row) && !("attempts" in row),
        JSON.stringify(row));

    const leadBoard = await training.trackingAsync({org_id: w.org_id, actor_person_id: w.bob});
    _check("a lead sees only their direct reports",
        leadBoard.rows.every(r => [w.alice, w.erin].includes(r.person_id)),
        JSON.stringify(leadBoard.rows.map(r => r.name)));
}

/** A major version change reissues live assignments with a visible reason. */
async function _testReissue(w) {
    LOG.console("\n a material change reissues, silently it does not\n");
    await training.assignCourseAsync({org_id: w.org_id, actor_person_id: w.bob,
        subject_person_id: w.erin, course_code: "hcd", due_date: _inDays(20),
        reason: "statutory", source_rule: "Statutory, India, refreshed annually"});
    const result = await training.publishCourseAsync({org_id: w.org_id, actor_person_id: w.carol,
        course_code: "hcd", title: "Handling client data", kind: "statutory",
        modules: _modules(), pass_mark: 80, validity_years: 1, invalidates: "major"});
    _check("the major republish reissued the live assignment with a fresh due date and a reason",
        result.reassigned == 1 && result.invalidates == "major", JSON.stringify(result));
    const rows = await dblayer.getQueryOrThrow(
        "SELECT status, reason FROM course_assignment WHERE org_id=? AND course_code='hcd' AND status='assigned'",
        [w.org_id]);
    _check("the reissued assignment names the rule",
        rows.length == 1 && rows[0].reason == "course_reissued", JSON.stringify(rows));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Training test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual",
        manager_person_id: who == "alice" || who == "erin" ? people.bob.person_id : null});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of [["alice", "employee"], ["bob", "lead"], ["carol", "hr"],
        ["dave", "admin"], ["erin", "employee"]])
        await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(
        Object.entries(people).map(([name, person]) => [name, person.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["course_progress_event", "certificate", "course_assignment", "course_pointer",
        "course_version", "survey_response_event", "survey_invitation", "survey_pointer", "survey_version"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_request WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM task WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM working_window WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
