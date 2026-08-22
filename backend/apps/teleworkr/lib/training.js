/**
 * P — the training & certificates domain.
 *
 * Nothing here is new machinery (P1): a versioned course definition with a
 * published pointer, an assignment edge that carries the obligation's reason,
 * an append-only progress ledger, and a certificate that pins the version
 * passed. "Resume where I left off" and "prove what they completed in March"
 * are the same mechanism.
 *
 * The decisions this module enforces, so a screen cannot skip them:
 *   - Training time is time. A completed module writes a time_entry_event with
 *     category 'training' in the SAME transaction as its progress event, so it
 *     lands on the timesheet (C5) and counts toward contracted hours.
 *   - Only the passing attempt is visible. Attempts are stored (the ledger is
 *     the resume mechanism) but every read path for another person — tracking,
 *     certificates, export of others — returns completion status only. Scores,
 *     attempt counts and which questions were missed are the person's own.
 *   - What a version change does is the publisher's stated choice at publish,
 *     with the consequence shown (P1 item 7) — the same discipline as J2.
 *   - Deadlines pause during approved leave. Chasing someone on annual leave
 *     for a training deadline is the fastest way to make a compliance tool
 *     resented; the data to prevent it is already in the product (J3).
 *
 * Deferred honestly: rule-based automatic assignment on join/move (manual
 * assignment with a visible reason is the path for now), and the public
 * verification PAGE (the API op exists; the page is an N3-visibility surface
 * that lands with the wiki module).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);

const COURSE_KINDS = Object.freeze(["statutory", "optional"]);
const INVALIDATIONS = Object.freeze(["none", "minor", "major"]);
const REASONS = Object.freeze(["statutory", "policy", "lead_suggested", "manual",
    "self_enrolled", "course_reissued"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRAINING_CATEGORY = "training";

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);
const _uuid = _ => serverutils.generateUUID(false);

// ---------------------------------------------------------------------------
// publishing (P1 item 7, P6 assign)
// ---------------------------------------------------------------------------

/**
 * Publishes a course version and moves the pointer. Versions are immutable;
 * supersession moves the pointer and never edits a published version.
 *
 * The publisher states, at publish, what the change does to what already
 * exists: 'none' (typo fix — nobody retakes), 'minor' (existing certificates
 * stay valid to expiry; new enrolments get the new version), or 'major' (the
 * publisher declares it invalidates — every live assignment is superseded and
 * reissued with a fresh due date and a reason the person can see).
 *
 * @param {object} request {org_id, actor_person_id, course_code, title, kind,
 *      modules, pass_mark, validity_years, jurisdictions, recommended_roles,
 *      invalidates, reissue_days}
 * @returns {object} {course_version, version, reassigned}
 */
exports.publishCourseAsync = async function(request) {
    const course = _validateCourse(request);
    const invalidates = INVALIDATIONS.includes(request.invalidates) ? request.invalidates : "none";
    const reissueDays = Number.isInteger(request.reissue_days) ? request.reissue_days : 30;

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "training.publish",
        audit: {action: "training.course_published", object_type: "course",
            object_ref: request.course_code,
            detail: {title: course.title, kind: course.kind, modules: course.modules.length,
                invalidates}},

        action: async exec => {
            const current = await exec.getQuery(
                "SELECT * FROM course_pointer WHERE org_id=? AND course_code=?",
                [request.org_id, request.course_code]);
            const versions = await exec.getQuery(
                "SELECT MAX(version) AS max FROM course_version WHERE org_id=? AND course_code=?",
                [request.org_id, request.course_code]);
            const versionNumber = (versions[0].max || 0) + 1;

            const version = {course_version_id: _uuid(), org_id: request.org_id,
                course_code: request.course_code, version: versionNumber, status: "published",
                title: course.title, kind: course.kind, modules: JSON.stringify(course.modules),
                pass_mark: course.pass_mark ?? null, validity_years: course.validity_years ?? null,
                jurisdictions: JSON.stringify(course.jurisdictions || []),
                recommended_roles: JSON.stringify(course.recommended_roles || []),
                invalidates, published_at: _now(), published_by: request.actor_person_id,
                created_at: _now(), created_by: request.actor_person_id};

            await exec.runCmd(`INSERT INTO course_version (course_version_id, org_id, course_code,
                    version, status, title, kind, modules, pass_mark, validity_years, jurisdictions,
                    recommended_roles, invalidates, published_at, published_by, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [version.course_version_id, version.org_id, version.course_code, version.version,
                    version.status, version.title, version.kind, version.modules, version.pass_mark,
                    version.validity_years, version.jurisdictions, version.recommended_roles,
                    version.invalidates, version.published_at, version.published_by,
                    version.created_at, version.created_by]);
            if (current.length) await exec.runCmd(
                "UPDATE course_version SET status='superseded' WHERE course_version_id=?",
                [current[0].course_version_id]);
            await exec.runCmd(
                `INSERT INTO course_pointer (org_id, course_code, course_version_id, updated_at)
                    VALUES (?,?,?,?)
                    ON CONFLICT (org_id, course_code) DO UPDATE SET course_version_id=excluded.course_version_id,
                        updated_at=excluded.updated_at`,
                [request.org_id, request.course_code, version.course_version_id, _now()]);

            // A major change reissues every live assignment with a fresh due
            // date and a reason the person can see — silently reassigning 34
            // people is a bad Monday (P1 item 7).
            let reassigned = 0;
            if (invalidates == "major") {
                const live = await exec.getQuery(
                    "SELECT * FROM course_assignment WHERE org_id=? AND course_code=? AND status='assigned'",
                    [request.org_id, request.course_code]);
                for (const old of live) {
                    await exec.runCmd(
                        "UPDATE course_assignment SET status='superseded' WHERE assignment_id=?",
                        [old.assignment_id]);
                    const due = new Date(Date.now() + reissueDays*86400000).toISOString().substring(0, 10);
                    await exec.runCmd(`INSERT INTO course_assignment (assignment_id, org_id, person_id,
                            course_code, course_version_id, due_date, reason, source_rule, assigned_by,
                            assigned_at, status)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                        [_uuid(), request.org_id, old.person_id, request.course_code,
                            version.course_version_id, due, "course_reissued",
                            `Course reissued — v${versionNumber} is a material change.`, request.actor_person_id,
                            _now(), "assigned"]);
                    reassigned++;
                }
            }

            return {course_version_id: version.course_version_id, version: versionNumber,
                reassigned, invalidates};
        }});
}

