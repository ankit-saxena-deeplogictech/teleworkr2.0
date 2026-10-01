/**
 * G1 — the app catalogue and bound launches.
 *
 * A launcher, not a directory: opening something from here while a timer is
 * running attributes that session to the running task — resolved server-side
 * from the ledger (`time.runningEntryAsync`), never trusted from the client,
 * so attribution can't be spoofed by a stale or faked task_ref. Access is
 * self-service, routed to a named approver — the same request-then-decide
 * shape `wiki.js`'s `requestPublicPublishAsync`/`pendingPublicRequestsAsync`/
 * `decidePublicRequestAsync` already established: a capability gates "can
 * this person ever decide a request," a request's own `approver_person_id`
 * gates "can they decide *this* one." Declining is a plain write requiring a
 * reason, not run through `audit.performAsync` — the same split wiki uses,
 * since only the grant itself (an access change) needs the A8 guarantee.
 *
 * Narrowed, deliberately:
 *   - No SSO/OAuth broker of any kind exists in this app. `launch_url` is a
 *     plain configured URL; a deep link is a person's own manually-attached
 *     reference (`app_task_link` — "the apps you've connected yourself"),
 *     never one discovered from a third-party API.
 *   - "Launch failed" / "SSO expired" aren't built — a thin launcher opening
 *     a URL in a new tab has no way to observe whether the far end loaded.
 *   - The full H3 admin surface (roles/people/policies/billing, notify-first
 *     seat reclamation, offboarding) is out of scope. Only the catalogue and
 *     a seat/usage view are here — literally this feature's own data, which
 *     is how the wireframe itself frames H3's reclaim report.
 *   - "Median time to access last quarter" is a plain average over every
 *     resolved request for that app, worded honestly — informational copy,
 *     not the mechanic.
 *   - The colleague cohort (manager's siblings, else the org roster minus
 *     self) is the same fallback `shell.mjs`'s B2 wizard and the A3 omni-bar
 *     already use client-side, reimplemented here server-side so the roster
 *     never has to travel to the client just to be filtered. This is the
 *     opposite direction from `workload.js`'s own cohort (direct reports —
 *     "I am the manager"); this one answers "who are my peers."
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);

const USAGE_WINDOW_DAYS = 60;

const _now = _ => Math.floor(Date.now()/1000);
const _uuid = _ => serverutils.generateUUID(false);
const _today = _ => new Date().toISOString().substring(0, 10);

async function _requireAsync(org_id, actor_person_id, capability, what) {
    const decision = await permissions.checkAsync({org_id, actor_person_id, capability});
    if (!decision.allowed) throw Object.assign(new Error(`${capability} is required to ${what}.`), {decision});
}

async function _runningTaskRefAsync(org_id, person_id) {
    const running = await time.runningEntryAsync(org_id, person_id, _today());
    return running?.task_ref || null;
}

/** Peers, not reports: whoever shares this person's manager, else the org roster minus them. */
async function _cohortAsync(org_id, person_id) {
    const managerId = await spine.managerAsOfAsync(org_id, person_id);
    const roster = await spine.rosterAsOfAsync(org_id);
    const siblings = managerId ? roster.filter(p => p.manager_person_id == managerId && p.person_id != person_id) : [];
    return siblings.length ? siblings : roster.filter(p => p.person_id != person_id);
}

async function _avgDecisionSecondsAsync(org_id, app_id) {
    const decided = await dblayer.getQueryOrThrow(
        "SELECT created_at, decided_at FROM app_access_request WHERE org_id=? AND app_id=? AND decided_at IS NOT NULL",
        [org_id, app_id]);
    if (!decided.length) return null;
    return Math.round(decided.reduce((sum, r) => sum + (r.decided_at - r.created_at), 0) / decided.length);
}

// ---------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------

/**
 * The catalogue, annotated for one viewer: their own access state, their own
 * deep link for whatever task is currently running, when they last opened
 * each app, and who nearby already has the ones they don't.
 * @param {string} org_id The org
 * @param {string} actor_person_id The viewer
 * @returns {object} {running_task_ref, apps}
 */
