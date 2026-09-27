/**
 * L4 — sessions & devices.
 *
 * A session row is written on every real sign-in (apis/login.js's
 * _verifyJWT calls recordSignInAsync directly). No geo-location, no MDM —
 * neither exists anywhere in this app — so the two weak signals this
 * module computes are both real: whether this exact device (IP + user-
 * agent) has been seen for this person before, and whether the sign-in
 * falls outside their own declared working window (windows.js's own
 * withinWindowAtAsync, unchanged — when a person is on declared travel,
 * that function already resolves against the travel-kind window in
 * force, so "quiet because travel was declared" falls out for free).
 *
 * "Sign out" and bulk revoke mark the session record — tokens are
 * verified statelessly against an external IdP, with no revocation-list
 * check wired into the per-request auth path, so this is durable evidence
 * of the action taken, not a live kill switch. Stated in the UI, not
 * hidden.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);

const _uuid = _ => serverutils.generateUUID(false);
const _now = _ => Math.floor(Date.now()/1000);

/** Browser · OS, parsed from the user-agent string — "Unknown" rather than guessed. */
const BROWSERS = Object.freeze([["Edg/", "Edge"], ["Chrome/", "Chrome"], ["Firefox/", "Firefox"], ["Safari/", "Safari"]]);
const OSES = Object.freeze([["Windows", "Windows"], ["Mac OS X", "macOS"], ["Android", "Android"],
    ["iPhone", "iOS"], ["iPad", "iOS"], ["Linux", "Linux"]]);
function _deviceLabel(userAgent) {
    if (!userAgent) return "Unknown device";
    const browser = BROWSERS.find(([marker]) => userAgent.includes(marker))?.[1] || "Unknown browser";
    const os = OSES.find(([marker]) => userAgent.includes(marker))?.[1] || "Unknown OS";
    return `${browser} · ${os}`;
}

/**
 * The two weak signals this app can honestly compute for a sign-in.
 * Pinned into the row at sign-in time (A6: never re-derived against a
 * since-changed declared window).
 */
async function _weakSignalsAsync(org_id, person_id, signedInAt, firstSeenForPerson) {
    const signals = [];
    if (firstSeenForPerson) signals.push("new_device");
    const result = await windows.withinWindowAtAsync(org_id, person_id, signedInAt);
    if (result.window && !result.within) signals.push("outside_declared_window");
    return signals;
}

/**
 * Records a real sign-in. Called from apis/login.js's _verifyJWT — never
 * fails the sign-in itself; callers should catch and log rather than let
 * a session-recording error block authentication.
 * @param {object} request {org_id, person_id, ip, user_agent, signed_in_at}
 *      signed_in_at defaults to now — overridable the same way asOf is
 *      elsewhere, so the weak-signal check is testable deterministically
 * @returns The stored row, with signals as an array
 */
