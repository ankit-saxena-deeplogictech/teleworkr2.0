/**
 * B5/B6 — admin day one and migration.
 *
 * B5: the setup checklist persists as a standing panel, not a wizard that
 * vanishes. Every step's state is derived from the data itself unless an admin
 * has marked it; only org & jurisdictions and at least one person are required,
 * and everything else defers with a stated consequence.
 *
 * B6: an import is a batch with an id. Nothing writes before a preview has been
 * read, every imported record carries its source and imported_at, and a commit
 * is reversible whole for 24 hours — unless something real has been built on it,
 * because then rollback would destroy records rather than undo an import.
 *
 * The opening-balance problem is resolved the A6 way: a single dated
 * opening_balance_entry per person per bucket, attributed to the source system,
 * visible forever as an assertion the product did not compute. Historical time
 * and leave transactions are deliberately not imported — the opening entry is
 * the boundary, and before it the old system is the record.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const identity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/identity.js`);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROLLBACK_WINDOW_SECONDS = 86400;      // B6: reversible for 24 hours
const STEP_STATUSES = Object.freeze(["done", "deferred", "in_progress"]);

const _now = _ => Math.floor(Date.now()/1000);

/** The checklist in B5's dependency order. Derived unless an admin marks a step. */
const STEPS = Object.freeze([
    {step: "org_jurisdictions", label: "Org & jurisdictions", required: true},
    {step: "identity", label: "Identity", required: false,
        defer_consequence: "Skipping leaves the L1 attribute pipe unmapped — employment stays hand-maintained."},
    {step: "import_people", label: "Import people", required: true},
    {step: "leave_policy", label: "First leave policy", required: false,
        defer_consequence: "Leave requests refuse until a policy is published (A8)."},
    {step: "opening_balances", label: "Opening leave balances", required: false,
        defer_consequence: "Balances read zero until entries are imported (B6)."},
    {step: "working_windows", label: "Working windows", required: false,
        defer_consequence: "The overlap board reads undeclared for people without a window."},
    {step: "invite", label: "Invite", required: false,
        defer_consequence: "Invites wait for the A9 working-window rule — nothing is sent at 03:00."}
]);

// ---------------------------------------------------------------------------
// the checklist and its health
// ---------------------------------------------------------------------------

/**
 * The standing setup panel: every step with its derived or marked state, the
 * health items that decay as people join and move, and the one metric B5
 * exists for — time from signup to the first recorded clock-in.
 *
 * @param {string} org_id The org
 * @returns {object} {org, steps, health, metrics}
 */