exports.catalogueAsync = async function(org_id, actor_person_id) {
    const runningTaskRef = await _runningTaskRefAsync(org_id, actor_person_id);
    const cohort = await _cohortAsync(org_id, actor_person_id);
    const cohortIds = cohort.map(p => p.person_id);

    const apps = await dblayer.getQueryOrThrow(
        "SELECT * FROM app_catalogue WHERE org_id=? AND deprecated=0 ORDER BY name ASC", [org_id]);

    const rows = [];
    for (const app of apps) {
        const grant = (await dblayer.getQueryOrThrow(
            "SELECT 1 FROM app_access WHERE org_id=? AND app_id=? AND person_id=? AND revoked_at IS NULL",
            [org_id, app.app_id, actor_person_id]))[0];

        let access = "none", decision_reason = null;
        if (grant) access = "granted";
        else {
            const lastRequest = (await dblayer.getQueryOrThrow(
                `SELECT status, decision_reason FROM app_access_request WHERE org_id=? AND app_id=? AND requested_by=?
                    ORDER BY created_at DESC LIMIT 1`, [org_id, app.app_id, actor_person_id]))[0];
            if (lastRequest?.status == "pending") access = "pending";
            else if (lastRequest?.status == "denied") {access = "denied"; decision_reason = lastRequest.decision_reason;}
        }

        let open_link = null;
        if (runningTaskRef) {
            const link = (await dblayer.getQueryOrThrow(
                `SELECT label, url FROM app_task_link WHERE org_id=? AND app_id=? AND task_ref=? AND person_id=?
                    ORDER BY created_at DESC LIMIT 1`, [org_id, app.app_id, runningTaskRef, actor_person_id]))[0];
            if (link) open_link = link;
        }

        const lastUsed = (await dblayer.getQueryOrThrow(
            "SELECT occurred_at FROM app_launch_event WHERE org_id=? AND app_id=? AND person_id=? ORDER BY occurred_at DESC LIMIT 1",
            [org_id, app.app_id, actor_person_id]))[0];

        let colleagues_with_access = [], avg_decision_seconds = null;
        if (access != "granted") {
            if (cohortIds.length) {
                const placeholders = cohortIds.map(_ => "?").join(",");
                const haveIt = await dblayer.getQueryOrThrow(
                    `SELECT person_id FROM app_access WHERE org_id=? AND app_id=? AND revoked_at IS NULL
                        AND person_id IN (${placeholders})`, [org_id, app.app_id, ...cohortIds]);
                const haveSet = new Set(haveIt.map(r => r.person_id));
                colleagues_with_access = cohort.filter(p => haveSet.has(p.person_id)).slice(0, 3).map(p => p.display_name);
            }
            if (app.requires_request) avg_decision_seconds = await _avgDecisionSecondsAsync(org_id, app.app_id);
        }

        rows.push({app_id: app.app_id, name: app.name, category: app.category,
            launch_url: app.launch_url, launch_label: app.launch_label,
            requires_request: Boolean(app.requires_request),
            cost_per_seat_minor: app.cost_per_seat_minor, cost_currency: app.cost_currency,
            approver_person_id: app.approver_person_id,
            access, decision_reason, open_link, last_used: lastUsed?.occurred_at || null,
            colleagues_with_access, avg_decision_seconds});
    }

    return {running_task_ref: runningTaskRef, apps: rows};
}

/**
 * Records that an app was opened — what gets recorded: the app, when, by
 * whom, and which task the timer was on. Never what happened inside it.
 * @param {string} org_id The org
 * @param {string} person_id Who opened it
 * @param {string} app_id Which app
 * @returns The recorded event
 */
exports.recordLaunchAsync = async function(org_id, person_id, app_id) {
    const task_ref = await _runningTaskRefAsync(org_id, person_id);
    const row = {event_id: _uuid(), org_id, app_id, person_id, task_ref, occurred_at: _now()};
    await dblayer.runCmdOrThrow(
        "INSERT INTO app_launch_event (event_id, org_id, app_id, person_id, task_ref, occurred_at) VALUES (?,?,?,?,?,?)",
        [row.event_id, row.org_id, row.app_id, row.person_id, row.task_ref, row.occurred_at]);
    return row;
}

