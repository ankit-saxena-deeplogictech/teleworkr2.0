/**
 * Admin activity & logs — the day-level viewer.
 *
 * Reads what the app already records (sign-in sessions, app launches, the
 * time ledger, breaks, timesheets) and puts it in one place for whoever holds
 * activity.read_daily. Three views: the org-wide login log, one person's days,
 * and the per-app log.
 *
 * The granularity is the design, not a limitation. capabilities.js keeps
 * activity.read_minute_level and screen.read in CEILING: nobody may read
 * another person's minute-level activity or screen contents, with no grant
 * path and no admin override. So:
 *   - The login log keeps its timestamps — a sign-in is a security record that
 *     session.manage holders already read through sessions.detectionFeedAsync.
 *   - Person days and the app log are bucketed per (UTC) calendar day. App
 *     launches are per-app counts, never per-launch times; worked time is a
 *     day total, never clock-in/out times or gaps. No result row carries a
 *     started_at, ended_at or launch time.
 *   - There are no screenshots and no capture of any kind.
 *
 * Every read writes an `activity.viewed` audit entry (subject = the person
 * looked at, where there is one), so the viewed person can see who looked in
 * H4. Reads are computed first, outside any transaction, and the audit write
 * comes last — dblayer's serial queue would deadlock a read made from inside
 * audit.performAsync's callback.
 *
 * The permission check passes no subject_person_id: this is an org-scoped
 * cohort read, and ORG coverage verifies employment of any subject it is given.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);

const CAPABILITY = "activity.read_daily";
const DEFAULT_DAYS = 14;
const MAX_DAYS = 92;
const LOGIN_LOG_LIMIT = 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_SECONDS = 86400;

const _now = _ => Math.floor(Date.now()/1000);
const _dateOf = epoch => new Date(epoch*1000).toISOString().substring(0, 10);
const _startOf = date => Math.floor(new Date(`${date}T00:00:00Z`).getTime()/1000);
const _addDays = (date, days) => _dateOf(_startOf(date) + days*DAY_SECONDS);

/** @returns {object} {from, to} ISO dates, validated, defaulted to the last 14 days, capped at 92 days */
function _range(from, to) {
    const end = to || _dateOf(_now());
    const start = from || _addDays(end, -(DEFAULT_DAYS - 1));
    for (const [label, value] of [["from", start], ["to", end]]) if (!ISO_DATE.test(value))
        throw new Error(`${label} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}.`);
    if (start > end) throw new Error("from is after to.");
    if ((_startOf(end) - _startOf(start))/DAY_SECONDS + 1 > MAX_DAYS) throw new Error(
        `A range may span at most ${MAX_DAYS} days.`);
    return {from: start, to: end, fromEpoch: _startOf(start), toEpoch: _startOf(end) + DAY_SECONDS};
}

/** The permission gate, then the reads, then the audit entry — in that order. */
async function _readAsync(request, view, subject_person_id, compute) {
    const {org_id, actor_person_id} = request;
    await permissions.requireAsync({org_id, actor_person_id, capability: CAPABILITY});
    const range = _range(request.from, request.to);
    const result = await compute(range);
    await audit.performAsync({org_id, actor_person_id, capability: CAPABILITY,
        audit: {action: "activity.viewed", object_type: "activity", subject_person_id: subject_person_id || null,
            detail: {view, from: range.from, to: range.to, rows: result.count}},
        action: async _ => result.value});
    return {from: range.from, to: range.to, ...result.value};
}

/**
 * The org-wide login log — every sign-in in the range, newest first.
 * @param {object} request {org_id, actor_person_id, from, to, person_id, flagged_only}
 *      flagged_only keeps the "review" tier (two or more weak signals), same as the detection feed
 */
exports.loginLogAsync = async function(request) {
    return await _readAsync(request, "login_log", request.person_id, async range => {
        let sql = `SELECT s.session_id, s.person_id, s.ip, s.device_label, s.first_seen_for_person, s.signals,
                s.signed_in_at, s.revoked_at, p.display_name, p.email
            FROM session s JOIN person p ON p.person_id=s.person_id
            WHERE s.org_id=? AND s.signed_in_at >= ? AND s.signed_in_at < ?`;
        const params = [request.org_id, range.fromEpoch, range.toEpoch];
        if (request.person_id) {sql += " AND s.person_id=?"; params.push(request.person_id);}
        sql += ` ORDER BY s.signed_in_at DESC LIMIT ${LOGIN_LOG_LIMIT}`;

        let rows = (await dblayer.getQueryOrThrow(sql, params)).map(row => {
            const signals = row.signals ? JSON.parse(row.signals) : [];
            return {...row, signals, tier: signals.length >= 2 ? "review" : "quiet"};
        });
        if (request.flagged_only) rows = rows.filter(row => row.tier == "review");
        return {count: rows.length, value: {sessions: rows, truncated: rows.length >= LOGIN_LOG_LIMIT}};
    });
}

/**
 * One person's days: sign-ins, app launches as counts, worked total, breaks.
 * @param {object} request {org_id, actor_person_id, person_id, from, to}
 */