/**
 * Manual assignment — the exception, not the rule (P6). A reason is required by
 * the capability and is visible to the recipient; rule-based assignment on join
 * and move lands with the day-one checklist (B3).
 *
 * @param {object} request {org_id, actor_person_id, subject_person_id,
 *      course_code, due_date, reason, source_rule}
 * @returns The assignment
 */
exports.assignCourseAsync = async function(request) {
    if (!request.due_date) throw new Error("A manual assignment needs a due date — it is an obligation.");
    _assertISODate(request.due_date, "due_date");
    const employment = await spine.employmentAsOfAsync(request.org_id, request.subject_person_id);
    if (!employment) throw new Error("The person has no employment in force in this organisation.");

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "training.assign", subject_person_id: request.subject_person_id,
        reason: request.reason,
        audit: {action: "training.assigned", object_type: "course_assignment",
            object_ref: request.course_code, subject_person_id: request.subject_person_id,
            detail: {due_date: request.due_date, source_rule: request.source_rule || null}},

        action: async exec => {
            const pointer = await _pointerAsync(exec, request.org_id, request.course_code);
            if (!pointer) throw new Error(`No published course ${request.course_code}. Publish it first.`);
            const assignment = {assignment_id: _uuid(), org_id: request.org_id,
                person_id: request.subject_person_id, course_code: request.course_code,
                course_version_id: null, due_date: request.due_date, reason: request.reason,
                source_rule: request.source_rule || null, assigned_by: request.actor_person_id,
                assigned_at: _now(), completed_at: null, status: "assigned"};
            await exec.runCmd(`INSERT INTO course_assignment (assignment_id, org_id, person_id,
                    course_code, course_version_id, due_date, reason, source_rule, assigned_by,
                    assigned_at, completed_at, status)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [assignment.assignment_id, assignment.org_id, assignment.person_id,
                    assignment.course_code, assignment.course_version_id, assignment.due_date,
                    assignment.reason, assignment.source_rule, assignment.assigned_by,
                    assignment.assigned_at, assignment.completed_at, assignment.status]);
            return assignment;
        }});
}

// ---------------------------------------------------------------------------
// the learner side (P2 catalogue, P3 detail, P4 player)
// ---------------------------------------------------------------------------

/**
 * The catalogue, as the ordering is the whole design (P2): what you must do,
 * then what you could. Required rows name the rule behind them — "because HR
 * said so" is not a reason a person can act on.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @returns {object} {required: [...], recommended: [...]}
 */
exports.catalogueForPersonAsync = async function(org_id, person_id) {
    const assignments = await dblayer.getQueryOrThrow(
        `SELECT a.*, v.title, v.kind, v.pass_mark, v.validity_years
            FROM course_assignment a
            LEFT JOIN course_version v ON v.course_version_id =
                COALESCE(a.course_version_id,
                    (SELECT course_version_id FROM course_pointer p
                        WHERE p.org_id=a.org_id AND p.course_code=a.course_code))
            WHERE a.org_id=? AND a.person_id=? AND a.status='assigned'
            ORDER BY a.assigned_at ASC`, [org_id, person_id]);
    const required = [];
    for (const assignment of assignments) {
        const row = await _assignmentProjectionAsync(org_id, person_id, assignment);
        if (row) required.push(row);
    }

    const employment = await spine.employmentAsOfAsync(org_id, person_id);
    const jurisdiction = employment?.jurisdiction || null;
    const heldRoles = new Set((await permissions.activeGrantsAsync(org_id, person_id))
        .map(grant => grant.source_role).filter(Boolean));

    const pointers = await dblayer.getQueryOrThrow(
        `SELECT v.* FROM course_pointer p JOIN course_version v ON v.course_version_id = p.course_version_id
            WHERE p.org_id=? ORDER BY v.title ASC`, [org_id]);
    const recommended = [];
    for (const version of pointers) {
        if (!version.recommended_roles && !(JSON.parse(version.jurisdictions||"[]").length)) continue;
        if (version.kind != "optional") continue;                       // obligation lives on assignment
        if (required.some(row => row.course_code == version.course_code)) continue;
        const roles = JSON.parse(version.recommended_roles || "[]");
        const jurisdictions = JSON.parse(version.jurisdictions || "[]");
        if (!(roles.some(role => heldRoles.has(role)) ||
            (jurisdiction && jurisdictions.includes(jurisdiction)))) continue;
        if (await _holdsCertificateAsync(org_id, person_id, version.course_code)) continue;
        recommended.push(_versionCard(version));
    }
    return {required, recommended};
}

/**
 * Course detail (P3) — the screen that answers "what am I agreeing to": the
 * time cost, the module list, what happens on completion, and what happens if
 * the person fails. Failure policy is stated before the first question, not in
 * a help article.
 *
 * @returns {object} {course, modules, assignment, policy, lead_sees, time_policy}
 */
exports.courseDetailAsync = async function(org_id, person_id, course_code) {
    const version = await _pointerVersionAsync(org_id, course_code);
    if (!version) throw new Error(`No published course ${course_code}.`);
    const assignment = await _liveAssignmentAsync(org_id, person_id, course_code);
    const events = await _eventsForAsync(org_id, person_id, course_code);
    const progress = _project(version, events);

    const modules = JSON.parse(version.modules).map(module => ({
        id: module.id, title: module.title, minutes: module.minutes || 0,
        // questions are sent WITHOUT their answer keys — grading happens here,
        // and a client that held the answers would make "only your passing
        // attempt is recorded" a story rather than a guarantee
        questions: (module.questions || []).map(question => ({
            id: question.id, text: question.text, type: question.type || "choice",
            options: question.options?.map(option => ({code: option.code, text: option.text})) || null})),
        state: progress.modules[module.id] || "not_started"}));

    return {course: _versionCard(version), modules,
        assignment: assignment ? {
            assignment_id: assignment.assignment_id, due_date: assignment.due_date,
            reason: assignment.reason, source_rule: assignment.source_rule,
            ..._effectiveDue(assignment)} : null,
        policy: {
            pass_mark: version.pass_mark,
            validity_years: version.validity_years,
            attempts: version.pass_mark ? "Unlimited attempts, no waiting period, and only your passing attempt is recorded." : null,
            failure: version.pass_mark ?
                "Failed attempts are erased after 13 months and are never visible to your manager, never exported, and never reachable in a performance context." : null},
        lead_sees: ["Assigned · due date · complete or not",
            "Certificate and its expiry",
            "Time you spent on it — only as a timesheet total"],
        lead_never_sees: ["Your score", "Attempts, or which questions you missed"],
        time_policy: "This is paid working time. Log it as you go — the timer starts when you open a module and the entry lands on your timesheet under training."};
}

/**
 * Starts a module: appends module_started and pins the version onto a
 * self-enrolled optional course. Required courses are pre-enrolled — there is
 * no "accept" step for a statutory obligation (P3 item 4).
 *
 * @returns {object} {progress_event, assignment}
 */
exports.startModuleAsync = async function(org_id, person_id, course_code, module_id) {
    const version = await _pointerVersionAsync(org_id, course_code);
    if (!version) throw new Error(`No published course ${course_code}.`);
    _moduleOf(version, module_id);      // refuses an unknown module

    return await dblayer.runInTransactionAsync(async exec => {
        let assignment = await _liveAssignmentViaAsync(exec, org_id, person_id, course_code);
        if (!assignment) {
            if (version.kind == "statutory") throw new Error(
                `${course_code} is statutory and is assigned by policy. It cannot be self-enrolled.`);
            assignment = {assignment_id: _uuid(), org_id, person_id, course_code,
                course_version_id: version.course_version_id, due_date: null,
                reason: "self_enrolled", source_rule: null, assigned_by: person_id,
                assigned_at: _now(), completed_at: null, status: "assigned"};
            await exec.runCmd(`INSERT INTO course_assignment (assignment_id, org_id, person_id,
                    course_code, course_version_id, due_date, reason, source_rule, assigned_by,
                    assigned_at, completed_at, status)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [assignment.assignment_id, assignment.org_id, assignment.person_id,
                    assignment.course_code, assignment.course_version_id, assignment.due_date,
                    assignment.reason, assignment.source_rule, assignment.assigned_by,
                    assignment.assigned_at, assignment.completed_at, assignment.status]);
        } else if (!assignment.course_version_id) {
            await exec.runCmd("UPDATE course_assignment SET course_version_id=? WHERE assignment_id=?",
                [version.course_version_id, assignment.assignment_id]);
            assignment.course_version_id = version.course_version_id;
        }

        const event = {progress_event_id: _uuid(), org_id, person_id, course_code,
            course_version_id: assignment.course_version_id || version.course_version_id,
            assignment_id: assignment.assignment_id, module_id, kind: "module_started",
            payload: null, client_event_id: null, recorded_at: _now()};
        await exec.runCmd(`INSERT INTO course_progress_event (progress_event_id, org_id, person_id,
                course_code, course_version_id, assignment_id, module_id, kind, payload,
                client_event_id, recorded_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [event.progress_event_id, event.org_id, event.person_id, event.course_code,
                event.course_version_id, event.assignment_id, event.module_id, event.kind,
                event.payload, event.client_event_id, event.recorded_at]);
        return {progress_event: event, assignment};
    });
}

/**
 * Grades and stores an attempt. Idempotent on client_event_id — a retry returns
 * the attempt the first call stored, never a duplicate and never a rejection.
 * Only the passing attempt is ever shown; the ledger keeps the rest for resume
 * and erase-13m (P1 item 8, P3 item 2).
 *
 * @returns {object} {progress_event, score, passed}
 */
exports.saveAttemptAsync = async function(org_id, person_id, request) {
    const {course_code, module_id, answers, elapsed_seconds, client_event_id} = request;
    const version = await _pointerVersionAsync(org_id, course_code);
    if (!version) throw new Error(`No published course ${course_code}.`);
    const module = _moduleOf(version, module_id);
    if (!version.pass_mark || !(module.questions || []).length) throw new Error(
        `Module ${module_id} has no scored questions — completing it is the pass.`);

    const score = _grade(module, answers);
    const passed = score >= version.pass_mark;
    const event = await _insertProgressEventAsync(org_id, person_id, {
        course_code, course_version_id: version.course_version_id, module_id,
        kind: "attempt_scored", payload: {score, passed, elapsed_seconds: elapsed_seconds || null},
        client_event_id});
    const stored = _json(event.payload) || {};
    return {progress_event: event, score: stored.score, passed: Boolean(stored.passed)};
}

/**
 * Completes a module. In ONE transaction the progress event and the time entry
 * land together — training time is time (P1 item 5), and neither record may
 * exist without the other. Idempotent on client_event_id.
 *
 * @returns {object} {progress_event, time_entry}
 */
exports.completeModuleAsync = async function(org_id, person_id, request) {
    const {course_code, module_id, elapsed_seconds, client_event_id} = request;
    const version = await _pointerVersionAsync(org_id, course_code);
    if (!version) throw new Error(`No published course ${course_code}.`);
    _moduleOf(version, module_id);
    if (!Number.isInteger(elapsed_seconds) || elapsed_seconds < 0) throw new Error(
        "elapsed_seconds must be a non-negative integer — it becomes the training time entry.");

    return await dblayer.runInTransactionAsync(async exec => {
        if (client_event_id) {
            const existing = await exec.getQuery(
                "SELECT * FROM course_progress_event WHERE org_id=? AND person_id=? AND client_event_id=?",
                [org_id, person_id, client_event_id]);
            if (existing.length) return {progress_event: existing[0],
                time_entry: await _entryForEventViaAsync(exec, existing[0])};
        }
        let entry;
        try {
            entry = await time.insertEventViaAsync(exec, {org_id, person_id,
                client_event_id: client_event_id ? `training-${client_event_id}` : null,
                entry_date: _today(), source: "manual", category: TRAINING_CATEGORY,
                note: `Training: ${course_code} · ${module_id}`, duration_seconds: elapsed_seconds,
                billable: 1});
        } catch (err) {
            // the time entry's unique client index already saw this replay —
            // the first attempt's event answers instead
            if (client_event_id) {
                const raced = await exec.getQuery(
                    "SELECT * FROM course_progress_event WHERE org_id=? AND person_id=? AND client_event_id=?",
                    [org_id, person_id, client_event_id]);
                if (raced.length) return {progress_event: raced[0],
                    time_entry: await _entryForEventViaAsync(exec, raced[0])};
            }
            throw err;
        }
        try {
            const event = await _insertProgressEventViaAsync(exec, org_id, person_id, {
                course_code, course_version_id: version.course_version_id, module_id,
                kind: "module_completed",
                payload: {elapsed_seconds, entry_event_id: entry.entry_event_id},
                client_event_id});
            return {progress_event: event, time_entry: entry};
        } catch (err) {
            // the progress event's unique client index won a race — the winner
            // answers; our time entry is still inside this transaction and is
            // rolled back with the throw
            if (client_event_id) {
                const raced = await exec.getQuery(
                    "SELECT * FROM course_progress_event WHERE org_id=? AND person_id=? AND client_event_id=?",
                    [org_id, person_id, client_event_id]);
                if (raced.length) return {progress_event: raced[0],
                    time_entry: await _entryForEventViaAsync(exec, raced[0])};
            }
            throw err;
        }
    });
}

/**
 * Passes the course: every module passed (an attempt at or above the pass mark,
 * or completion of a question-free module). Issues the certificate pinned to
 * the version passed and closes the assignment — one transaction.
 *
 * @returns The certificate
 */
exports.passCourseAsync = async function(org_id, person_id, course_code) {
    const version = await _pointerVersionAsync(org_id, course_code);
    if (!version) throw new Error(`No published course ${course_code}.`);
    const events = await _eventsForAsync(org_id, person_id, course_code);
    const progress = _project(version, events);
    const remaining = Object.entries(progress.modules)
        .filter(([, state]) => !["passed", "completed"].includes(state))
        .map(([id]) => id);
    if (remaining.length) throw new Error(
        `Not all modules are passed yet: ${remaining.join(", ")}.`);

    return await dblayer.runInTransactionAsync(async exec => {
        const existing = await exec.getQuery(
            "SELECT * FROM certificate WHERE org_id=? AND person_id=? AND course_code=? AND status='valid'",
            [org_id, person_id, course_code]);
        if (existing.length) return existing[0];     // re-passing is not a second certificate

        const event = await _insertProgressEventViaAsync(exec, org_id, person_id, {
            course_code, course_version_id: version.course_version_id, module_id: null,
            kind: "course_passed", payload: {score: progress.best_score}, client_event_id: null});

        const certificate = {certificate_id: _uuid(), org_id, person_id, course_code,
            course_version_id: version.course_version_id, issued_at: _now(),
            expires_on: version.validity_years ?
                new Date(Date.now() + version.validity_years*365*86400000).toISOString().substring(0, 10) : null,
            verification_code: await _uniqueVerificationCodeAsync(exec),
            external: 0, verified_by: null, verified_at: null, status: "valid"};
        await exec.runCmd(`INSERT INTO certificate (certificate_id, org_id, person_id, course_code,
                course_version_id, issued_at, expires_on, verification_code, external, verified_by,
                verified_at, status)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [certificate.certificate_id, certificate.org_id, certificate.person_id,
                certificate.course_code, certificate.course_version_id, certificate.issued_at,
                certificate.expires_on, certificate.verification_code, certificate.external,
                certificate.verified_by, certificate.verified_at, certificate.status]);
        const assignment = await _liveAssignmentViaAsync(exec, org_id, person_id, course_code);
        if (assignment) await exec.runCmd(
            "UPDATE course_assignment SET status='completed', completed_at=? WHERE assignment_id=?",
            [_now(), assignment.assignment_id]);
        return certificate;
    });
}