exports.setupStatusAsync = async function(org_id) {
    const org = await spine.getOrgAsync(org_id);
    if (!org) throw new Error(`Org ${org_id} was not found.`);

    const marks = {}; for (const mark of await dblayer.getQueryOrThrow(
        "SELECT * FROM org_setup_step WHERE org_id=?", [org_id])) marks[mark.step] = mark;

    const peopleCount = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM employment WHERE org_id=?", [org_id]))[0].c;
    const windowsCount = (await dblayer.getQueryOrThrow(
        `SELECT COUNT(DISTINCT person_id) AS c FROM working_window WHERE org_id=?
            AND valid_to IS NULL`, [org_id]))[0].c;
    const balancesCount = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM opening_balance_entry WHERE org_id=?", [org_id]))[0].c;
    const idpCount = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM employment WHERE org_id=? AND source='idp'", [org_id]))[0].c;
    const firstEvent = (await dblayer.getQueryOrThrow(
        "SELECT MIN(recorded_at) AS first FROM time_entry_event WHERE org_id=?", [org_id]))[0].first;

    const derive = step => {
        switch (step.step) {
            case "org_jurisdictions": return (org.name && org.home_jurisdiction) ? {status: "done"} :
                {status: "in_progress", reason: "The org needs a name and a primary jurisdiction."};
            case "identity": return idpCount > 0 ? {status: "done"} :
                {status: "not_started", reason: "No IdP-sourced employment yet. " + step.defer_consequence};
            case "import_people": return peopleCount > 0 ? {status: "done"} :
                {status: "not_started", reason: "At least one person is required (B5)."};
            case "leave_policy": return {status: "not_started", reason: step.defer_consequence};
            case "opening_balances": return balancesCount > 0 ? {status: "done"} :
                {status: "not_started", reason: step.defer_consequence};
            case "working_windows": return peopleCount == 0 ? {status: "not_started", reason: "People first."} :
                (windowsCount >= peopleCount ? {status: "done"} :
                    {status: "in_progress", reason: `${peopleCount - windowsCount} of ${peopleCount} people have no confirmed window.`});
            case "invite": return {status: "not_started", reason: step.defer_consequence};
        }
    };

    const steps = STEPS.map(step => {
        const derived = derive(step);
        const mark = marks[step.step];
        return {...step, status: mark?.status || derived.status, reason: mark?.status ? null : derived.reason,
            marked_default: mark?.marked_default || 0, marked: Boolean(mark),
            updated_at: mark?.updated_at || null};
    });

    return {org: {org_id, name: org.name, home_jurisdiction: org.home_jurisdiction,
            created_at: org.created_at, modules: org.modules ? JSON.parse(org.modules) : {}},
        steps, health: await _healthAsync(org_id, peopleCount),
        metrics: {time_to_first_clock_in_seconds:
            (firstEvent && org.created_at) ? Math.max(0, firstEvent - org.created_at) : null}};
}

async function _healthAsync(org_id, peopleCount) {
    const health = [];
    // a flagged person has no employment by construction — their org link is the
    // provisioning.incomplete audit entry written at sign-in
    const unmapped = await dblayer.getQueryOrThrow(
        `SELECT DISTINCT p.person_id, p.email, p.provisioning_status FROM person p
            JOIN audit_event a ON a.subject_person_id=p.person_id
                AND a.action='provisioning.incomplete' AND a.org_id=?
            WHERE p.provisioning_status IS NOT NULL`, [org_id]);
    if (unmapped.length) health.push({item: "unmapped_attributes",
        note: `${unmapped.length} person(s) have incomplete IdP attributes and no employment in force.`,
        persons: unmapped.map(row => ({person_id: row.person_id, email: row.email,
            missing: row.provisioning_status}))});

    const noWindow = await dblayer.getQueryOrThrow(
        `SELECT e.person_id, p.email FROM employment e JOIN person p ON p.person_id=e.person_id
            WHERE e.org_id=? AND e.valid_to IS NULL AND e.person_id NOT IN
                (SELECT person_id FROM working_window WHERE org_id=? AND valid_to IS NULL)`,
        [org_id, org_id]);
    if (noWindow.length) health.push({item: "windows_unconfirmed",
        note: `${noWindow.length} person(s) have no confirmed working window — the overlap board reads them as undeclared.`,
        persons: noWindow.map(row => ({person_id: row.person_id, email: row.email}))});

    const roles = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS c FROM role WHERE org_id=?", [org_id]))[0].c;
    if (roles == 0) health.push({item: "no_roles", note: "No roles seeded for this org."});

    return health;
}

/**
 * Marks a step explicitly — done, deferred, or in progress. An explicit mark
 * overrides the derived state from setupStatusAsync.
 * @param {object} request {org_id, actor_person_id, step, status, marked_default}
 */
