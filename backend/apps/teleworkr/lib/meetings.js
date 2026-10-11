/**
 * The minimal meeting/calendar-event entity E2 (event composer & cost),
 * F1-F5 (Telemeet, async video, handoff notes) and the meeting_starting
 * notification all sit on top of. This module is deliberately only that
 * foundation: create, cancel, list by date range, and the lazy
 * meeting_starting raise — no cost calculator, no WebRTC room, no async
 * video notes, no handoff notes, no recurrence. Those are separate,
 * larger slices, not silently folded in here.
 *
 * Modeled on officedays.js's shape: a small, org/person-scoped entity with
 * no capability gate beyond "is this your own data" — scheduling a meeting
 * needs no special permission, same as declaring your own office-day status
 * or working window.
 *
 * `raiseStartingSoonNotificationsAsync` is triggered from the notification
 * feed poll (apis/notifications.js), not from this screen's own load —
 * meeting_starting is a push/owner notification meant to reach someone who
 * isn't looking at the calendar, and the feed poll is the only ambient,
 * screen-independent poll this app has. No scheduler exists anywhere in
 * this backend (notifications.js's own note), so this is a best-effort
 * lazy check, not a guaranteed-exact 10-minutes-before push.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);

const STATUSES = Object.freeze({SCHEDULED: "scheduled", CANCELLED: "cancelled"});
const STARTING_SOON_WINDOW_SECONDS = 600;      // meeting_starting: "10m_before" in the catalogue
const STARTING_SOON_DEDUP_SECONDS = 1800;      // don't re-raise for the same meeting within this long

const _now = _ => Math.floor(Date.now()/1000);
const _dayBounds = date => {
    const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime()/1000);
    return {from: start, to: start + 86400};
};

/**
 * Creates a meeting. Owner is folded into attendees if not already present.
 * @param {object} request {org_id, owner_person_id, title, starts_at, ends_at, attendee_person_ids}
 * @returns {object} The stored row, attendees parsed back into an array
 */
exports.createAsync = async function(request) {
    const {org_id, owner_person_id, starts_at, ends_at} = request;
    const title = (request.title || "").trim();
    if (!title) throw new Error("A meeting needs a title.");
    if (!Number.isFinite(starts_at) || !Number.isFinite(ends_at) || starts_at >= ends_at)
        throw new Error("starts_at must be before ends_at.");

    const roster = await spine.rosterAsOfAsync(org_id);
    const rosterIds = new Set(roster.map(p => p.person_id));
    const attendees = Array.from(new Set([owner_person_id, ...(request.attendee_person_ids || [])]));
    for (const person_id of attendees)
        if (!rosterIds.has(person_id)) throw new Error(`${person_id} is not a person in this org.`);

    const meeting_id = serverutils.generateUUID(false);
    const now = _now();
    await dblayer.runCmdOrThrow(
        `INSERT INTO meeting (meeting_id, org_id, owner_person_id, title, starts_at, ends_at, attendees,
            status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [meeting_id, org_id, owner_person_id, title, starts_at, ends_at, JSON.stringify(attendees),
            STATUSES.SCHEDULED, now, now]);
    return {meeting_id, org_id, owner_person_id, title, starts_at, ends_at, attendees,
        status: STATUSES.SCHEDULED, created_at: now, updated_at: now};
}

/**
 * Cancels a meeting. Only the owner may cancel it.
 * @param {object} request {org_id, meeting_id, actor_person_id}
 */
exports.cancelAsync = async function(request) {
    const {org_id, meeting_id, actor_person_id} = request;
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM meeting WHERE org_id=? AND meeting_id=?", [org_id, meeting_id]);
    if (!rows.length) throw new Error("No such meeting.");
    if (rows[0].owner_person_id != actor_person_id) throw new Error("Only the owner can cancel this meeting.");

    await dblayer.runCmdOrThrow(
        "UPDATE meeting SET status=?, updated_at=? WHERE org_id=? AND meeting_id=?",
        [STATUSES.CANCELLED, _now(), org_id, meeting_id]);
    return "cancelled";
}

/**
 * Scheduled meetings in the date range where person_id is the owner or an
 * attendee. Small per-org dataset, read and filtered in JS — the same
 * shape officedays.js/calendar.js already use, no attendee-side SQL needed.
 * @param {string} org_id The org
 * @param {string} person_id Owner or attendee
 * @param {string} from_date ISO date, inclusive
 * @param {string} to_date ISO date, inclusive
 * `is_owner` is computed here, server-side, from the same `person_id` this
 * function already filters by — the same "server states who's self, the
 * client never compares ids itself" idiom officedays.js's week status
 * already uses for its own `is_self` flag.
 * @returns {array} [{meeting_id, owner_person_id, title, starts_at, ends_at, attendees, status, is_owner}]
 */
exports.forRangeAsync = async function(org_id, person_id, from_date, to_date) {
    const from = _dayBounds(from_date).from, to = _dayBounds(to_date).to;
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM meeting WHERE org_id=? AND status=? AND starts_at >= ? AND starts_at < ?
            ORDER BY starts_at ASC`,
        [org_id, STATUSES.SCHEDULED, from, to]);
    return rows.map(row => ({...row, attendees: JSON.parse(row.attendees), is_owner: row.owner_person_id == person_id}))
        .filter(row => row.owner_person_id == person_id || row.attendees.includes(person_id));
}

/**
 * The meeting_starting lazy check — same shape as leave.js's approval_sla
 * raise: computed the moment something polls, deduped so the same meeting
 * doesn't re-raise on every poll within the dedup window.
 * @param {string} org_id The org
 * @param {string} owner_person_id Whoever's feed poll triggered this check
 */
exports.raiseStartingSoonNotificationsAsync = async function(org_id, owner_person_id) {
    const now = _now();
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM meeting WHERE org_id=? AND owner_person_id=? AND status=?
            AND starts_at >= ? AND starts_at <= ?`,
        [org_id, owner_person_id, STATUSES.SCHEDULED, now, now + STARTING_SOON_WINDOW_SECONDS]);

    for (const meeting of rows) {
        if (await notifications.alreadyRaisedRecentlyAsync(
                org_id, owner_person_id, "meeting_starting", meeting.meeting_id, STARTING_SOON_DEDUP_SECONDS))
            continue;
        try {
            await notifications.notifyAsync({org_id, category: "meeting_starting",
                recipient_person_id: owner_person_id, object_ref: meeting.meeting_id,
                payload: {title: meeting.title, starts_at: meeting.starts_at}});
        } catch (err) {LOG.error(`Could not raise meeting_starting for ${meeting.meeting_id}: ${err}`);}
    }
}