/**
 * The person's certificates, with the expiry countdown the wireframe borrows
 * from identity (L1): a certificate nobody is warned about is a compliance gap
 * discovered during an audit. Expired and superseded records stay — "was she
 * certified in March" is the question an audit actually asks (P5).
 *
 * @returns {array} Certificates newest first, with state and days_left computed
 */
exports.certificatesForPersonAsync = async function(org_id, person_id) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT c.*, v.title, v.version, v.validity_years FROM certificate c
            JOIN course_version v ON v.course_version_id = c.course_version_id
            WHERE c.org_id=? AND c.person_id=?
            ORDER BY c.issued_at DESC`, [org_id, person_id]);
    const states = [];
    for (const row of rows) {
        const pointer = await dblayer.getQueryOrThrow(
            "SELECT course_version_id FROM course_pointer WHERE org_id=? AND course_code=?",
            [org_id, row.course_code]);
        const superseded = pointer.length && pointer[0].course_version_id != row.course_version_id;
        const expired = row.expires_on && row.expires_on < _today();
        const daysLeft = row.expires_on ?
            Math.round((Date.parse(`${row.expires_on}T00:00:00Z`) - Date.now())/86400000) : null;
        states.push({certificate_id: row.certificate_id, course_code: row.course_code,
            title: row.title, version: row.version, issued_at: row.issued_at, expires_on: row.expires_on,
            verification_code: row.verification_code, external: Boolean(row.external),
            verified_by: row.verified_by, state: expired ? "expired" : (superseded ? "superseded" : "valid"),
            days_left: daysLeft, warning: (daysLeft !== null && daysLeft <= 90 && !expired) ?
                (daysLeft <= 7 ? 7 : daysLeft <= 30 ? 30 : 90) : null});
    }
    return states;
}

/**
 * The self-serve training record (P5 item 4): the person takes it with them,
 * which is the entire point of a certificate. Includes only what the owner may
 * see — their own attempts are theirs; nobody else's read reaches them.
 */
exports.exportRecordAsync = async function(org_id, person_id) {
    const person = await spine.getPersonAsync(person_id);
    const certificates = await exports.certificatesForPersonAsync(org_id, person_id);
    const events = await dblayer.getQueryOrThrow(
        `SELECT e.* FROM course_progress_event e
            JOIN course_version v ON v.course_version_id = e.course_version_id
            WHERE e.org_id=? AND e.person_id=? ORDER BY e.recorded_at ASC`, [org_id, person_id]);
    const byCourse = {};
    for (const event of events) {
        const row = byCourse[event.course_code] || (byCourse[event.course_code] = {
            course_code: event.course_code, events: []});
        row.events.push({kind: event.kind, module_id: event.module_id,
            payload: _json(event.payload), recorded_at: event.recorded_at});
    }
    return {exported_at: _today(), person: {person_id, display_name: person?.display_name || null,
        email: person?.email || null}, certificates, courses: Object.values(byCourse)};
}

/**
 * Public verification (P5 item 2): a code proves a certificate exists and
 * discloses nothing else about the person. The public PAGE is an N3-ladder
 * surface and lands with the wiki module; this op is what it will render.
 *
 * @param {string} code The verification code
 * @returns {object} {exists, course_title, issued_at, expires_on, state}
 */
exports.verifyCertificateAsync = async function(code) {
    if (!code) throw new Error("A verification code is required.");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT c.*, v.title, v.version FROM certificate c
            JOIN course_version v ON v.course_version_id = c.course_version_id
            WHERE c.verification_code=?`, [code]);
    if (!rows.length) return {exists: false};
    const row = rows[0];
    return {exists: true, course_title: row.title, course_version: row.version,
        issued_at: row.issued_at, expires_on: row.expires_on,
        state: row.expires_on && row.expires_on < _today() ? "expired" : row.status};
}

