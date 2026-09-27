/**
 * L4 — incident mode: the four named phases the wireframe asks for —
 * contain, assess, notify, record — each backed by a real query or a
 * real write. No outbound notification is ever sent (no email
 * infrastructure exists anywhere in this app, the same narrowing L3
 * applied to its own notify-adjacent pieces); Notify records the drafted
 * message and the named affected people as the durable evidence of what
 * was decided, which is what "Record" then exports.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const sessions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/sessions.js`);

const _uuid = _ => serverutils.generateUUID(false);
const _now = _ => Math.floor(Date.now()/1000);
const REGULATORY_CLOCK_SECONDS = 72*3600;

async function _requireManageAsync(org_id, actor_person_id) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "incident.manage"});
}

async function _incidentRowAsync(org_id, incident_id) {
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM security_incident WHERE org_id=? AND incident_id=?",
        [org_id, incident_id]);
    return rows.length ? rows[0] : null;
}

async function _addActionViaAsync(exec, org_id, incident_id, actor_person_id, kind, detail) {
    await exec.runCmd(`INSERT INTO security_incident_action (action_id, org_id, incident_id, kind, detail,
        actor_person_id, occurred_at) VALUES (?,?,?,?,?,?,?)`,
        [_uuid(), org_id, incident_id, kind, JSON.stringify(detail), actor_person_id, _now()]);
}

/** @param {object} request {org_id, actor_person_id, title, awareness_at} */
exports.openIncidentAsync = async function(request) {
    if (!request.title?.trim()) throw new Error("An incident needs a title.");
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "incident.manage",
        audit: {action: "incident.opened", object_type: "security_incident", detail: {title: request.title}},
        action: async exec => {
            const row = {incident_id: _uuid(), org_id: request.org_id, title: request.title.trim(),
                status: "open", opened_at: _now(), opened_by: request.actor_person_id,
                awareness_at: request.awareness_at || _now(), closed_at: null, conclusion: null};
            await exec.runCmd(`INSERT INTO security_incident (incident_id, org_id, title, status, opened_at,
                opened_by, awareness_at, closed_at, conclusion) VALUES (?,?,?,?,?,?,?,?,?)`,
                [row.incident_id, row.org_id, row.title, row.status, row.opened_at, row.opened_by,
                    row.awareness_at, row.closed_at, row.conclusion]);
            return row;
        }});
}

/** @param {object} request {org_id, actor_person_id, incident_id, conclusion} */
exports.closeIncidentAsync = async function(request) {
    if (!request.conclusion?.trim()) throw new Error("Closing an incident needs a conclusion.");
    const incident = await _incidentRowAsync(request.org_id, request.incident_id);
    if (!incident) throw new Error(`No incident ${request.incident_id}.`);
    if (incident.status == "closed") throw new Error("This incident is already closed.");
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "incident.manage",
        audit: {action: "incident.closed", object_type: "security_incident", object_ref: request.incident_id,
            detail: {conclusion: request.conclusion.trim()}},
        action: async exec => {
            await exec.runCmd("UPDATE security_incident SET status='closed', closed_at=?, conclusion=? WHERE org_id=? AND incident_id=?",
                [_now(), request.conclusion.trim(), request.org_id, request.incident_id]);
            return "closed";
        }});
}

/**
 * The Contain phase — requires incident.manage in its own right, even
 * though it calls into sessions.revokeSessionsForAsync, which separately
 * requires session.manage. Both are admin-only in this design, so no
 * practical gap; each layer still enforces its own capability.
 * @param {object} request {org_id, actor_person_id, incident_id, person_id, role_name, whole_org, reason}
 */
exports.containSessionsAsync = async function(request) {
    await _requireManageAsync(request.org_id, request.actor_person_id);
    const incident = await _incidentRowAsync(request.org_id, request.incident_id);
    if (!incident) throw new Error(`No incident ${request.incident_id}.`);

    const result = await sessions.revokeSessionsForAsync({org_id: request.org_id, actor_person_id: request.actor_person_id,
        person_id: request.person_id, role_name: request.role_name, whole_org: request.whole_org, reason: request.reason});
    await dblayer.runInTransactionAsync(async exec => _addActionViaAsync(exec, request.org_id, request.incident_id,
        request.actor_person_id, "contain_sessions", {revoked_count: result.revoked_count,
            target: request.person_id ? {person_id: request.person_id} : request.role_name ? {role_name: request.role_name} : {whole_org: true}}));
    return result;
}

