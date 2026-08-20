/**
 * The A6 entity register — shape and erasure behaviour, declared at design time.
 *
 * Two things are fixed here rather than decided later:
 *
 *   Shape decides how the entity may be written. An append-only entity has no
 *   update path. An effective-dated one is never edited in place, it is
 *   superseded. A versioned entity moves a pointer instead of rewriting.
 *
 *   Erasure decides what happens when L3 receives a request. A6 is explicit that
 *   this cannot be a judgement call per request — each entity declares up front
 *   whether it erases, pseudonymises or is holdable, and the retention clock is
 *   anchored to an event rather than to a calendar date.
 *
 * Entities appear here before their tables exist. That is deliberate: the register
 * is the design record, and a module that adds a table without adding its row has
 * skipped the decision rather than made it.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

/** How an entity may be written. */
const SHAPES = Object.freeze({
    MUTABLE: "mutable",                     // ordinary row, updated in place
    APPEND_ONLY: "append_only",             // insert only; no update, no delete
    EFFECTIVE_DATED: "effective_dated",     // superseded by closing a period and opening the next
    VERSIONED_POINTER: "versioned_pointer", // immutable versions plus a published pointer
    EDGE: "edge",                           // a relationship with its own attributes and timestamps
    PERIOD_SNAPSHOT: "period_snapshot"      // covers a period and pins the versions it was built from
});

/** What happens to the entity when a person is erased. */
const ERASURE = Object.freeze({
    ERASE: "erase",                 // the row goes
    PSEUDONYMISE: "pseudonymise",   // the row stays, the person reference is replaced
    RETAIN: "retain"                // neither; the row carries no personal data by construction
});

/**
 * Retention clocks are anchored to an event, never to a calendar date. NONE means
 * the entity is kept for as long as its parent is.
 */
const ANCHORS = Object.freeze({
    NONE: null,
    OCCURRED: "occurred_at",
    EMPLOYMENT_ENDED: "employment_ended",
    REQUISITION_CLOSED: "requisition_closed",
    PERIOD_CLOSED: "period_closed",
    SIGNAL_EVALUATED: "signal_evaluated"
});

const REGISTER = Object.freeze({
    // --- identity ---
    org: {shape: SHAPES.MUTABLE, erasure: ERASURE.RETAIN, keep: null, anchor: ANCHORS.NONE,
        note: "The tenant. Every row in the system carries org_id."},
    person: {shape: SHAPES.MUTABLE, erasure: ERASURE.ERASE, keep: null, anchor: ANCHORS.NONE,
        note: "Global, with org membership expressed as employment. A human, not an employee."},
    employment: {shape: SHAPES.EFFECTIVE_DATED, erasure: ERASURE.PSEUDONYMISE, keep: "7y", anchor: ANCHORS.EMPLOYMENT_ENDED,
        note: "Read by J1, C6, C7, K3 and L2. Superseded, never edited."},
    capability_grant: {shape: SHAPES.EDGE, erasure: ERASURE.ERASE, keep: "7y", anchor: ANCHORS.EMPLOYMENT_ENDED,
        note: "capability × scope × expiry. The grant erases; the permission set embedded in each audit event does not."},
    audit_event: {shape: SHAPES.APPEND_ONLY, erasure: ERASURE.RETAIN, keep: "7y", anchor: ANCHORS.OCCURRED,
        note: "Holdable, hash-chained. Pins the effective permission set, so it survives erasure of the grants that produced it."},
    role: {shape: SHAPES.MUTABLE, erasure: ERASURE.RETAIN, keep: null, anchor: ANCHORS.NONE,
        note: "A named bundle over capability x scope. Not versioned — H4 pins the evaluated set instead."},
    role_capability: {shape: SHAPES.EDGE, erasure: ERASURE.RETAIN, keep: null, anchor: ANCHORS.NONE,
        note: "The same capability appears in several roles at different scopes; that difference is the model."},

    // --- time ---
    time_entry_event: {shape: SHAPES.APPEND_ONLY, erasure: ERASURE.PSEUDONYMISE, keep: "7y", anchor: ANCHORS.PERIOD_CLOSED,
        note: "The truth. time_entry is its projection — this is what lets C5 keep the original value and a reason."},
    timesheet_entry: {shape: SHAPES.EDGE, erasure: ERASURE.PSEUDONYMISE, keep: "7y", anchor: ANCHORS.PERIOD_CLOSED,
        note: "Pins the entry events a submitted week was built from. The snapshot, not the live ledger, is what payroll read."},
    working_window: {shape: SHAPES.EFFECTIVE_DATED, erasure: ERASURE.ERASE, keep: null, anchor: ANCHORS.NONE,
        note: "People travel and relocate. A current-only window makes E3 retroactively wrong."},
    timesheet: {shape: SHAPES.PERIOD_SNAPSHOT, erasure: ERASURE.PSEUDONYMISE, keep: "7y", anchor: ANCHORS.PERIOD_CLOSED,
        note: "Pins entry versions at submission, so a later edit cannot silently change an approved week."},

    // --- leave ---
    leave_policy_version: {shape: SHAPES.VERSIONED_POINTER, erasure: ERASURE.RETAIN, keep: "7y", anchor: ANCHORS.NONE,
        note: "The reference implementation of the versioned-record-plus-pointer shape."},
    leave_ledger_entry: {shape: SHAPES.APPEND_ONLY, erasure: ERASURE.PSEUDONYMISE, keep: "7y", anchor: ANCHORS.EMPLOYMENT_ENDED,
        note: "Stamped with the policy version that produced it. Balance is projected over this, never stored."},

    // --- work and knowledge ---
    task: {shape: SHAPES.MUTABLE, erasure: ERASURE.ERASE, keep: null, anchor: ANCHORS.NONE,
        note: "The row. Edges and events around it answer who, when and why."},
    task_relation: {shape: SHAPES.EDGE, erasure: ERASURE.RETAIN, keep: null, anchor: ANCHORS.NONE,
        note: "blocks · subtask · duplicate, with its own timestamps — that is what makes 'blocked 6 days' answerable."},
    task_watcher: {shape: SHAPES.EDGE, erasure: ERASURE.ERASE, keep: null, anchor: ANCHORS.NONE,
        note: "Watching is a relation, never an array on the task."},
    task_comment: {shape: SHAPES.APPEND_ONLY, erasure: ERASURE.ERASE, keep: null, anchor: ANCHORS.NONE,
        note: "Comments are never edited in place; a correction is a new comment."},
    task_event: {shape: SHAPES.APPEND_ONLY, erasure: ERASURE.PSEUDONYMISE, keep: null, anchor: ANCHORS.NONE,
        note: "The activity trail: status transitions and field changes, with before and after."},
    page_version: {shape: SHAPES.VERSIONED_POINTER, erasure: ERASURE.PSEUDONYMISE, keep: null, anchor: ANCHORS.NONE,
        note: "Same shape as leave policy. last_reviewed is not updated_at."},
    attachment: {shape: SHAPES.EDGE, erasure: ERASURE.ERASE, keep: null, anchor: ANCHORS.NONE,
        note: "One edge for task, page and message. Sharing state lives on the file, never on the edge."},

    // --- hiring and wellbeing ---
    application: {shape: SHAPES.EDGE, erasure: ERASURE.ERASE, keep: "6m", anchor: ANCHORS.REQUISITION_CLOSED,
        note: "candidate × requisition. A person can apply twice; the second application is not a duplicate."},
    stage_transition: {shape: SHAPES.APPEND_ONLY, erasure: ERASURE.ERASE, keep: "6m", anchor: ANCHORS.REQUISITION_CLOSED,
        note: "Produced by the workflow engine, never by a drag."},
    signal_ledger_entry: {shape: SHAPES.APPEND_ONLY, erasure: ERASURE.ERASE, keep: "13m", anchor: ANCHORS.SIGNAL_EVALUATED,
        note: "Reads six tables, writes one. The wellbeing module adds no new collection — that is what makes it defensible."}
});