// ---------------------------------------------------------------------------
// the HR/lead side (P6) — completion status only, by name, and only that
// ---------------------------------------------------------------------------

/**
 * The tracking board. The asymmetry this module states out loud: completion is
 * per-person visible, and everything past it is not (P6). Scores, attempts and
 * time-per-module never appear in this read. Overdue rows name the person
 * because statutory obligation is the reason — and deadlines pause during
 * approved leave, read from J3 rather than re-decided.
 *
 * @param {object} request {org_id, actor_person_id}
 * @returns {object} {summary, overdue, expiring, rows}
 */
exports.trackingAsync = async function(request) {
    const grants = await permissions.activeGrantsAsync(request.org_id, request.actor_person_id,
        {capability: "training.track"});
    if (!grants.length) throw Object.assign(
        new Error("training.track is required to read the training tracking board."),
        {decision: {reason: "training.track is required to read the training tracking board."}});
    const orgScoped = grants.some(grant => grant.scope_type == capabilities.SCOPES.ORG);

    const people = orgScoped ? await spine.rosterAsOfAsync(request.org_id) :
        await spine.directReportsAsOfAsync(request.org_id, request.actor_person_id);
    const personIds = people.map(row => row.person_id);
    if (!personIds.length) return {summary: _emptySummary(), overdue: [], expiring: [], rows: []};

    const placeholders = personIds.map(_ => "?").join(",");
    const assignments = await dblayer.getQueryOrThrow(
        `SELECT a.*, v.title, v.kind FROM course_assignment a
            LEFT JOIN course_version v ON v.course_version_id =
                COALESCE(a.course_version_id,
                    (SELECT course_version_id FROM course_pointer p
                        WHERE p.org_id=a.org_id AND p.course_code=a.course_code))
            WHERE a.org_id=? AND a.status='assigned' AND a.person_id IN (${placeholders})
            ORDER BY a.due_date ASC, a.assigned_at ASC`,
        [request.org_id, ...personIds]);
    const certs = await dblayer.getQueryOrThrow(
        `SELECT c.* FROM certificate c WHERE c.org_id=? AND c.status='valid'
            AND c.expires_on IS NOT NULL AND c.person_id IN (${placeholders})`,
        [request.org_id, ...personIds]);

    const names = Object.fromEntries(people.map(row => [row.person_id,
        row.display_name || row.person_id]));
    const today = _today();
    const rows = [];
    for (const assignment of assignments) {
        const events = await _eventsForViaAsync(assignment.org_id, assignment.person_id, assignment.course_code);
        const pointer = await dblayer.getQueryOrThrow(
            "SELECT course_version_id FROM course_pointer WHERE org_id=? AND course_code=?",
            [assignment.org_id, assignment.course_code]);
        const version = await _versionByIdAsync(assignment.org_id, pointer[0].course_version_id);
        const projected = _project(version, events);
        const due = await _effectiveDue(assignment);
        rows.push({person_id: assignment.person_id, name: names[assignment.person_id],
            course_code: assignment.course_code, title: assignment.title, kind: assignment.kind,
            reason: assignment.reason, source_rule: assignment.source_rule,
            due_date: assignment.due_date, effective_due: due.effective_due,
            leave_days: due.leave_days, modules: projected.modules,
            state: projected.course_passed ? "complete" : (due.effective_due < today ? "overdue" : "open"),
            overdue_by_days: due.effective_due < today ?
                Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due.effective_due}T00:00:00Z`))/86400000) : 0});
    }
    const expiring = certs.map(cert => {
        const daysLeft = Math.round((Date.parse(`${cert.expires_on}T00:00:00Z`) - Date.now())/86400000);
        return {person_id: cert.person_id, name: names[cert.person_id], course_code: cert.course_code,
            expires_on: cert.expires_on, days_left: daysLeft};
    }).filter(row => row.days_left >= 0).sort((a, b) => a.days_left - b.days_left);

    return {summary: {assigned: rows.length, complete: rows.filter(r => r.state == "complete").length,
            open: rows.filter(r => r.state == "open").length,
            overdue: rows.filter(r => r.state == "overdue").length,
            certificates_expiring: expiring.length},
        overdue: rows.filter(r => r.state == "overdue"),
        expiring, rows};
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function _validateCourse(request) {
    if (!request?.title || typeof request.title != "string") throw new Error("A course needs a title.");
    if (!request.course_code || !/^[a-z0-9-]{2,64}$/.test(request.course_code)) throw new Error(
        "course_code must be lowercase letters, digits and dashes (2-64).");
    if (!COURSE_KINDS.includes(request.kind)) throw new Error(
        `kind must be one of ${COURSE_KINDS.join(", ")}.`);
    const modules = request.modules;
    if (!Array.isArray(modules) || !modules.length) throw new Error("A course needs at least one module.");
    const ids = new Set();
    for (const module of modules) {
        if (!module?.id || !module?.title) throw new Error("Every module needs an id and a title.");
        if (ids.has(module.id)) throw new Error(`Duplicate module id ${module.id}.`);
        ids.add(module.id);
        if (!Number.isInteger(module.minutes) || module.minutes < 0) throw new Error(
            `Module ${module.id} needs a non-negative integer minutes estimate.`);
        for (const question of (module.questions || [])) {
            if (!question?.id || !question?.text) throw new Error(`Module ${module.id} has a question without id or text.`);
            if (question.type == "choice" && (!Array.isArray(question.options) || question.options.length < 2))
                throw new Error(`Question ${question.id} in ${module.id} needs at least two options.`);
            if (question.type == "choice" && !question.options.some(o => o.code === question.answer))
                throw new Error(`Question ${question.id} in ${module.id} has no option matching its answer.`);
        }
    }
    const hasQuestions = modules.some(module => (module.questions || []).length);
    if (hasQuestions && (!Number.isInteger(request.pass_mark) || request.pass_mark < 1 || request.pass_mark > 100))
        throw new Error("A course with questions needs a pass_mark between 1 and 100.");
    if (!hasQuestions) request.pass_mark = null;      // read-and-acknowledge: completing is the pass
    if (request.validity_years !== undefined && request.validity_years !== null &&
        (!Number.isInteger(request.validity_years) || request.validity_years < 1))
        throw new Error("validity_years, when set, must be a positive integer.");
    return request;
}

function _assertISODate(date, label="date") {
    if ((typeof date != "string") || (!ISO_DATE.test(date))) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

async function _pointerAsync(exec, org_id, course_code) {
    const rows = exec ? await exec.getQuery(
        "SELECT * FROM course_pointer WHERE org_id=? AND course_code=?", [org_id, course_code]) :
        await dblayer.getQueryOrThrow(
        "SELECT * FROM course_pointer WHERE org_id=? AND course_code=?", [org_id, course_code]);
    return rows.length ? rows[0] : null;
}

async function _pointerVersionAsync(org_id, course_code) {
    const pointer = await _pointerAsync(null, org_id, course_code);
    if (!pointer) return null;
    return await _versionByIdAsync(org_id, pointer.course_version_id);
}

async function _versionByIdAsync(org_id, course_version_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM course_version WHERE org_id=? AND course_version_id=?",
        [org_id, course_version_id]);
    return rows.length ? rows[0] : null;
}

function _moduleOf(version, module_id) {
    const module = (JSON.parse(version.modules)).find(m => m.id == module_id);
    if (!module) throw new Error(`Module ${module_id} is not part of ${version.course_code}.`);
    return module;
}

async function _liveAssignmentAsync(org_id, person_id, course_code) {
    return await _liveAssignmentViaAsync(null, org_id, person_id, course_code);
}

async function _liveAssignmentViaAsync(exec, org_id, person_id, course_code) {
    const sql = `SELECT * FROM course_assignment WHERE org_id=? AND person_id=? AND course_code=?
        AND status='assigned' ORDER BY assigned_at DESC LIMIT 1`;
    const rows = exec ? await exec.getQuery(sql, [org_id, person_id, course_code]) :
        await dblayer.getQueryOrThrow(sql, [org_id, person_id, course_code]);
    return rows.length ? rows[0] : null;
}

async function _eventsForAsync(org_id, person_id, course_code) {
    return await _eventsForViaAsync(org_id, person_id, course_code);
}

async function _eventsForViaAsync(org_id, person_id, course_code) {
    return await dblayer.getQueryOrThrow(
        "SELECT * FROM course_progress_event WHERE org_id=? AND person_id=? AND course_code=? ORDER BY recorded_at ASC",
        [org_id, person_id, course_code]);
}

async function _insertProgressEventAsync(org_id, person_id, eventSpec) {
    return await dblayer.runInTransactionAsync(async exec =>
        await _insertProgressEventViaAsync(exec, org_id, person_id, eventSpec));
}

async function _insertProgressEventViaAsync(exec, org_id, person_id, eventSpec) {
    if (eventSpec.client_event_id) {
        const existing = await exec.getQuery(
            "SELECT * FROM course_progress_event WHERE org_id=? AND person_id=? AND client_event_id=?",
            [org_id, person_id, eventSpec.client_event_id]);
        if (existing.length) return existing[0];      // the offline replay contract (A8)
    }
    const event = {progress_event_id: _uuid(), org_id, person_id,
        course_code: eventSpec.course_code, course_version_id: eventSpec.course_version_id,
        assignment_id: null, module_id: eventSpec.module_id || null, kind: eventSpec.kind,
        payload: JSON.stringify(eventSpec.payload ?? null), client_event_id: eventSpec.client_event_id || null,
        recorded_at: _now()};
    if (eventSpec.kind == "module_started") {
        const assignment = await _liveAssignmentViaAsync(exec, org_id, person_id, eventSpec.course_code);
        event.assignment_id = assignment?.assignment_id || null;
    }
    try {
        await exec.runCmd(`INSERT INTO course_progress_event (progress_event_id, org_id, person_id,
                course_code, course_version_id, assignment_id, module_id, kind, payload,
                client_event_id, recorded_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [event.progress_event_id, event.org_id, event.person_id, event.course_code,
                event.course_version_id, event.assignment_id, event.module_id, event.kind,
                event.payload, event.client_event_id, event.recorded_at]);
    } catch (err) {
        // the unique client index lost a cross-process race — the winner answers
        if (eventSpec.client_event_id) {
            const raced = await exec.getQuery(
                "SELECT * FROM course_progress_event WHERE org_id=? AND person_id=? AND client_event_id=?",
                [org_id, person_id, eventSpec.client_event_id]);
            if (raced.length) return raced[0];
        }
        throw err;
    }
    return event;
}

async function _entryForEventViaAsync(exec, progressEvent) {
    const payload = _json(progressEvent.payload) || {};
    if (!payload.entry_event_id) return null;
    const rows = await exec.getQuery(
        "SELECT * FROM time_entry_event WHERE entry_event_id=?", [payload.entry_event_id]);
    return rows.length ? rows[0] : null;
}

/** Grades one attempt: score as a percentage of the module's questions. */
function _grade(module, answers) {
    const questions = module.questions || [];
    let correct = 0;
    for (const question of questions) if (answers?.[question.id] === question.answer) correct++;
    return Math.round(correct / questions.length * 100);
}

async function _uniqueVerificationCodeAsync(exec) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = serverutils.generateUUID(false).replace(/-/g, "").substring(0, 12).toUpperCase();
        const rows = await exec.getQuery("SELECT certificate_id FROM certificate WHERE verification_code=?", [code]);
        if (!rows.length) return code;
    }
    throw new Error("Could not allocate a unique verification code.");
}