/**
 * The Assess phase — "what did this session's person touch": a direct
 * audit_event query by actor (not subject — a different question from
 * what audit.queryAsync answers).
 * @param {object} request {org_id, actor_person_id, incident_id, person_id, from, to}
 */
exports.assessAsync = async function(request) {
    await _requireManageAsync(request.org_id, request.actor_person_id);
    const incident = await _incidentRowAsync(request.org_id, request.incident_id);
    if (!incident) throw new Error(`No incident ${request.incident_id}.`);

    const events = await dblayer.getQueryOrThrow(
        `SELECT * FROM audit_event WHERE org_id=? AND actor_person_id=? AND occurred_at BETWEEN ? AND ?
            ORDER BY occurred_at ASC`, [request.org_id, request.person_id, request.from, request.to]);
    await dblayer.runInTransactionAsync(async exec => _addActionViaAsync(exec, request.org_id, request.incident_id,
        request.actor_person_id, "assess", {person_id: request.person_id, from: request.from, to: request.to, event_count: events.length}));
    return {events};
}

/**
 * The Notify phase — records the drafted message and the named affected
 * people. No dispatch: no email infrastructure exists anywhere in this app.
 * @param {object} request {org_id, actor_person_id, incident_id, person_ids, message}
 */
exports.notifyAsync = async function(request) {
    await _requireManageAsync(request.org_id, request.actor_person_id);
    if (!request.message?.trim()) throw new Error("A notification needs a message.");
    if (!request.person_ids?.length) throw new Error("Name at least one affected person.");
    const incident = await _incidentRowAsync(request.org_id, request.incident_id);
    if (!incident) throw new Error(`No incident ${request.incident_id}.`);

    await dblayer.runInTransactionAsync(async exec => _addActionViaAsync(exec, request.org_id, request.incident_id,
        request.actor_person_id, "notify", {person_ids: request.person_ids, message: request.message.trim()}));
    return "recorded";
}

/** @param {object} request {org_id, actor_person_id, incident_id, text} */
exports.addNoteAsync = async function(request) {
    await _requireManageAsync(request.org_id, request.actor_person_id);
    if (!request.text?.trim()) throw new Error("A note needs text.");
    const incident = await _incidentRowAsync(request.org_id, request.incident_id);
    if (!incident) throw new Error(`No incident ${request.incident_id}.`);

    await dblayer.runInTransactionAsync(async exec => _addActionViaAsync(exec, request.org_id, request.incident_id,
        request.actor_person_id, "note", {text: request.text.trim()}));
    return "noted";
}

exports.incidentsAsync = async function(org_id, actor_person_id) {
    await _requireManageAsync(org_id, actor_person_id);
    return {incidents: await dblayer.getQueryOrThrow(
        "SELECT * FROM security_incident WHERE org_id=? ORDER BY opened_at DESC", [org_id])};
}

/**
 * The full incident: its own row, its timeline, and the 72-hour
 * regulatory clock computed from awareness_at — not opened_at, since the
 * wireframe is explicit the clock starts at awareness of the incident,
 * not at the moment someone got around to recording it.
 */
exports.incidentDetailAsync = async function(org_id, actor_person_id, incident_id) {
    await _requireManageAsync(org_id, actor_person_id);
    const incident = await _incidentRowAsync(org_id, incident_id);
    if (!incident) throw new Error(`No incident ${incident_id}.`);
    const actions = await dblayer.getQueryOrThrow(
        "SELECT * FROM security_incident_action WHERE org_id=? AND incident_id=? ORDER BY occurred_at ASC, rowid ASC",
        [org_id, incident_id]);
    const regulatory_clock_seconds = _now() - incident.awareness_at;
    return {incident, actions: actions.map(action => ({...action, detail: JSON.parse(action.detail)})),
        regulatory_clock_seconds, regulatory_clock_breached: regulatory_clock_seconds > REGULATORY_CLOCK_SECONDS};
}