/**
 * Values that are projected on read and must never become a column. Each is cheap
 * to compute and expensive to be wrong about. Caching one is fine; storing one is not.
 */
const PROJECTED_NEVER_STORED = Object.freeze({
    overlap: "Recomputed from working windows and leave. Stored, it is wrong the moment someone changes a window.",
    leave_balance: "Projected over leave_ledger_entry under the policy version in force.",
    load_signal: "Evaluated nightly, thresholds read from the current signal definition.",
    capacity: "Allocation minus approved leave minus holidays.",
    timesheet_total: "Summed from time entries. The snapshot pins versions, not numbers."
});

exports.SHAPES = SHAPES;
exports.ERASURE = ERASURE;
exports.ANCHORS = ANCHORS;
exports.REGISTER = REGISTER;
exports.PROJECTED_NEVER_STORED = PROJECTED_NEVER_STORED;

/**
 * @param {string} entity The entity name
 * @returns The register entry, or undefined if the entity has not declared one
 */
exports.shapeOf = entity => REGISTER[entity];

/**
 * Guard for the write path. An append-only or effective-dated entity has no update
 * path, and calling one is a coding error rather than a runtime condition.
 * @param {string} entity The entity name
 * @throws If the entity may not be updated in place
 */
exports.assertUpdatable = function(entity) {
    const declared = REGISTER[entity];
    if (!declared) throw new Error(`Entity ${entity} has no row in the A6 register. Declare its shape and erasure behaviour before writing to it.`);
    if (declared.shape == SHAPES.APPEND_ONLY) throw new Error(
        `${entity} is append-only. Insert a new entry instead of updating one.`);
    if (declared.shape == SHAPES.EFFECTIVE_DATED) throw new Error(
        `${entity} is effective-dated. Close the current period and open a new one instead of updating in place.`);
    if (declared.shape == SHAPES.VERSIONED_POINTER) throw new Error(
        `${entity} is versioned. Publish a new version and move the pointer instead of editing.`);
}

/**
 * @param {string} name A value name
 * @returns true if the value must be projected on read rather than stored
 */
exports.isProjectedOnly = name => Object.keys(PROJECTED_NEVER_STORED).includes(name);