// ---------------------------------------------------------------------------
// access requests
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, app_id, reason} */
exports.requestAccessAsync = async function(request) {
    const {org_id, actor_person_id, app_id} = request;
    if (!request.reason?.trim()) throw new Error("An access request needs a reason.");
    const app = (await dblayer.getQueryOrThrow("SELECT * FROM app_catalogue WHERE org_id=? AND app_id=?",
        [org_id, app_id]))[0];
    if (!app || app.deprecated) throw new Error(`No app ${app_id}.`);

    const granted = (await dblayer.getQueryOrThrow(
        "SELECT 1 FROM app_access WHERE org_id=? AND app_id=? AND person_id=? AND revoked_at IS NULL",
        [org_id, app_id, actor_person_id]))[0];
    if (granted) throw new Error("Access to this app is already granted.");

    const pending = (await dblayer.getQueryOrThrow(
        "SELECT 1 FROM app_access_request WHERE org_id=? AND app_id=? AND requested_by=? AND status='pending'",
        [org_id, app_id, actor_person_id]))[0];
    if (pending) throw new Error("A request for this app is already pending.");

    const row = {request_id: _uuid(), org_id, app_id, requested_by: actor_person_id, reason: request.reason,
        approver_person_id: app.approver_person_id, status: "pending", created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO app_access_request (request_id, org_id, app_id, requested_by, reason, approver_person_id,
            status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [row.request_id, row.org_id, row.app_id, row.requested_by, row.reason, row.approver_person_id,
            row.status, row.created_at]);
    return row;
}

/**
 * The queue, narrowed to the rows actually named to this approver — unlike
 * wiki's own broader "see everyone's, flagged is_approver" queue, an app's
 * approver is often just a regular employee, not someone who'd want or need
 * visibility into requests they can't act on.
 */
exports.pendingRequestsForApproverAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "app.access.approve", "read app-access requests");
    const requests = await dblayer.getQueryOrThrow(
        `SELECT r.*, c.name AS app_name FROM app_access_request r JOIN app_catalogue c ON c.app_id = r.app_id
            WHERE r.org_id=? AND r.status='pending' AND r.approver_person_id=? ORDER BY r.created_at ASC`,
        [org_id, actor_person_id]);
    return {requests};
}

/** @param {object} request {org_id, actor_person_id, request_id, decision, decision_reason} */
exports.decideRequestAsync = async function(request) {
    const {org_id, actor_person_id, request_id, decision} = request;
    if (!["approved", "denied"].includes(decision)) throw new Error("decision must be approved or denied.");
    const pending = (await dblayer.getQueryOrThrow(
        "SELECT * FROM app_access_request WHERE org_id=? AND request_id=?", [org_id, request_id]))[0];
    if (!pending || pending.status != "pending") throw new Error(`Request ${request_id} is not awaiting a decision.`);
    if (!pending.approver_person_id || pending.approver_person_id != actor_person_id) throw new Error(
        "Only this request's named approver can decide it.");

    if (decision == "denied") {
        if (!request.decision_reason?.trim()) throw new Error("A denial needs a reason.");
        await dblayer.runCmdOrThrow(
            "UPDATE app_access_request SET status='denied', decided_at=?, decision_reason=? WHERE request_id=?",
            [_now(), request.decision_reason, request_id]);
        return {status: "denied"};
    }

    return await audit.performAsync({
        org_id, actor_person_id, capability: "app.access.approve",
        audit: {action: "integration.access_granted", object_type: "app_access_request", object_ref: request_id,
            subject_person_id: pending.requested_by, detail: {app_id: pending.app_id}},
        action: async exec => {
            await exec.runCmd("UPDATE app_access_request SET status='approved', decided_at=? WHERE request_id=?",
                [_now(), request_id]);
            await exec.runCmd(
                `INSERT INTO app_access (org_id, app_id, person_id, granted_at, granted_by) VALUES (?,?,?,?,?)
                    ON CONFLICT (org_id, app_id, person_id) DO UPDATE SET granted_at=excluded.granted_at,
                        granted_by=excluded.granted_by, revoked_at=NULL`,
                [org_id, pending.app_id, pending.requested_by, _now(), actor_person_id]);
            return {status: "approved"};
        }});
}

