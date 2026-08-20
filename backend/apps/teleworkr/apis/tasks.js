/**
 * The tasks API — D1/D2. The actor is the token's id (their email); every
 * permission the wireframes care about is enforced in lib/tasks.js.
 *
 * Operations:
 *  op - create    - Creates a task (TASK-N, sequential per org)
 *  op - list      - The task list with exact counts, filters and blocked-on names
 *  op - get       - The D2 drawer: relations, watchers, comments, activity, time log
 *  op - update    - Updates task fields, with status transitions logged
 *  op - assign    - Assigns or reassigns, always audited
 *  op - block     - Blocks one task on another, with a reason
 *  op - unblock   - Lifts a block; the relation keeps its timestamps
 *  op - subtask   - Adds a subtask under a parent
 *  op - comment   - Appends a comment
 *  op - watch     - Watches / unwatches a task
 *  op - delete    - Deletes a task, always audited
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        const org_id = jsonReq.org;
        switch (jsonReq.op) {
            case "create": {
                const task = await tasks.createTaskAsync({org_id, actor_person_id: actor.person_id,
                    title: jsonReq.title, description: jsonReq.description, project: jsonReq.project,
                    status: jsonReq.status, priority: jsonReq.priority,
                    assignee_person_id: jsonReq.assignee_person_id,
                    due_date: jsonReq.due_date, due_time_minutes: jsonReq.due_time_minutes,
                    estimate_minutes: jsonReq.estimate_minutes, recurring_rule: jsonReq.recurring_rule});
                return {...CONSTANTS.TRUE_RESULT, task};
            }
            case "list": {
                const list = await tasks.listTasksAsync({org_id, actor_person_id: actor.person_id,
                    filters: jsonReq.filters, page: jsonReq.page, page_size: jsonReq.page_size});
                return {...CONSTANTS.TRUE_RESULT, ...list};
            }
            case "get": {
                const detail = await tasks.taskDetailAsync(
                    {org_id, actor_person_id: actor.person_id, task_ref: jsonReq.task_ref});
                return {...CONSTANTS.TRUE_RESULT, ...detail};
            }
            case "update": {
                const task = await tasks.updateTaskAsync({org_id, actor_person_id: actor.person_id,
                    task_ref: jsonReq.task_ref, changes: jsonReq.changes || {}});
                return {...CONSTANTS.TRUE_RESULT, task};
            }
            case "assign": {
                await tasks.assignTaskAsync({org_id, actor_person_id: actor.person_id,
                    task_ref: jsonReq.task_ref, assignee_person_id: jsonReq.assignee_person_id});
                return CONSTANTS.TRUE_RESULT;
            }
            case "block": {
                const relation = await tasks.addBlockAsync({org_id, actor_person_id: actor.person_id,
                    blocker_task_ref: jsonReq.blocker_task_ref, blocked_task_ref: jsonReq.blocked_task_ref,
                    reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, relation};
            }
            case "unblock": {
                await tasks.resolveBlockAsync({org_id, actor_person_id: actor.person_id,
                    blocker_task_ref: jsonReq.blocker_task_ref, blocked_task_ref: jsonReq.blocked_task_ref});
                return CONSTANTS.TRUE_RESULT;
            }
            case "subtask": {
                const result = await tasks.addSubtaskAsync({org_id, actor_person_id: actor.person_id,
                    parent_task_ref: jsonReq.parent_task_ref, title: jsonReq.title,
                    description: jsonReq.description, due_date: jsonReq.due_date});
                return {...CONSTANTS.TRUE_RESULT, child: result.child, relation: result.relation};
            }
            case "comment": {
                const comment = await tasks.addCommentAsync({org_id, actor_person_id: actor.person_id,
                    task_ref: jsonReq.task_ref, body: jsonReq.body});
                return {...CONSTANTS.TRUE_RESULT, comment};
            }
            case "watch": {
                if (jsonReq.watch === false) await tasks.removeWatcherAsync(
                    {org_id, actor_person_id: actor.person_id, task_ref: jsonReq.task_ref});
                else await tasks.addWatcherAsync(
                    {org_id, actor_person_id: actor.person_id, task_ref: jsonReq.task_ref});
                return CONSTANTS.TRUE_RESULT;
            }
            case "delete": {
                await tasks.deleteTaskAsync({org_id, actor_person_id: actor.person_id,
                    task_ref: jsonReq.task_ref});
                return CONSTANTS.TRUE_RESULT;
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Tasks operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message,
            decision: err.decision?.outcome, rule: err.decision?.rule};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq &&
    ["create", "list", "get", "update", "assign", "block", "unblock", "subtask", "comment", "watch", "delete"]
        .includes(jsonReq.op) && jsonReq.id && jsonReq.org;
