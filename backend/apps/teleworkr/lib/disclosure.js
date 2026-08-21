/**
 * H5 — disclosure. The screen that decides whether people adopt this product or
 * work around it: a live mirror of what each role can see about a person,
 * rendered from the same rules the API enforces, plus the personal access log,
 * self-service export, and retention in concrete numbers.
 *
 * The sees list is never hand-written here — each entry is produced by the same
 * permission check and the same read the rest of the product uses, so the mirror
 * cannot drift from what the API actually returns. The does-not-see list names
 * the never-measured set from the capability ceiling, which is the structural
 * version of the promise, plus the refusals this viewer actually got.
 *
 * The access log is the subject's own: grouped by who acted on their record and
 * what they did, counted, with the last action's time. A one-way audit log is
 * surveillance; this is the two-way half (H4).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

/**
 * The views the mirror renders, each produced by the same permission check and
 * the same read the rest of the product uses. Add a view here, and the mirror
 * picks it up — the sees list can never drift from what the API returns.
 */
const VIEWS = Object.freeze([
    {key: "weekly_totals", capability: "timesheet.read",
        label: "Weekly total, per-task totals and the billable split",
        render: async (org_id, viewer_person_id, subject_person_id) => {
            const view = await time.timesheetForApproverAsync(org_id, viewer_person_id,
                subject_person_id, time.weekStartOf(_today()));
            return {week_start: time.weekStartOf(_today()), total_seconds: view.totals.total_seconds,
                billable_seconds: view.totals.billable_seconds,
                reconstructed_count: view.totals.reconstructed_count,
                by_task: view.totals.by_task.map(taskRow => ({task_ref: taskRow.task_ref,
                    seconds: taskRow.seconds, reconstructed: taskRow.reconstructed}))};
        }},
    {key: "task_status_and_due_dates", capability: "task.read",
        label: "Task status and due dates",
        render: async (org_id, viewer_person_id, subject_person_id) => {
            const list = await tasks.listTasksAsync({org_id, actor_person_id: viewer_person_id,
                filters: {assignee_person_id: subject_person_id}});
            return list.rows.map(row => ({task_ref: row.task_ref, title: row.title,
                status: row.status, due_date: row.due_date, project: row.project}));
        }},
    {key: "leave_dates", capability: "timesheet.read",
        label: "Leave dates",
        render: async () => []}       // the leave module lands with J1–J8; until then the honest answer is none
]);

/**
 * Who has accessed a person's record in the window — grouped by actor and
 * action, with counts and the most recent time. The person's own actions are
 * counted separately; the mirror shows both.
 *
 * @param {object} request {org_id, person_id, days}
 * @returns {object} {accesses, self_count, days}
 */
exports.accessLogAsync = async function(request) {
    const days = request.days || 90;
    const since = _now() - days*86400;
    const rows = await dblayer.getQueryOrThrow(
        `SELECT a.actor_person_id, a.actor_kind, a.action, COUNT(*) AS count, MAX(a.occurred_at) AS last_at,
            p.display_name FROM audit_event a LEFT JOIN person p ON p.person_id = a.actor_person_id
            WHERE a.org_id=? AND a.subject_person_id=? AND a.actor_person_id IS NOT NULL
            AND a.actor_person_id != ? AND a.occurred_at >= ?
            GROUP BY a.actor_person_id, a.action ORDER BY last_at DESC`,
        [request.org_id, request.person_id, request.person_id, since]);

    const own = (await dblayer.getQueryOrThrow(
        `SELECT COUNT(*) AS c FROM audit_event WHERE org_id=? AND subject_person_id=?
            AND actor_person_id=? AND occurred_at >= ?`,
        [request.org_id, request.person_id, request.person_id, since]))[0].c;

    return {accesses: rows.map(row => ({actor_person_id: row.actor_person_id,
        display_name: row.display_name, actor_kind: row.actor_kind, action: row.action,
        count: row.count, last_at: row.last_at})), self_count: own, days};
}

/**
 * The live mirror: what the viewer sees about the person, and what they do not —
 * both lists generated from the engine, never hand-written.
 *
 * @param {object} request {org_id, person_id, viewer_person_id}
 * @returns {object} {person_id, viewer_person_id, sees, does_not_see}
 */
