/**
 * A9 — the notification spine. One catalogue, one volume control, one rule:
 * the working window (E4) is the send window, and only two categories may
 * breach it. An event not on the catalogue does not notify; most events resolve
 * into the clock-in brief (B4).
 *
 * Routing per raise:
 *   - unknown category                     -> refused, catalogue gate (A9 #6)
 *   - recipient's volume set to off        -> muted (fixed categories ignore it)
 *   - breaks_window                        -> delivered immediately
 *   - brief-only channels                  -> brief (B4 picks it up)
 *   - digest-only channels                 -> digest
 *   - inside the recipient's window        -> delivered
 *   - outside it                           -> digest when the category has it, else brief
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);

const _now = () => Math.floor(Date.now()/1000);

const LEVELS = Object.freeze({LIVE: "live", DIGEST: "digest", OFF: "off"});
const STATUS = Object.freeze({DELIVERED: "delivered", BRIEF: "brief", DIGEST: "digest", MUTED: "muted"});

/**
 * The catalogue (A9 #2). If an event is not on this list it does not notify —
 * it appears in the feed and waits. Only the two marked breaks_window may reach
 * a person outside their working window.
 */
const CATALOGUE = Object.freeze({
    security_incident: {label: "Security incident affecting you", reaches: "person",
        channels: ["push", "email"], timing: "immediate", breaks_window: true, mutable: false},
    account_deprovisioned: {label: "Your account was deprovisioned", reaches: "person",
        channels: ["email"], timing: "immediate", breaks_window: true, mutable: false},
    approval_sla: {label: "Approval waiting past SLA", reaches: "approver",
        channels: ["in_app", "digest"], timing: "window_open", breaks_window: false, mutable: "snooze"},
    became_blocker: {label: "You became the blocker", reaches: "person",
        channels: ["in_app"], timing: "window_open", breaks_window: false, mutable: true},
    leave_decision: {label: "Leave decision on your request", reaches: "requester",
        channels: ["in_app", "email"], timing: "window_open", breaks_window: false, mutable: false},
    meeting_starting: {label: "Meeting starting, you're the owner", reaches: "owner",
        channels: ["push"], timing: "10m_before", breaks_window: false, mutable: true},
    page_past_review: {label: "Page you own is past review", reaches: "owner",
        channels: ["digest"], timing: "weekly", breaks_window: false, mutable: true},
    wellbeing_signal: {label: "Wellbeing signal lit", reaches: "person",
        channels: ["in_app"], timing: "weekly_max1", breaks_window: false, mutable: true},
    task_assigned: {label: "Task assigned to you", reaches: "assignee",
        channels: ["brief"], timing: "next_window_open", breaks_window: false, mutable: true},
    comment_mention: {label: "Comment, mention, wiki change", reaches: "watchers",
        channels: ["brief"], timing: "batched", breaks_window: false, mutable: true}
});

/**
 * Raises a notification for the recipient. The catalogue gates it and the
 * working window routes it; the row is written once with its bucket.
 *
 * @param {object} request {org_id, category, recipient_person_id, actor_person_id,
 *      payload, object_ref}
 * @returns {object} {notification_id, category, status}
 */
exports.notifyAsync = async function(request) {
    const category = CATALOGUE[request.category];
    if (!category) throw new Error(
        `${request.category} is not in the notification catalogue. An event not on the list does not notify (A9).`);

    const level = await exports.volumeOfAsync(request.org_id, request.recipient_person_id, request.category);
    if (level == LEVELS.OFF && category.mutable !== false) {
        const row = await _insertAsync(request, STATUS.MUTED);
        return {notification_id: row.notification_id, category: request.category, status: STATUS.MUTED};
    }
    if (level == LEVELS.DIGEST && category.channels.includes("digest") && !category.breaks_window) {
        const row = await _insertAsync(request, STATUS.DIGEST);
        return {notification_id: row.notification_id, category: request.category, status: STATUS.DIGEST};
    }

    if (category.breaks_window) {
        const row = await _insertAsync(request, STATUS.DELIVERED);
        return {notification_id: row.notification_id, category: request.category, status: STATUS.DELIVERED};
    }
    if (category.channels.includes("brief") && !category.channels.includes("digest")) {
        const row = await _insertAsync(request, STATUS.BRIEF);
        return {notification_id: row.notification_id, category: request.category, status: STATUS.BRIEF};
    }

    const windowCheck = await windows.withinWindowAtAsync(request.org_id, request.recipient_person_id);
    const status = windowCheck.within ? STATUS.DELIVERED :
        (category.channels.includes("digest") ? STATUS.DIGEST : STATUS.BRIEF);
    const row = await _insertAsync(request, status);
    return {notification_id: row.notification_id, category: request.category, status,
        within_window: windowCheck.within, window_reason: windowCheck.reason};
}