exports.markStepAsync = async function(request) {
    const step = STEPS.find(entry => entry.step == request.step);
    if (!step) throw new Error(`Unknown setup step ${request.step}. Known: ${STEPS.map(s => s.step).join(", ")}.`);
    if (!STEP_STATUSES.includes(request.status)) throw new Error(
        `Unknown step status ${request.status}. Known: ${STEP_STATUSES.join(", ")}.`);
    await dblayer.runCmdOrThrow(
        `INSERT INTO org_setup_step (org_id, step, status, marked_default, updated_at, updated_by)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT (org_id, step) DO UPDATE SET status=excluded.status,
                marked_default=excluded.marked_default, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        [request.org_id, step.step, request.status, request.marked_default ? 1 : 0, _now(), request.actor_person_id]);
    return {step: step.step, status: request.status};
}

// ---------------------------------------------------------------------------
// importing
// ---------------------------------------------------------------------------

/**
 * Previews or commits a people import. A preview writes nothing; a commit writes
 * a batch and imports the rows that pass — rows that fail are listed with their
 * reasons and can be re-run (B5). A duplicate email needs a decision, not a
 * guess, so it is a failure, not a merge.
 *
 * @param {object} request {org_id, actor_person_id, rows, source, commit}
 * @returns {object} {batch_id, total_rows, ok_rows, failures, warnings}
 */
exports.importPeopleAsync = async function(request) {
    await permissions.requireAsync({org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "people.import"});

    const {valid, failures, warnings} = await _reviewPeopleAsync(request.org_id, request.rows);
    if (!request.commit) return {batch_id: null, status: "preview", total_rows: request.rows.length,
        ok_rows: valid.length, failures, warnings};

    const batch = {import_batch_id: serverutils.generateUUID(false), org_id: request.org_id,
        kind: "people", source: request.source || "csv", status: "committed",
        total_rows: request.rows.length, ok_rows: valid.length,
        failures: JSON.stringify(failures), warnings: JSON.stringify(warnings),
        created_at: _now(), committed_at: _now(), created_by: request.actor_person_id};

    return await dblayer.runInTransactionAsync(async exec => {
        await exec.runCmd(`INSERT INTO import_batch (import_batch_id, org_id, kind, source, status,
            total_rows, ok_rows, failures, warnings, created_at, created_by, committed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [batch.import_batch_id, batch.org_id, batch.kind, batch.source, batch.status,
                batch.total_rows, batch.ok_rows, batch.failures, batch.warnings,
                batch.created_at, batch.created_by, batch.committed_at]);

        for (const row of valid) {
            const person = await spine.createPersonAsync({email: row.email, display_name: row.display_name,
                source: batch.source, imported_at: _now(), import_batch_id: batch.import_batch_id}, exec);
            await spine.recordEmploymentAsync({org_id: request.org_id, person_id: person.person_id,
                status: row.employment_status, jurisdiction: row.jurisdiction,
                manager_person_id: row.manager_person_id || null, contract_type: row.contract_type,
                valid_from: row.start_date, source: batch.source, recorded_by: request.actor_person_id,
                import_batch_id: batch.import_batch_id}, exec);
        }

        await audit.insertEntryViaAsync(exec, {org_id: request.org_id, action: "people.imported",
            object_type: "import_batch", object_ref: batch.import_batch_id,
            actor_person_id: request.actor_person_id, subject_person_id: request.actor_person_id,
            detail: {ok_rows: valid.length, failures: failures.length, source: batch.source}},
            await permissions.effectivePermissionsAsync(request.org_id, request.actor_person_id,
                new Date().toISOString().substring(0, 10), exec));
        LOG.info(`Imported ${valid.length} people in ${request.org_id} as batch ${batch.import_batch_id}.`);
        return {batch_id: batch.import_batch_id, status: "committed", total_rows: request.rows.length,
            ok_rows: valid.length, failures, warnings};
    });
}