exports.personDaysAsync = async function(request) {
    if (!request.person_id) throw new Error("person_days needs a person_id.");
    return await _readAsync(request, "person_days", request.person_id, async range => {
        const {org_id, person_id} = request;
        const [sessionRows, launchRows, entryRows, breakRows, timesheetRows] = await Promise.all([
            dblayer.getQueryOrThrow(`SELECT signed_in_at, device_label, signals FROM session
                WHERE org_id=? AND person_id=? AND signed_in_at >= ? AND signed_in_at < ?`,
                [org_id, person_id, range.fromEpoch, range.toEpoch]),
            dblayer.getQueryOrThrow(`SELECT e.app_id, c.name, e.occurred_at FROM app_launch_event e
                JOIN app_catalogue c ON c.org_id=e.org_id AND c.app_id=e.app_id
                WHERE e.org_id=? AND e.person_id=? AND e.occurred_at >= ? AND e.occurred_at < ?`,
                [org_id, person_id, range.fromEpoch, range.toEpoch]),
            dblayer.getQueryOrThrow(`SELECT * FROM time_entry_event WHERE org_id=? AND person_id=?
                AND entry_date >= ? AND entry_date <= ? ORDER BY recorded_at ASC`, [org_id, person_id, range.from, range.to]),
            dblayer.getQueryOrThrow(`SELECT * FROM clock_break WHERE org_id=? AND person_id=?
                AND entry_date >= ? AND entry_date <= ? ORDER BY recorded_at ASC`, [org_id, person_id, range.from, range.to]),
            dblayer.getQueryOrThrow(`SELECT week_start, week_end, status FROM timesheet WHERE org_id=? AND person_id=?
                AND week_end >= ? AND week_start <= ?`, [org_id, person_id, range.from, range.to])]);

        const days = {};
        const day = date => days[date] || (days[date] = {date, sign_ins: 0, devices: new Set(), flagged_sign_ins: 0,
            app_launches: {}, worked_seconds: 0, billable_seconds: 0, reconstructed_entries: 0, breaks: 0,
            timesheet_status: null});

        for (const row of sessionRows) {
            const d = day(_dateOf(row.signed_in_at));
            d.sign_ins++; d.devices.add(row.device_label);
            if ((row.signals ? JSON.parse(row.signals) : []).length >= 2) d.flagged_sign_ins++;
        }
        for (const row of launchRows) {
            const d = day(_dateOf(row.occurred_at));
            d.app_launches[row.name] = (d.app_launches[row.name] || 0) + 1;
        }
        const now = _now();
        const entriesByDate = {};
        for (const row of entryRows) (entriesByDate[row.entry_date] || (entriesByDate[row.entry_date] = [])).push(row);
        for (const [date, rows] of Object.entries(entriesByDate)) {
            const d = day(date);
            for (const event of time.currentEvents(rows)) {
                const seconds = (event.ended_at === null && event.started_at ? Math.max(0, now - event.started_at) :
                    event.duration_seconds) || 0;
                d.worked_seconds += seconds;
                if (event.billable) d.billable_seconds += seconds;
                if (event.reconstructed) d.reconstructed_entries++;
            }
        }
        const supersededBreaks = new Set(breakRows.filter(row => row.supersedes_break_id).map(row => row.supersedes_break_id));
        for (const row of breakRows) if (!supersededBreaks.has(row.break_id)) day(row.entry_date).breaks++;

        // every day in the range appears, so a quiet day reads as quiet rather than missing
        const out = [];
        for (let date = range.from; date <= range.to; date = _addDays(date, 1)) {
            const d = day(date);
            d.timesheet_status = timesheetRows.find(t => t.week_start <= date && t.week_end >= date)?.status || null;
            out.push({...d, devices: [...d.devices]});
        }
        out.sort((a, b) => b.date.localeCompare(a.date));
        return {count: out.length, value: {days: out}};
    });
}

/**
 * The per-app log: launches and distinct users per app per day.
 * @param {object} request {org_id, actor_person_id, from, to, app_id}
 */
exports.appLogAsync = async function(request) {
    return await _readAsync(request, "app_log", null, async range => {
        let sql = `SELECT e.app_id, c.name, e.person_id, e.occurred_at FROM app_launch_event e
            JOIN app_catalogue c ON c.org_id=e.org_id AND c.app_id=e.app_id
            WHERE e.org_id=? AND e.occurred_at >= ? AND e.occurred_at < ?`;
        const params = [request.org_id, range.fromEpoch, range.toEpoch];
        if (request.app_id) {sql += " AND e.app_id=?"; params.push(request.app_id);}
        const rows = await dblayer.getQueryOrThrow(sql, params);

        const byKey = {};
        for (const row of rows) {
            const date = _dateOf(row.occurred_at), key = `${row.app_id}|${date}`;
            const entry = byKey[key] || (byKey[key] = {app_id: row.app_id, name: row.name, date, launches: 0, users: new Set()});
            entry.launches++; entry.users.add(row.person_id);
        }
        const days = Object.values(byKey).map(e => ({app_id: e.app_id, name: e.name, date: e.date,
            launches: e.launches, distinct_users: e.users.size}))
            .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
        return {count: days.length, value: {days}};
    });
}