exports.recordSignInAsync = async function(request) {
    const {org_id, person_id, ip, user_agent} = request;
    const seenBefore = (await dblayer.getQueryOrThrow(
        "SELECT 1 AS x FROM session WHERE org_id=? AND person_id=? AND ip=? AND user_agent=? LIMIT 1",
        [org_id, person_id, ip||"", user_agent||""]))[0];

    const now = request.signed_in_at || _now();
    const row = {session_id: _uuid(), org_id, person_id, ip: ip||null, user_agent: user_agent||null,
        device_label: _deviceLabel(user_agent), first_seen_for_person: seenBefore ? 0 : 1,
        signed_in_at: now, last_seen_at: now};
    const signals = await _weakSignalsAsync(org_id, person_id, now, row.first_seen_for_person);

    await dblayer.runCmdOrThrow(
        `INSERT INTO session (session_id, org_id, person_id, ip, user_agent, device_label,
            first_seen_for_person, signals, signed_in_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [row.session_id, row.org_id, row.person_id, row.ip, row.user_agent, row.device_label,
            row.first_seen_for_person, JSON.stringify(signals), row.signed_in_at, row.last_seen_at]);
    return {...row, signals};
}

/** @param {string} org_id The org @param {string} actor_person_id The reader — self only */
exports.mySessionsAsync = async function(org_id, actor_person_id) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "session.read_own", subject_person_id: actor_person_id});
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM session WHERE org_id=? AND person_id=? ORDER BY signed_in_at DESC", [org_id, actor_person_id]);
    return {sessions: rows.map(row => ({...row, signals: row.signals ? JSON.parse(row.signals) : []}))};
}

/**
 * A person may sign themselves out of any of their own sessions — an
 * advisory revoke; the durable record, not a live kill switch.
 * @param {object} request {org_id, actor_person_id, session_id}
 */
exports.signOutSessionAsync = async function(request) {
    const session = (await dblayer.getQueryOrThrow("SELECT * FROM session WHERE org_id=? AND session_id=?",
        [request.org_id, request.session_id]))[0];
    if (!session) throw new Error(`No session ${request.session_id}.`);
    if (session.person_id != request.actor_person_id) throw new Error("You can only sign out your own sessions.");
    if (session.revoked_at) throw new Error("Already signed out.");
    await dblayer.runCmdOrThrow("UPDATE session SET revoked_at=?, revoked_by=? WHERE session_id=?",
        [_now(), request.actor_person_id, request.session_id]);
    return "signed_out";
}

/**
 * Bulk (advisory) revoke — the Contain lever. Resolves the target person
 * list with plain reads before opening the transaction, the established
 * compute-then-transact pattern for a capability that always accepts exec
 * on the write it wraps.
 * @param {object} request {org_id, actor_person_id, person_id, role_name, whole_org, reason}
 */
exports.revokeSessionsForAsync = async function(request) {
    let targetPersonIds;
    if (request.person_id) targetPersonIds = [request.person_id];
    else if (request.role_name) targetPersonIds = (await dblayer.getQueryOrThrow(
        "SELECT DISTINCT person_id FROM capability_grant WHERE org_id=? AND source_role=? AND revoked_at IS NULL",
        [request.org_id, request.role_name])).map(row => row.person_id);
    else if (request.whole_org) targetPersonIds = (await dblayer.getQueryOrThrow(
        "SELECT DISTINCT person_id FROM session WHERE org_id=? AND revoked_at IS NULL", [request.org_id]))
        .map(row => row.person_id);
    else throw new Error("Specify person_id, role_name or whole_org.");

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "session.manage",
        audit: {action: "session.revoked", object_type: "session",
            detail: {target: request.person_id ? {person_id: request.person_id} :
                request.role_name ? {role_name: request.role_name} : {whole_org: true}, reason: request.reason}},
        action: async exec => {
            if (!targetPersonIds.length) return {revoked_count: 0};
            const placeholders = targetPersonIds.map(_ => "?").join(",");
            const before = await exec.getQuery(
                `SELECT COUNT(*) AS c FROM session WHERE org_id=? AND revoked_at IS NULL AND person_id IN (${placeholders})`,
                [request.org_id, ...targetPersonIds]);
            const revoked_count = before[0]?.c || 0;
            if (revoked_count) await exec.runCmd(
                `UPDATE session SET revoked_at=?, revoked_by=?, revoke_reason=?
                    WHERE org_id=? AND revoked_at IS NULL AND person_id IN (${placeholders})`,
                [_now(), request.actor_person_id, request.reason||null, request.org_id, ...targetPersonIds]);
            return {revoked_count};
        }});
}

/**
 * The recent sign-in feed, tiered by how many weak signals combined.
 * @param {object} options {days} — default 14
 */
exports.detectionFeedAsync = async function(org_id, actor_person_id, options={}) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "session.manage"});
    const since = _now() - (options.days || 14) * 86400;
    const rows = await dblayer.getQueryOrThrow(
        `SELECT s.*, p.display_name, p.email FROM session s JOIN person p ON p.person_id=s.person_id
            WHERE s.org_id=? AND s.signed_in_at >= ? ORDER BY s.signed_in_at DESC`, [org_id, since]);
    return {sessions: rows.map(row => {
        const signals = row.signals ? JSON.parse(row.signals) : [];
        return {...row, signals, tier: signals.length >= 2 ? "review" : "quiet"};
    })};
}