async function _reviewPeopleAsync(org_id, rows) {
    const valid = [], failures = [], warnings = [];
    const seenEmails = new Set();
    const jurisdictions = new Set();
    let index = 0;

    for (const row of rows) {
        index++;
        const email = (row.email||"").trim().toLowerCase();
        const fail = reason => failures.push({row: index, reason});

        if (!email) {fail("Missing email."); continue;}
        if (seenEmails.has(email)) {fail(`Duplicate email ${email} in this file.`); continue;}
        seenEmails.add(email);
        if (!row.display_name) {fail("Missing display_name."); continue;}
        if (!row.start_date || !ISO_DATE.test(row.start_date)) {fail("start_date must be an ISO calendar date."); continue;}
        if (!row.jurisdiction) {fail("Missing jurisdiction."); continue;}
        if (!row.contract_type) {fail("Missing contract_type."); continue;}
        const status = row.employment_status || "active";
        if (!identity.EMPLOYMENT_STATUSES.includes(status)) {
            fail(`Unknown employment_status ${JSON.stringify(row.employment_status)}.`); continue;}
        if (await spine.getPersonByEmailAsync(email)) {
            fail(`Duplicate email ${email} — an existing person. Needs a decision, not a guess (B6).`); continue;}

        const entry = {email, display_name: row.display_name, start_date: row.start_date,
            jurisdiction: row.jurisdiction, contract_type: row.contract_type,
            employment_status: status, manager_person_id: null};
        if (row.manager_email) {
            const manager = await spine.getPersonByEmailAsync(row.manager_email.toLowerCase());
            if (manager) entry.manager_person_id = manager.person_id;
            else warnings.push({row: index, reason: `Manager ${row.manager_email} is not present — imported unassigned, flagged.`});
        }
        jurisdictions.add(row.jurisdiction);
        valid.push(entry);
    }

    for (const jurisdiction of jurisdictions) warnings.push(
        {row: null, reason: `No leave policy exists for ${jurisdiction} yet — leave will refuse for these people until one is published (A8).`});
    return {valid, failures, warnings};
}

/**
 * Imports opening leave balances as dated ledger entries — assertions the
 * product did not compute, attributed to the source system (B6). Preview writes
 * nothing; commit writes the batch and the entries in one transaction.
 *
 * @param {object} request {org_id, actor_person_id, rows: [{email, leave_type, days}],
 *      source, cutover_date, commit}
 * @returns {object} {batch_id, status, total_rows, ok_rows, failures}
 */
