/**
 * Tests D1/D2 — the task domain. Sequential task references, the rule that
 * blocked-without-a-reason is just a colour, relations with their own
 * timestamps, the append-only activity trail and comments, audited reassignment
 * and deletion, and the time log projected from the ledger by task_ref.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests tasks
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const tasksapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/tasks.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Tasks test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "tasks")) {
        LOG.console("Skipping tasks test case, not called.\n"); return true;
    }
    LOG.console("\nD1/D2 tasks\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testCreate(w);
        await _testReadGate(w);
        await _testUpdate(w);
        await _testBlocks(w);
        await _testSubtasksAndWatchersAndComments(w);
        await _testAssignAndDelete(w);
        await _testTimeLog(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  tasks tests threw: ${err}\n`); LOG.error(`Tasks tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nTasks tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------

async function _testCreate(w) {
    LOG.console("\n creating tasks\n");
    const first = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
        title: "Single-pager web design for APIBot", project: "APIBot", due_date: "2026-08-24"});
    const second = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
        title: "Charts design-system integration", project: "Dashboard"});
    w.taskRefs = [first.task_ref, second.task_ref];
    _check("task references are sequential per org", first.task_ref == "TASK-1" && second.task_ref == "TASK-2",
        `${first.task_ref}, ${second.task_ref}`);
    _check("the assignee defaults to the creator", first.assignee_person_id == w.alice);
    const createdEvent = await dblayer.getQueryOrThrow(
        "SELECT * FROM task_event WHERE task_id=? AND action='task.created'", [first.task_id]);
    _check("creation lands in the activity trail", createdEvent.length == 1);

    const refused = await _checkThrows("a person with no task.create is refused", _ =>
        tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.erin, title: "Sneak task"}));
    _check("the refusal carries the decision", refused?.decision?.outcome == "no_grant");

    await _checkThrows("a titleless task is refused", _ =>
        tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: "  "}));
    await _checkThrows("an unknown status is refused", _ =>
        tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: "x", status: "vibing"}));
    await _checkThrows("an unknown priority is refused", _ =>
        tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: "x", priority: "urgent"}));
    await _checkThrows("a non-ISO due date is refused", _ =>
        tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: "x", due_date: "24/08/2026"}));
}

async function _testReadGate(w) {
    LOG.console("\n reading is gated, counts are exact\n");
    const refused = await _checkThrows("a person with no task.read is refused", _ =>
        tasks.listTasksAsync({org_id: w.org_id, actor_person_id: w.erin}));
    _check("the refusal names the capability", Boolean(refused?.decision));

    const list = await tasks.listTasksAsync({org_id: w.org_id, actor_person_id: w.alice});
    _check("the list states its exact scope", list.total == 2 && list.rows.length == 2,
        `${list.rows.length} of ${list.total}`);

    const filtered = await tasks.listTasksAsync({org_id: w.org_id, actor_person_id: w.alice,
        filters: {project: "APIBot"}});
    _check("filters narrow with an exact count", filtered.total == 1 && filtered.rows.length == 1);
    const byQuery = await tasks.listTasksAsync({org_id: w.org_id, actor_person_id: w.alice,
        filters: {q: "Charts"}});
    _check("a text filter finds the row", byQuery.total == 1 && byQuery.rows[0].task_ref == "TASK-2");
}

async function _testUpdate(w) {
    LOG.console("\n updates log their before and after\n");
    const updated = await tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
        task_ref: "TASK-1", changes: {status: "in_progress", project: "APIBot v2"}});
    _check("fields and status update", updated.status == "in_progress" && updated.project == "APIBot v2");

    const events = await dblayer.getQueryOrThrow(
        "SELECT * FROM task_event WHERE task_id=? ORDER BY created_at ASC", [updated.task_id]);
    const statusEvent = events.find(event => event.action == "task.status_changed");
    const fieldEvent = events.find(event => event.action == "task.updated");
    _check("the status transition is logged with the before and after",
        statusEvent && JSON.parse(statusEvent.detail).from == "to_do" &&
        JSON.parse(statusEvent.detail).to == "in_progress");
    _check("field changes are logged separately", fieldEvent &&
        JSON.parse(fieldEvent.detail).changed.includes("project"));

    await _checkThrows("an unknown change field is refused", _ =>
        tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
            task_ref: "TASK-1", changes: {colour: "red"}}));
    const blockedRefusal = await _checkThrows("a blocked status without a blocker is refused", _ =>
        tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
            task_ref: "TASK-1", changes: {status: "blocked"}}));
    _check("the refusal names the D1 rule", /just a colour/.test(blockedRefusal.message));
    await _checkThrows("a person with no task.edit is refused", _ =>
        tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.erin,
            task_ref: "TASK-1", changes: {title: "x"}}));
}

async function _testBlocks(w) {
    LOG.console("\n blocked means blocked on something, with a reason\n");
    await _checkThrows("a block without a reason is refused", _ =>
        tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
            blocker_task_ref: "TASK-1", blocked_task_ref: "TASK-2"}));
    await _checkThrows("a task cannot block itself", _ =>
        tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
            blocker_task_ref: "TASK-1", blocked_task_ref: "TASK-1", reason: "x"}));
    await _checkThrows("both ends of a block must exist", _ =>
        tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
            blocker_task_ref: "TASK-1", blocked_task_ref: "TASK-999", reason: "x"}));

    const relation = await tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
        blocker_task_ref: "TASK-1", blocked_task_ref: "TASK-2", reason: "waiting on brand assets"});
    _check("a block with a reason is recorded with its timestamps",
        relation.reason == "waiting on brand assets" && relation.created_at > 0);

    const blocked = (await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_ref='TASK-2'", []))[0];
    _check("the blocked task moves to blocked automatically", blocked.status == "blocked");

    const again = await tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
        blocker_task_ref: "TASK-1", blocked_task_ref: "TASK-2", reason: "same again"});
    _check("a second block on the same pair is idempotent", again.task_relation_id == relation.task_relation_id);

    const list = await tasks.listTasksAsync({org_id: w.org_id, actor_person_id: w.alice});
    const blockedRow = list.rows.find(row => row.task_ref == "TASK-2");
    _check("blocked rows name their blocker, its reason and how long",
        blockedRow.blocked_on?.length == 1 && blockedRow.blocked_on[0].blocker == "TASK-1" &&
        blockedRow.blocked_on[0].reason == "waiting on brand assets" &&
        blockedRow.blocked_on[0].blocked_seconds >= 0,
        JSON.stringify(blockedRow.blocked_on));

    // "blocked 6 days" stays answerable after the block is lifted
    await new Promise(resolve => setTimeout(resolve, 1100));   // so blocked_seconds moves off zero
    await tasks.resolveBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
        blocker_task_ref: "TASK-1", blocked_task_ref: "TASK-2"});
    const relationAfter = await dblayer.getQueryOrThrow(
        "SELECT * FROM task_relation WHERE task_relation_id=?", [relation.task_relation_id]);
    _check("lifting the block keeps the relation and its timestamps",
        relationAfter.length == 1 && relationAfter[0].resolved_at !== null && relationAfter[0].created_at > 0);
    const stillBlocked = (await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_ref='TASK-2'", []))[0];
    _check("unblocking leaves the status for a person to move", stillBlocked.status == "blocked");

    await tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
        task_ref: "TASK-2", changes: {status: "in_progress"}});
    _check("moving a task out of blocked is a normal status change",
        (await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_ref='TASK-2'", []))[0].status == "in_progress");
}

async function _testSubtasksAndWatchersAndComments(w) {
    LOG.console("\n subtasks, watchers, comments\n");
    const added = await tasks.addSubtaskAsync({org_id: w.org_id, actor_person_id: w.alice,
        parent_task_ref: "TASK-1", title: "Wireframe the hero"});
    _check("a subtask is a real task with its own reference",
        added.child.task_ref == "TASK-3" && added.relation.relation_type == "subtask");

    const detail = await tasks.taskDetailAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: "TASK-1"});
    _check("the parent lists its subtasks", detail.subtasks.length == 1 && detail.subtasks[0].task_ref == "TASK-3");
    _check("the parent activity records the subtask", detail.events.some(event => event.action == "task.subtask_added"));

    await tasks.addWatcherAsync({org_id: w.org_id, actor_person_id: w.bob, task_ref: "TASK-1"});
    const watched = await tasks.taskDetailAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: "TASK-1"});
    _check("watching is a relation with the watcher's name",
        watched.watchers.some(watcher => watcher.person_id == w.bob && watcher.display_name == "bob"));
    await tasks.removeWatcherAsync({org_id: w.org_id, actor_person_id: w.bob, task_ref: "TASK-1"});
    const unwatched = await tasks.taskDetailAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: "TASK-1"});
    _check("unwatching removes the relation", !unwatched.watchers.some(watcher => watcher.person_id == w.bob));

    await tasks.addCommentAsync({org_id: w.org_id, actor_person_id: w.bob, task_ref: "TASK-1",
        body: "Pricing copy is locked."});
    const commented = await tasks.taskDetailAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: "TASK-1"});
    _check("comments are appended with their author",
        commented.comments.length == 1 && commented.comments[0].body == "Pricing copy is locked.");
    _check("comments have no in-place update path",
        (_ => {try {entityshapes.assertUpdatable("task_comment"); return false;} catch (err) {return true;}})());
    await _checkThrows("an empty comment is refused", _ =>
        tasks.addCommentAsync({org_id: w.org_id, actor_person_id: w.bob, task_ref: "TASK-1", body: " "}));
}

async function _testAssignAndDelete(w) {
    LOG.console("\n reassignment and deletion are audited\n");
    await tasks.assignTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
        task_ref: "TASK-1", assignee_person_id: w.bob});
    const assigned = (await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_ref='TASK-1'", []))[0];
    _check("reassignment changes the assignee", assigned.assignee_person_id == w.bob);
    const auditRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='task.assigned' AND object_ref='TASK-1'",
        [w.org_id]))[0];
    _check("reassignment is always audited with the new assignee as subject",
        auditRow.subject_person_id == w.bob && JSON.parse(auditRow.detail).to == w.bob);
    const assignEvents = await dblayer.getQueryOrThrow(
        "SELECT * FROM task_event WHERE task_id=? AND action='task.assigned'", [assigned.task_id]);
    _check("the activity trail records the from and to",
        assignEvents.length == 1 && JSON.parse(assignEvents[0].detail).from == w.alice);

    await _checkThrows("a person with no task.assign is refused", _ =>
        tasks.assignTaskAsync({org_id: w.org_id, actor_person_id: w.erin,
            task_ref: "TASK-1", assignee_person_id: w.alice}));
    await _checkThrows("an employee cannot delete tasks", _ =>
        tasks.deleteTaskAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: "TASK-2"}));

    const task2 = (await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_ref='TASK-2'", []))[0];
    await tasks.deleteTaskAsync({org_id: w.org_id, actor_person_id: w.dave, task_ref: "TASK-2"});
    _check("deletion removes the task",
        (await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_ref='TASK-2'", [])).length == 0);
    _check("deletion removes everything attached",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM task_relation WHERE from_task_id=? OR to_task_id=?",
            [task2.task_id, task2.task_id])).length == 0 &&
        (await dblayer.getQueryOrThrow("SELECT * FROM task_event WHERE task_id=?",
            [task2.task_id])).length == 0);
    _check("deletion is always audited",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE org_id=? AND action='task.deleted' AND object_ref='TASK-2'",
            [w.org_id])).length == 1);
}

async function _testTimeLog(w) {
    LOG.console("\n the time log is a projection from the ledger\n");
    const original = await time.recordEventAsync({org_id: w.org_id, person_id: w.alice, entry_date: "2026-08-10",
        client_event_id: "tasklog-1", task_ref: "TASK-1", duration_seconds: 5400, source: "timer"});
    await time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
        entry_event_id: original.entry_event_id, reason: "forgot the fold",
        changes: {duration_seconds: 6000}});

    const detail = await tasks.taskDetailAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: "TASK-1"});
    _check("the drawer time log shows every entry with its source and the trail",
        detail.time_log.length == 2 && detail.time_log.every(event => event.source) &&
        detail.time_log.some(event => event.supersedes_entry_event_id == original.entry_event_id));
    _check("logged time counts only the current version",
        detail.logged_seconds == 6000, `${detail.logged_seconds}`);

    const list = await tasks.listTasksAsync({org_id: w.org_id, actor_person_id: w.alice});
    _check("the list projects logged time per task",
        list.logged_seconds["TASK-1"] == 6000, JSON.stringify(list.logged_seconds));
}

async function _testAPI(w) {
    LOG.console("\n the tasks API\n");
    const created = await tasksapi.doService({op: "create", id: w.aliceEmail, org: w.org_id,
        title: "API-created task", project: "Platform"});
    _check("op create answers true with the reference", created.result === true && /^TASK-\d+$/.test(created.task?.task_ref),
        created.task?.task_ref);

    const got = await tasksapi.doService({op: "get", id: w.aliceEmail, org: w.org_id,
        task_ref: created.task.task_ref});
    _check("op get returns the drawer shape", got.result === true && "events" in got && "time_log" in got);

    const blocked = await tasksapi.doService({op: "block", id: w.aliceEmail, org: w.org_id,
        blocker_task_ref: "TASK-1", blocked_task_ref: created.task.task_ref});
    _check("op block without a reason is refused with the reason",
        blocked.result === false && /reason/.test(blocked.reason||""), blocked.reason);

    const unknown = await tasksapi.doService({op: "list", id: "nobody@example.invalid", org: w.org_id});
    _check("an unknown actor is refused", unknown.result === false && /No person/.test(unknown.reason||""));
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Tasks test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "GB",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, aliceEmail: `alice.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["task_relation", "task_watcher", "task_comment", "task_event", "task"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
