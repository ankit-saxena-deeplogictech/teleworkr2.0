/**
 * B4 — the clock-in brief. The overnight backlog, ranked not by recency but by
 * whether the other person is awake. Four buckets in priority order: blocks
 * you, needs a reply, moved, decided — anything else is noise and belongs in
 * F3. Rules-based on purpose: explainability is what makes it trusted.
 *
 * States: quiet (nothing to say, one line), normal, heavy (>15 items, grouped),
 * chronological (no declared window — ranking by "who's awake" is unavailable,
 * so the feed falls back to plain time order).
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);

const BUCKETS = Object.freeze({BLOCKS_YOU: "blocks_you", NEEDS_REPLY: "needs_reply",
    MOVED: "moved", DECIDED: "decided"});
const _now = () => Math.floor(Date.now()/1000);

/**
 * The brief for a person: overnight task items in their four buckets, queued
 * notifications, the day strip, and the suggested order. Everything is read
 * from data the person can already open themselves — nothing new, just ordered
 * by who is awake (B4 #4).
 *
 * @param {object} request {org_id, person_id, since}
 * @returns {object} {state, since, items, notifications, summary, suggested_order}
 */
exports.briefAsync = async function(request) {
    const {org_id, person_id} = request;
    const now = _now();
    const since = request.since || await _lastClockInAsync(org_id, person_id) || now - 24*3600;

    const mine = await _myTasksAsync(org_id, person_id);
    const taskById = new Map(mine.map(task => [task.task_id, task]));

    const items = [
        ...await _blockEventsAsync(org_id, person_id, mine, since),
        ...await _commentItemsAsync(org_id, person_id, mine, since),
        ...await _statusItemsAsync(org_id, person_id, mine, since),
        ...await _assignedItemsAsync(org_id, person_id, mine, since)];
    items.sort((a, b) => a.at - b.at);

    const summary = {
        meetings: 0,     // honest zero until the calendar exists
        blocked_tasks: mine.filter(task => task.status == "blocked").length,
        due_today: mine.filter(task => task.due_date == _todayISO()).length,
        overdue: mine.filter(task => task.due_date && task.due_date < _todayISO() &&
            task.status != "done" && task.status != "blocked").length};

    // no declared window -> "who's awake" cannot be computed; plain chronological fallback
    const ownWindow = await windows.windowAsOfAsync(org_id, person_id, _todayISO());
    if (!ownWindow) return {state: "chronological", since, items, notifications:
        await notifications.briefQueueAsync(org_id, person_id), summary: null, suggested_order: null};

    return {state: items.length > 15 ? "heavy" : (items.length ? "normal" : "quiet"),
        since, items, notifications: await notifications.briefQueueAsync(org_id, person_id),
        summary, suggested_order: _suggestedOrder(items)};
}

/** Rules, not a model (B4 open): reply to who's awake, then unblock, then the rest. */
function _suggestedOrder(items) {
    const suggested = [];
    const awakeReplies = items.filter(item =>
        item.bucket == BUCKETS.NEEDS_REPLY && item.other_availability?.online_now);
    for (const item of awakeReplies.slice(0, 3)) suggested.push(
        {task_ref: item.task_ref, action: `Reply to ${item.by_name} while they're awake`});
    for (const item of items.filter(item => item.bucket == BUCKETS.BLOCKS_YOU)
        .slice(0, 3 - suggested.length)) suggested.push(
        {task_ref: item.task_ref, action: `Unblock ${item.task_ref}`});
    for (const item of items.filter(item =>
        !awakeReplies.includes(item) && item.bucket != BUCKETS.BLOCKS_YOU)
        .slice(0, 3 - suggested.length)) suggested.push(
        {task_ref: item.task_ref, action: `Then ${item.task_ref}`});
    return suggested;
}

async function _lastClockInAsync(org_id, person_id) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT MAX(started_at) AS last FROM time_entry_event
            WHERE org_id=? AND person_id=? AND started_at IS NOT NULL AND started_at <= ?`,
        [org_id, person_id, _now()]);
    return rows[0].last || null;
}

async function _myTasksAsync(org_id, person_id) {
    return await dblayer.getQueryOrThrow(
        `SELECT t.* FROM task t WHERE t.org_id=? AND (t.assignee_person_id=? OR t.task_id IN
            (SELECT w.task_id FROM task_watcher w WHERE w.org_id=? AND w.person_id=?))
            AND t.archived_at IS NULL`,
        [org_id, person_id, org_id, person_id]);
}

/** "Blocks you": a task of mine moved to blocked, or a block was added to it, overnight. */
async function _blockEventsAsync(org_id, person_id, mine, since) {
    const mineIds = mine.map(task => task.task_id);
    if (!mineIds.length) return [];
    const placeholders = mineIds.map(_ => "?").join(",");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT e.*, t.task_ref, t.title, p.display_name AS by_name FROM task_event e
            JOIN task t ON t.task_id=e.task_id
            LEFT JOIN person p ON p.person_id=e.actor_person_id
            WHERE e.org_id=? AND e.task_id IN (${placeholders}) AND e.created_at >= ?
                AND e.action='task.status_changed' AND e.actor_person_id != ?
            ORDER BY e.created_at ASC`,
        [org_id, ...mineIds, since, person_id]);
    const items = [];
    for (const row of rows) {
        const detail = JSON.parse(row.detail || "{}");
        if (detail.to != "blocked") continue;
        if (!mine.some(task => task.task_id == row.task_id && task.assignee_person_id == person_id)) continue;
        items.push(await _itemAsync(org_id, row, BUCKETS.BLOCKS_YOU,
            detail.reason || `blocked by ${row.by_name || "someone"}`));
    }
    return items;
}