exports.importBalancesAsync = async function(request) {
    await permissions.requireAsync({org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "people.import"});
    const cutover = request.cutover_date;
    if (!cutover || !ISO_DATE.test(cutover)) throw new Error("cutover_date must be an ISO calendar date — cutover is a date, not an event (B6).");

    const valid = [], failures = [];
    for (let index = 0; index < request.rows.length; index++) {
        const row = request.rows[index];
        const email = (row.email||"").trim().toLowerCase();
        const person = email ? await spine.getPersonByEmailAsync(email) : null;
        if (!person) {failures.push({row: index+1, reason: `No person for ${email || "missing email"}. Import people first.`}); continue;}
        if (!row.leave_type) {failures.push({row: index+1, reason: "Missing leave_type."}); continue;}
        if (!(row.days > 0)) {failures.push({row: index+1, reason: "days must be a positive number."}); continue;}
        valid.push({person_id: person.person_id, leave_type: row.leave_type, days: row.days});
    }

    if (!request.commit) return {batch_id: null, status: "preview", total_rows: request.rows.length,
        ok_rows: valid.length, failures};

    const batch = {import_batch_id: serverutils.generateUUID(false), org_id: request.org_id,
        kind: "balances", source: request.source || "csv", status: "committed",
        total_rows: request.rows.length, ok_rows: valid.length, failures: JSON.stringify(failures),
        warnings: "[]", cutover_date: cutover, created_at: _now(), committed_at: _now(),
        created_by: request.actor_person_id};

    return await dblayer.runInTransactionAsync(async exec => {
        await exec.runCmd(`INSERT INTO import_batch (import_batch_id, org_id, kind, source, status,
            total_rows, ok_rows, failures, warnings, cutover_date, created_at, created_by, committed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [batch.import_batch_id, batch.org_id, batch.kind, batch.source, batch.status,
                batch.total_rows, batch.ok_rows, batch.failures, batch.warnings, batch.cutover_date,
                batch.created_at, batch.created_by, batch.committed_at]);
        for (const row of valid) await exec.runCmd(
            `INSERT INTO opening_balance_entry (opening_balance_id, org_id, person_id, leave_type, days,
                cutover_date, source, imported_at, import_batch_id, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [serverutils.generateUUID(false), request.org_id, row.person_id, row.leave_type, row.days,
                cutover, batch.source, _now(), batch.import_batch_id, request.actor_person_id]);
        await audit.insertEntryViaAsync(exec, {org_id: request.org_id, action: "balances.imported",
            object_type: "import_batch", object_ref: batch.import_batch_id,
            actor_person_id: request.actor_person_id, subject_person_id: request.actor_person_id,
            detail: {ok_rows: valid.length, cutover_date: cutover, source: batch.source}},
            await permissions.effectivePermissionsAsync(request.org_id, request.actor_person_id,
                new Date().toISOString().substring(0, 10), exec));
        return {batch_id: batch.import_batch_id, status: "committed", total_rows: request.rows.length,
            ok_rows: valid.length, failures};
    });
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

/**
 * Rolls an import back whole — for 24 hours, and only while nothing real has
 * been built on it. After that, the button stops being offered and this says
 * why, plainly (B6).
 *
 * @param {object} request {org_id, actor_person_id, import_batch_id}
 */
exports.rollbackImportAsync = async function(request) {
    await permissions.requireAsync({org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "people.import"});
    return await dblayer.runInTransactionAsync(async exec => {
        const batches = await exec.getQuery("SELECT * FROM import_batch WHERE import_batch_id=?",
            [request.import_batch_id]);
        const batch = batches.length ? batches[0] : null;
        if (!batch || batch.org_id != request.org_id) throw new Error(
            `Import batch ${request.import_batch_id} was not found.`);
        if (batch.status != "committed") throw new Error(
            `The batch is ${batch.status}; only a committed import can be rolled back.`);
        if ((batch.committed_at + ROLLBACK_WINDOW_SECONDS) < _now()) throw new Error(
            "The 24-hour rollback window has closed. The imported data has been in place too long.");

        if (batch.kind == "people") {
            const used = await exec.getQuery(
                `SELECT COUNT(*) AS c FROM time_entry_event t JOIN person p ON p.person_id=t.person_id
                    WHERE p.import_batch_id=? AND t.recorded_at >= ?`,
                [batch.import_batch_id, batch.committed_at]);
            if (used[0].c > 0) throw new Error(
                "Time has been recorded against the imported people. Rollback is no longer offered because it would destroy real records.");
            await exec.runCmd("DELETE FROM employment WHERE import_batch_id=?", [batch.import_batch_id]);
            await exec.runCmd("DELETE FROM person WHERE import_batch_id=?", [batch.import_batch_id]);
        } else {
            await exec.runCmd("DELETE FROM opening_balance_entry WHERE import_batch_id=?",
                [batch.import_batch_id]);
        }

        await exec.runCmd("UPDATE import_batch SET status='rolled_back', rolled_back_at=? WHERE import_batch_id=?",
            [_now(), batch.import_batch_id]);
        await audit.insertEntryViaAsync(exec, {org_id: request.org_id, action: "import.rolled_back",
            object_type: "import_batch", object_ref: batch.import_batch_id,
            actor_person_id: request.actor_person_id, subject_person_id: request.actor_person_id,
            detail: {kind: batch.kind, rows: batch.ok_rows}},
            await permissions.effectivePermissionsAsync(request.org_id, request.actor_person_id,
                new Date().toISOString().substring(0, 10), exec));
        return "rolled_back";
    });
}

exports.STEPS = STEPS;