async function _holdsCertificateAsync(org_id, person_id, course_code) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT certificate_id FROM certificate WHERE org_id=? AND person_id=? AND course_code=? AND status='valid'",
        [org_id, person_id, course_code]);
    return Boolean(rows.length);
}

/**
 * The projection over the ledger (A6 decision 2): percentage complete is never
 * stored, it is recomputed. Module states: not_started | started | passed |
 * completed (question-free module finished) | failed (attempted, not passed).
 */
function _project(version, events) {
    const modules = {};
    for (const module of (JSON.parse(version.modules))) modules[module.id] = "not_started";
    let bestScore = null, passedAt = null;
    for (const event of events) {
        const payload = _json(event.payload) || {};
        switch (event.kind) {
            case "module_started":
                if (modules[event.module_id] == "not_started") modules[event.module_id] = "started";
                break;
            case "attempt_scored":
                if (payload.passed) modules[event.module_id] = "passed";
                else if (modules[event.module_id] != "passed") modules[event.module_id] = "failed";
                break;
            case "module_completed":
                if (!modules[event.module_id] || ["not_started", "started", "failed"].includes(modules[event.module_id]))
                    modules[event.module_id] = "completed";
                break;
            case "course_passed":
                bestScore = payload.score ?? bestScore; passedAt = event.recorded_at;
                break;
        }
    }
    const questionFreePassed = Object.entries(modules)
        .filter(([id, state]) => state == "completed" && !_hasQuestions(version, id))
        .map(([id]) => id);
    for (const id of questionFreePassed) modules[id] = "passed";
    const loggedSeconds = events.filter(e => e.kind == "module_completed")
        .reduce((sum, e) => sum + (_json(e.payload)?.elapsed_seconds || 0), 0);
    return {modules, best_score: bestScore, course_passed: Boolean(passedAt), passed_at: passedAt,
        logged_seconds: loggedSeconds};
}