/** "Needs a reply": someone else commented on a task assigned to me, overnight. */
async function _commentItemsAsync(org_id, person_id, mine, since) {
    const mineIds = mine.map(task => task.task_id);
    if (!mineIds.length) return [];
    const placeholders = mineIds.map(_ => "?").join(",");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT c.*, t.task_ref, t.title, p.display_name AS by_name FROM task_comment c
            JOIN task t ON t.task_id=c.task_id
            LEFT JOIN person p ON p.person_id=c.person_id
            WHERE c.org_id=? AND c.task_id IN (${placeholders}) AND c.created_at >= ?
                AND c.person_id != ?
            ORDER BY c.created_at ASC`,
        [org_id, ...mineIds, since, person_id]);
    const items = [];
    for (const row of rows) {
        if (!mine.some(task => task.task_id == row.task_id && task.assignee_person_id == person_id)) continue;
        items.push(await _itemAsync(org_id, row, BUCKETS.NEEDS_REPLY,
            row.body.substring(0, 120)));
    }
    return items;
}

/** "Moved": status changes on tasks I watch or own that are not blocks. */
async function _statusItemsAsync(org_id, person_id, mine, since) {
    const mineIds = mine.map(task => task.task_id);
    if (!mineIds.length) return [];
    const placeholders = mineIds.map(_ => "?").join(",");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT e.*, t.task_ref, t.title, p.display_name AS by_name FROM task_event e
            JOIN task t ON t.task_id=e.task_id
            LEFT JOIN person p ON p.person_id=e.actor_person_id
            WHERE e.org_id=? AND e.task_id IN (${placeholders}) AND e.created_at >= ?
                AND e.action='task.status_changed' AND e.actor_person_id != ?
            ORDER BY e.created_at ASC`,
        [org_id, ...mineIds, since, person_id]);
    const items = [];
    for (const row of rows) {
        const detail = JSON.parse(row.detail || "{}");
        if (detail.to == "blocked") continue;
        items.push(await _itemAsync(org_id, row, BUCKETS.MOVED,
            `${detail.from || "?"} -> ${detail.to || "?"}`));
    }
    return items;
}

/** "Decided": a task I watch or own was reassigned, overnight. */
async function _assignedItemsAsync(org_id, person_id, mine, since) {
    const mineIds = mine.map(task => task.task_id);
    if (!mineIds.length) return [];
    const placeholders = mineIds.map(_ => "?").join(",");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT e.*, t.task_ref, t.title, p.display_name AS by_name FROM task_event e
            JOIN task t ON t.task_id=e.task_id
            LEFT JOIN person p ON p.person_id=e.actor_person_id
            WHERE e.org_id=? AND e.task_id IN (${placeholders}) AND e.created_at >= ?
                AND e.action='task.assigned'
            ORDER BY e.created_at ASC`,
        [org_id, ...mineIds, since]);
    const items = [];
    for (const row of rows) {
        const detail = JSON.parse(row.detail || "{}");
        items.push(await _itemAsync(org_id, row, BUCKETS.DECIDED, "reassigned"));
    }
    return items;
}

/** Every item carries the other person's availability — that is the ranking signal (B4). */
async function _itemAsync(org_id, row, bucket, why) {
    const other = row.actor_person_id || row.person_id;
    let otherAvailability = {online_now: false, reason: "no_person"};
    if (other) {
        const check = await windows.withinWindowAtAsync(org_id, other);
        otherAvailability = {online_now: check.within,
            reason: check.reason, timezone: check.window?.timezone || null};
    }
    return {bucket, task_ref: row.task_ref, title: row.title, action: row.action,
        at: row.created_at, by_person_id: other, by_name: row.by_name || "someone",
        why, other_availability: otherAvailability};
}

const _todayISO = () => new Date().toISOString().substring(0, 10);

exports.BUCKETS = BUCKETS;