async function _insertAsync(request, status) {
    const row = {notification_id: serverutils.generateUUID(false), org_id: request.org_id,
        recipient_person_id: request.recipient_person_id, category: request.category, status,
        payload: request.payload === undefined ? null : JSON.stringify(request.payload),
        object_ref: request.object_ref || null, actor_person_id: request.actor_person_id || null,
        raised_at: _now(), delivered_at: status == STATUS.DELIVERED ? _now() : null};
    await dblayer.runCmdOrThrow(
        `INSERT INTO notification (notification_id, org_id, recipient_person_id, category, status,
            payload, object_ref, actor_person_id, raised_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [row.notification_id, row.org_id, row.recipient_person_id, row.category, row.status,
            row.payload, row.object_ref, row.actor_person_id, row.raised_at, row.delivered_at]);
    return row;
}

/** The rows waiting in the person's brief bucket (B4 merges these). */
exports.briefQueueAsync = async function(org_id, person_id) {
    return await dblayer.getQueryOrThrow(
        `SELECT * FROM notification WHERE org_id=? AND recipient_person_id=? AND status='brief'
            ORDER BY raised_at ASC`,
        [org_id, person_id]);
}

/** Marks the person's brief rows as delivered — the brief was shown. */
exports.ackBriefAsync = async function(org_id, person_id, notification_ids) {
    const rows = await exports.briefQueueAsync(org_id, person_id);
    const targets = rows.filter(row => !notification_ids || notification_ids.includes(row.notification_id));
    for (const row of targets)
        await dblayer.runCmdOrThrow(
            "UPDATE notification SET status='delivered', delivered_at=? WHERE notification_id=? AND status='brief'",
            [_now(), row.notification_id]);
    return targets.length;
}

/** The recipient's volume for one category — defaults to live. */
exports.volumeOfAsync = async function(org_id, person_id, category) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM notification_setting WHERE org_id=? AND person_id=? AND category=?",
        [org_id, person_id, category]);
    return rows.length ? rows[0].level : LEVELS.LIVE;
}

/** The recipient's whole volume map. */
exports.volumeMapAsync = async function(org_id, person_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM notification_setting WHERE org_id=? AND person_id=?", [org_id, person_id]);
    const map = {};
    for (const row of rows) map[row.category] = row.level;
    return map;
}

/**
 * The person's volume control for one category — never per module. Fixed
 * categories (the two that breach the window) have no dial.
 * @returns The setting row
 */
exports.setVolumeAsync = async function(org_id, person_id, category, level) {
    const entry = CATALOGUE[category];
    if (!entry) throw new Error(`${category} is not in the notification catalogue.`);
    if (!Object.values(LEVELS).includes(level)) throw new Error(
        `Level must be one of ${Object.values(LEVELS).join(", ")}.`);
    if (entry.mutable === false && level != LEVELS.LIVE) throw new Error(
        `The ${category} notification is fixed at live — it is one of the two that may breach the window.`);
    await dblayer.runCmdOrThrow(
        `INSERT OR REPLACE INTO notification_setting (org_id, person_id, category, level) VALUES (?,?,?,?)`,
        [org_id, person_id, category, level]);
    return {category, level};
}

/**
 * What A9 watches: sends per category with their buckets, and the share of
 * people who muted each category — a mute rate over a third is a design defect,
 * not a preference.
 */
exports.volumeStatsAsync = async function(org_id) {
    const sends = await dblayer.getQueryOrThrow(
        `SELECT category, COUNT(*) AS raised,
            SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN status='brief' THEN 1 ELSE 0 END) AS brief,
            SUM(CASE WHEN status='digest' THEN 1 ELSE 0 END) AS digest,
            SUM(CASE WHEN status='muted' THEN 1 ELSE 0 END) AS muted
            FROM notification WHERE org_id=? GROUP BY category`,
        [org_id]);
    const settings = await dblayer.getQueryOrThrow(
        `SELECT category,
            SUM(CASE WHEN level='live' THEN 1 ELSE 0 END) AS live_settings,
            SUM(CASE WHEN level='digest' THEN 1 ELSE 0 END) AS digest_settings,
            SUM(CASE WHEN level='off' THEN 1 ELSE 0 END) AS off_settings
            FROM notification_setting WHERE org_id=? GROUP BY category`,
        [org_id]);

    const byCategory = {};
    for (const row of sends) byCategory[row.category] = {...row};
    for (const row of settings) {
        const entry = byCategory[row.category] || (byCategory[row.category] =
            {category: row.category, raised: 0, delivered: 0, brief: 0, digest: 0, muted: 0});
        entry.live_settings = row.live_settings; entry.digest_settings = row.digest_settings;
        entry.off_settings = row.off_settings;
        const dials = row.live_settings + row.digest_settings + row.off_settings;
        entry.mute_share = dials ? Math.round(100 * row.off_settings / dials) : 0;
    }
    const per_category = Object.values(byCategory).map(entry => ({
        category: entry.category, raised: entry.raised, delivered: entry.delivered,
        brief: entry.brief, digest: entry.digest, muted: entry.muted,
        mute_share: entry.mute_share || 0}));
    return {per_category,
        total_raised: per_category.reduce((sum, entry) => sum + entry.raised, 0)};
}

exports.CATALOGUE = CATALOGUE;
exports.LEVELS = LEVELS;
exports.STATUS = STATUS;