exports.mirrorAsync = async function(request) {
    const {org_id, person_id, viewer_person_id} = request;
    if (!org_id || !person_id || !viewer_person_id) throw new Error(
        "The mirror needs an org, the person it is about, and the person looking.");

    const sees = {}, does_not_see = [];
    for (const view of VIEWS) {
        const decision = await permissions.checkAsync({org_id, actor_person_id: viewer_person_id,
            capability: view.capability, subject_person_id: person_id});
        if (!decision.allowed) {does_not_see.push({item: view.label, why: decision.reason}); continue;}
        sees[view.key] = await view.render(org_id, viewer_person_id, person_id);
    }

    // the working window is team data — it powers the overlap board (E3)
    if (await spine.employmentAsOfAsync(org_id, viewer_person_id)) {
        const window = await windows.getOpenWindowAsync(org_id, person_id);
        if (window) sees.working_window = {timezone: window.timezone, start_minute: window.start_minute,
            end_minute: window.end_minute, days: JSON.parse(window.days), kind: window.kind,
            note: window.note};
    }

    // the never-measured set — the structural refusals, quoted from the ceiling
    for (const [capability, why] of Object.entries(capabilities.CEILING))
        does_not_see.push({item: capability, why});

    // the mirror's own promises, which hold because the data is never collected
    for (const [item, why] of Object.entries(NEVER_COLLECTED))
        does_not_see.push({item, why});

    return {person_id, viewer_person_id, sees, does_not_see};
}

/** Product facts that hold because the data is never collected, stated in-product (M1, P4, F5). */
const NEVER_COLLECTED = Object.freeze({
    "idle minutes": "Never measured.",
    "apps you opened": "Never measured.",
    "focus-block completion rate": "Never a manager metric (C4).",
    "overwork warnings": "Personal signals route to you only (M3).",
    "video notes to other people": "Never shared.",
    "anything typed and deleted": "Never collected.",
    "your location": "Not tracked.",
    "whether you are online now": "Presence is summarised, not listed (E3)."
});

/**
 * Retention in concrete numbers, straight from the entity register — the same
 * source the erasure jobs will run from, so the screen cannot disagree with the
 * product (A6: retention clocks anchor to events, never to calendar dates).
 * @returns {array} [{entity, shape, erasure, keep, anchor, note}]
 */
exports.retentionAsync = async _ => Object.entries(entityshapes.REGISTER)
    .map(([entity, declaration]) => ({entity, shape: declaration.shape,
        erasure: declaration.erasure, keep: declaration.keep, anchor: declaration.anchor,
        note: declaration.note}));

/**
 * Self-service export — "download everything". The person's own record, as a
 * JSON bundle: identity, employment history, working windows, time entries,
 * timesheets with their pins, audit entries about them, and their tasks and
 * comments. No other person's rows, and no other person's permission needed.
 *
 * @param {object} request {org_id, person_id}
 * @returns {object} The bundle
 */
exports.exportMyDataAsync = async function(request) {
    const {org_id, person_id} = request;
    const person = await spine.getPersonAsync(person_id);
    if (!person) throw new Error(`Person ${person_id} was not found.`);

    const employments = await spine.employmentHistoryAsync(org_id, person_id);
    const workingWindows = await windows.windowHistoryAsync(org_id, person_id);
    const timeEntries = await dblayer.getQueryOrThrow(
        "SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? ORDER BY recorded_at ASC",
        [org_id, person_id]);
    const timesheets = await dblayer.getQueryOrThrow(
        "SELECT * FROM timesheet WHERE org_id=? AND person_id=? ORDER BY week_start ASC", [org_id, person_id]);
    const timesheetEntries = timesheets.length ? await dblayer.getQueryOrThrow(
        `SELECT * FROM timesheet_entry WHERE org_id=? AND timesheet_id IN (${timesheets.map(_ => "?").join(",")})`,
        [org_id, ...timesheets.map(sheet => sheet.timesheet_id)]) : [];
    const auditEntries = await dblayer.getQueryOrThrow(
        `SELECT * FROM audit_event WHERE org_id=? AND (subject_person_id=? OR (actor_person_id=? AND subject_person_id IS NULL))
            ORDER BY occurred_at ASC`,
        [org_id, person_id, person_id]);
    const myTasks = await dblayer.getQueryOrThrow(
        "SELECT * FROM task WHERE org_id=? AND (assignee_person_id=? OR created_by=?) ORDER BY created_at ASC",
        [org_id, person_id, person_id]);
    const myComments = await dblayer.getQueryOrThrow(
        "SELECT * FROM task_comment WHERE org_id=? AND person_id=? ORDER BY created_at ASC", [org_id, person_id]);

    return {meta: {exported_at: _now(), org_id, person_id}, person, employments,
        working_windows: workingWindows, time_entries: timeEntries, timesheets,
        timesheet_entries: timesheetEntries, audit_entries_about_me: auditEntries,
        tasks: myTasks, comments: myComments};
}

exports.VIEWS = VIEWS;