function _hasQuestions(version, module_id) {
    const module = (JSON.parse(version.modules)).find(m => m.id == module_id);
    return Boolean(module && (module.questions || []).length);
}

/** P6: deadlines pause during approved leave — projected, never stored. */
async function _effectiveDue(assignment) {
    if (!assignment.due_date) return {effective_due: assignment.due_date, leave_days: 0};
    const assignedOn = assignment.assigned_at ? new Date(assignment.assigned_at*1000)
        .toISOString().substring(0, 10) : assignment.due_date;
    const approved = await leave.approvedLeaveForAsync(assignment.org_id,
        [assignment.person_id], assignedOn, assignment.due_date);
    let leaveDays = 0;
    for (const row of approved) {
        const from = Math.max(Date.parse(`${assignedOn}T00:00:00Z`),
            Date.parse(`${row.from_date}T00:00:00Z`));
        const to = Math.min(Date.parse(`${assignment.due_date}T00:00:00Z`),
            Date.parse(`${row.to_date}T00:00:00Z`));
        if (to >= from) leaveDays += Math.round((to - from)/86400000) + 1;
    }
    const effective = leaveDays ? new Date(Date.parse(`${assignment.due_date}T00:00:00Z`)
        + leaveDays*86400000).toISOString().substring(0, 10) : assignment.due_date;
    return {effective_due: effective, leave_days: leaveDays};
}