// ---------------------------------------------------------------------------
// manual connections — the deep links a person attaches themselves
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, app_id, task_ref, label, url} */
exports.linkTaskAsync = async function(request) {
    const {org_id, actor_person_id, app_id, task_ref, label, url} = request;
    if (!task_ref || !label?.trim() || !url?.trim()) throw new Error("A connection needs a task, a label and a URL.");
    const app = (await dblayer.getQueryOrThrow("SELECT 1 FROM app_catalogue WHERE org_id=? AND app_id=?",
        [org_id, app_id]))[0];
    if (!app) throw new Error(`No app ${app_id}.`);

    const row = {link_id: _uuid(), org_id, app_id, task_ref, person_id: actor_person_id,
        label: label.trim(), url: url.trim(), created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO app_task_link (link_id, org_id, app_id, task_ref, person_id, label, url, created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
        [row.link_id, row.org_id, row.app_id, row.task_ref, row.person_id, row.label, row.url, row.created_at]);
    return row;
}

exports.myLinksAsync = async function(org_id, person_id) {
    const links = await dblayer.getQueryOrThrow(
        `SELECT l.*, c.name AS app_name FROM app_task_link l JOIN app_catalogue c ON c.app_id = l.app_id
            WHERE l.org_id=? AND l.person_id=? ORDER BY l.created_at DESC`, [org_id, person_id]);
    return {links};
}

exports.removeLinkAsync = async function(org_id, actor_person_id, link_id) {
    const link = (await dblayer.getQueryOrThrow("SELECT * FROM app_task_link WHERE org_id=? AND link_id=?",
        [org_id, link_id]))[0];
    if (!link) throw new Error(`No connection ${link_id}.`);
    if (link.person_id != actor_person_id) throw new Error("Only the person who made this connection can remove it.");
    await dblayer.runCmdOrThrow("DELETE FROM app_task_link WHERE org_id=? AND link_id=?", [org_id, link_id]);
    return "removed";
}

// ---------------------------------------------------------------------------
// admin — the catalogue and the seat-usage report that pays for the log
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, app_id?, name, category, launch_url, launch_label,
 *      requires_request, cost_per_seat_minor, cost_currency, approver_person_id, deprecated} */
exports.saveAppAsync = async function(request) {
    const {org_id, app_id} = request;
    await _requireAsync(org_id, request.actor_person_id, "app.catalogue.manage", "manage the app catalogue");
    if (!request.name?.trim()) throw new Error("An app needs a name.");

    if (app_id) {
        const existing = (await dblayer.getQueryOrThrow("SELECT 1 FROM app_catalogue WHERE org_id=? AND app_id=?",
            [org_id, app_id]))[0];
        if (!existing) throw new Error(`No app ${app_id}.`);
        await dblayer.runCmdOrThrow(
            `UPDATE app_catalogue SET name=?, category=?, launch_url=?, launch_label=?, requires_request=?,
                cost_per_seat_minor=?, cost_currency=?, approver_person_id=?, deprecated=?
                WHERE org_id=? AND app_id=?`,
            [request.name, request.category||null, request.launch_url||null, request.launch_label||"Open",
                request.requires_request?1:0, request.cost_per_seat_minor||null, request.cost_currency||null,
                request.approver_person_id||null, request.deprecated?1:0, org_id, app_id]);
        return {app_id};
    }

    const row = {app_id: _uuid(), org_id, name: request.name, category: request.category||null,
        launch_url: request.launch_url||null, launch_label: request.launch_label||"Open",
        requires_request: request.requires_request?1:0, cost_per_seat_minor: request.cost_per_seat_minor||null,
        cost_currency: request.cost_currency||null, approver_person_id: request.approver_person_id||null,
        deprecated: 0, created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO app_catalogue (app_id, org_id, name, category, launch_url, launch_label, requires_request,
            cost_per_seat_minor, cost_currency, approver_person_id, deprecated, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.app_id, row.org_id, row.name, row.category, row.launch_url, row.launch_label, row.requires_request,
            row.cost_per_seat_minor, row.cost_currency, row.approver_person_id, row.deprecated, row.created_at]);
    return row;
}

/**
 * Seat usage over the trailing 60 days — the honest, grant/notify-free core
 * of H3's reclaim report. Idle means seats exist but nobody opened the app.
 */
exports.usageReportAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "app.catalogue.manage", "read the seat-usage report");
    const since = _now() - USAGE_WINDOW_DAYS*86400;
    const apps = await dblayer.getQueryOrThrow("SELECT * FROM app_catalogue WHERE org_id=? ORDER BY name ASC", [org_id]);

    const rows = [];
    for (const app of apps) {
        const seats = (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS n FROM app_access WHERE org_id=? AND app_id=? AND revoked_at IS NULL",
            [org_id, app.app_id]))[0].n;
        const launches60d = (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS n FROM app_launch_event WHERE org_id=? AND app_id=? AND occurred_at >= ?",
            [org_id, app.app_id, since]))[0].n;
        rows.push({app_id: app.app_id, name: app.name, category: app.category, launch_url: app.launch_url,
            launch_label: app.launch_label, requires_request: Boolean(app.requires_request),
            approver_person_id: app.approver_person_id, deprecated: Boolean(app.deprecated),
            seats, launches_60d: launches60d, idle: seats > 0 && launches60d == 0,
            cost_per_seat_minor: app.cost_per_seat_minor, cost_currency: app.cost_currency});
    }
    return {apps: rows};
}