function _assignmentProjectionAsync(org_id, person_id, assignment) {
    return (async _ => {
        const events = await _eventsForAsync(org_id, person_id, assignment.course_code);
        const pointer = await dblayer.getQueryOrThrow(
            "SELECT course_version_id FROM course_pointer WHERE org_id=? AND course_code=?",
            [org_id, assignment.course_code]);
        if (!pointer.length) return null;
        const version = await _versionByIdAsync(org_id, pointer[0].course_version_id);
        const projected = _project(version, events);
        const modules = JSON.parse(version.modules);
        const done = Object.values(projected.modules)
            .filter(state => ["passed", "completed"].includes(state)).length;
        const next = modules.find(module => !["passed", "completed"]
            .includes(projected.modules[module.id]));
        return {assignment_id: assignment.assignment_id, course_code: assignment.course_code,
            title: assignment.title, kind: assignment.kind, reason: assignment.reason,
            source_rule: assignment.source_rule, due_date: assignment.due_date,
            ...await _effectiveDue(assignment),
            modules_total: modules.length, modules_done: done, next_module: next?.id || null,
            next_module_title: next?.title || null, logged_seconds: projected.logged_seconds,
            state: projected.course_passed ? "passed" : (done ? "in_progress" : "not_started")};
    })();
}

function _versionCard(version) {
    return {course_code: version.course_code, version: version.version, title: version.title,
        kind: version.kind, pass_mark: version.pass_mark, validity_years: version.validity_years,
        modules: JSON.parse(version.modules).length,
        minutes: JSON.parse(version.modules).reduce((sum, m) => sum + (m.minutes || 0), 0),
        jurisdictions: JSON.parse(version.jurisdictions || "[]"),
        recommended_roles: JSON.parse(version.recommended_roles || "[]"),
        published_at: version.published_at};
}

const _json = value => {if (!value) return null; try {return JSON.parse(value);} catch {return null;}};

const _emptySummary = _ => ({assigned: 0, complete: 0, open: 0, overdue: 0, certificates_expiring: 0});

exports.TRAINING_CATEGORY = TRAINING_CATEGORY;
