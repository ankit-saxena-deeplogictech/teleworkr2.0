/**
 * H4 — the audit log.
 *
 * Append-only, hash-chained, retained seven years. Every entry pins the actor's
 * effective permission set at the moment of the action, so "who could see this in
 * March" is answered from the entry itself and never re-evaluates against today's
 * grants. An entry about a person is readable by that person; that is the half
 * that makes the log accountability rather than surveillance.
 *
 * The A8 contract is enforced here, not promised:
 *   - performAsync runs the action and its audit write in one transaction, so an
 *     audit write that fails fails the action — an unlogged sensitive action is
 *     not permitted to occur.
 *   - An irreversible action refuses to proceed when its pre-check is missing or
 *     down. Never silently succeed with wrong data, and never proceed on a
 *     failed check.
 *   - A read the caller has no capability for is refused with a reason, never
 *     returned as an empty list.
 *
 * There is deliberately no update and no delete on audit_event. Erasure of a
 * person tombstones their identity elsewhere; the entry itself is holdable and
 * survives, which is what the entity register declares for it.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const crypto = require("crypto");
const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);

const RETENTION_YEARS = 7;
const ACTOR_KINDS = Object.freeze({PERSON: "person", SERVICE: "service", SYSTEM: "system"});
const ACTION_NAME = /^[a-z0-9_]+\.[a-z0-9_]+$/;      // A10 object.action naming, lower snake, past tense

/** Events that are always logged, alongside every capability marked always_audited. */
const FIXED_EVENTS = Object.freeze([
    "session.new_device_signed_in", "session.signed_out",
    "integration.connected", "integration.disconnected",
    "record.deleted"
]);

/** The published categories of the logged-event list. */
const CATEGORIES = Object.freeze({
    policy:     {label: "Policy changes",            test: action => action.startsWith("leave_policy.") || action.startsWith("policy.") || action.startsWith("working_window.")},
    approval:   {label: "Approvals and returns",     test: action => action.endsWith(".approved") || action.endsWith(".returned")},
    time:       {label: "Time entries",              test: action => action.startsWith("time_entry.")},
    permission: {label: "Role and permission changes", test: action => action.startsWith("role.") || action.startsWith("capability.")},
    export:     {label: "Exports of people's data",  test: action => action.endsWith(".exported")},
    access:     {label: "Access and sessions",       test: action => action.startsWith("session.") || action.startsWith("integration.")},
    deletion:   {label: "Deletions",                 test: action => action.endsWith(".deleted")}
});

// H4: "HR sees compliance and policy entries." Compliance is read here as time
// edits and approvals, policy as policy changes, plus deletions of records.
const HR_VISIBLE = action => ["policy", "approval", "time", "deletion"].some(k => CATEGORIES[k].test(action));

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/**
 * Writes a standalone audit entry — a sign-in, an integration connect, a deletion.
 * For sensitive actions performed by a person, use performAsync instead, which
 * couples the action and its entry in one transaction.
 *
 * @param {object} entry {org_id, action, object_type, object_ref, subject_person_id,
 *      actor_person_id, actor_kind, reason, detail, occurred_at, audit_id}
 * @returns The stored entry
 * @throws If the entry is invalid or the write failed
 */
exports.writeAsync = async function(entry) {
    return await dblayer.runInTransactionAsync(async exec => {
        const row = _prepareRow(entry, null);
        const effective = row.actor_kind == ACTOR_KINDS.PERSON ?
            await permissions.effectivePermissionsAsync(row.org_id, row.actor_person_id, _today(), exec) : [];
        return await _insertEntryAsync(exec, row, effective);
    });
}

/**
 * Inserts an audit entry on a caller-owned transaction executor, for call sites
 * that already run inside dblayer.runInTransactionAsync and need the entry to
 * land with their own writes. The caller supplies the pinned permission set —
 * pass [] when the actor is a system or the org does not exist yet.
 *
 * @param {object} exec The transaction executor
 * @param {object} entry The entry fields, as for writeAsync
 * @param {array} effectivePermissions The pinned permission set
 * @returns The stored entry
 * @throws If the entry is invalid or the insert failed
 */
exports.insertEntryViaAsync = async function(exec, entry, effectivePermissions) {
    const row = _prepareRow(entry, entry.reason);
    return await _insertEntryAsync(exec, row, effectivePermissions || []);
}

/**
 * Runs a sensitive action and its audit write as one unit.
 *
 * The order of the guards is the order the invariants impose:
 *   permission -> reason -> step-up -> pre-check -> transaction(action + audit).
 * Every refusal throws before anything ran, so there is nothing to roll back and
 * nothing completed unlogged.
 *
 * @param {object} spec {
 *      org_id, actor_person_id, capability, subject_person_id, context,
 *      step_up_verified,     // boolean; required when the capability has step_up
 *      reason,               // required when the capability has action_requires_reason
 *      precheck,             // async () => truthy; required when the capability is irreversible
 *      audit,                // {action, object_type, object_ref, subject_person_id, detail, occurred_at, audit_id}
 *      action                // async exec => result; runs inside the transaction
 * }
 * @returns Whatever the action returned, after the transaction committed
 * @throws With err.decision set when the refusal came from the permission engine
 */
exports.performAsync = async function(spec) {
    const decision = await permissions.requireAsync({
        org_id: spec.org_id, actor_person_id: spec.actor_person_id, capability: spec.capability,
        subject_person_id: spec.subject_person_id, context: spec.context});

    const definition = capabilities.definitionOf(spec.capability);

    // L2: a capability whose actions carry a reason refuses the action without one.
    capabilities.assertActionReason(spec.capability, spec.reason);

    // Step-up: re-authentication before the action. L1 supplies the session proof.
    if (definition.step_up && !spec.step_up_verified) throw Object.assign(
        new Error(`${spec.capability} requires step-up authentication before the action.`), {decision});

    // A8: an irreversible action never proceeds on a failed or missing check.
    if (definition.irreversible) {
        if (!spec.precheck) throw Object.assign(new Error(
            `${spec.capability} is irreversible. It refuses to proceed without a pre-check — supplying none is not a passing check.`), {decision});
        let passed;
        try {passed = await spec.precheck();}
        catch (err) {throw Object.assign(new Error(
            `The pre-check for ${spec.capability} is unavailable, and an irreversible action never proceeds on a failed check. (${err.message})`), {decision});}
        if (!passed) throw Object.assign(new Error(
            `The pre-check for ${spec.capability} did not pass, and an irreversible action never proceeds on a failed check.`), {decision});
    }

    // An always-audited capability cannot be called without its entry.
    if (definition.always_audited && !spec.audit) throw Object.assign(new Error(
        `${spec.capability} is always audited. The call site must supply the audit entry.`), {decision});

    const row = _prepareRow({...(spec.audit||{}), org_id: spec.org_id,
        actor_person_id: spec.actor_person_id, subject_person_id:
            spec.audit?.subject_person_id || spec.subject_person_id || null}, spec.reason);

    return await dblayer.runInTransactionAsync(async exec => {
        // Pin the evaluated set that authorised this action, read on the same
        // connection the action will commit on — and before the action, because
        // the set is what made the action possible.
        const effective = await permissions.effectivePermissionsAsync(decision.org_id, spec.actor_person_id, decision.asOf, exec);
        const result = await spec.action(exec);
        // The audit insert comes after the action but inside the same transaction,
        // so a failed audit write rolls the action back — the A8 contract.
        await _insertEntryAsync(exec, row, effective);
        return result;
    });
}

/**
 * Builds the row a write will insert, validating it first.
 * @returns The validated row, with detail serialised and retention computed
 */
function _prepareRow(entry, reason) {
    if (!entry.org_id) throw new Error("An audit entry needs an org_id.");
    if (!entry.action || !ACTION_NAME.test(entry.action)) throw new Error(
        `Audit actions use A10 object.action naming, lower snake, past tense — got ${JSON.stringify(entry.action)}.`);
    if (!entry.object_type) throw new Error("An audit entry needs an object_type.");

    const actorKind = entry.actor_kind || (entry.actor_person_id ? ACTOR_KINDS.PERSON : ACTOR_KINDS.SYSTEM);
    if (!Object.values(ACTOR_KINDS).includes(actorKind)) throw new Error(`${actorKind} is not a known actor kind.`);
    if (actorKind == ACTOR_KINDS.PERSON && !entry.actor_person_id) throw new Error("A person actor needs an actor_person_id.");

    const occurredAt = entry.occurred_at || _now();
    return {audit_id: entry.audit_id || serverutils.generateUUID(false), org_id: entry.org_id,
        occurred_at: occurredAt, actor_person_id: entry.actor_person_id || null, actor_kind: actorKind,
        action: entry.action, object_type: entry.object_type, object_ref: entry.object_ref || null,
        subject_person_id: entry.subject_person_id || null, reason: reason || entry.reason || null,
        detail: _stringifyDetail(entry.detail), retention_until: _retentionUntil(occurredAt)};
}

/**
 * The detail column carries shapes and counts, never content a person typed.
 * @returns The serialised detail, "" for none
 * @throws If the detail cannot be serialised
 */
function _stringifyDetail(detail) {
    if (detail === null || detail === undefined) return "";
    try {return JSON.stringify(detail);}
    catch (err) {throw new Error(`Audit detail must be JSON-serialisable: ${err.message}`);}
}

/**
 * Retention is anchored to occurred_at, never to a calendar year end. Seven years
 * from the event, leap-safe: 29 Feb 2024 retains until 28 Feb 2031.
 */
function _retentionUntil(occurredAt) {
    const d = new Date(occurredAt * 1000);
    const day = d.getDate();
    d.setFullYear(d.getFullYear() + RETENTION_YEARS);
    if (d.getDate() != day) d.setDate(0);
    return d.toISOString().substring(0, 10);
}

/**
 * Inserts one entry, chaining its hash to the previous entry's. Must run inside a
 * transaction so the chain link and the row land together.
 * @param {object} exec The transaction executor
 * @param {object} row The prepared row
 * @param {array} effectivePermissions The pinned permission set
 * @returns The stored row
 */
async function _insertEntryAsync(exec, row, effectivePermissions) {
    const prevRows = await exec.getQuery(
        "SELECT entry_hash FROM audit_event WHERE org_id=? ORDER BY rowid DESC LIMIT 1", [row.org_id]);
    const prevHash = prevRows.length ? (prevRows[0].entry_hash || "") : "";

    const stored = {...row, effective_permissions: JSON.stringify(effectivePermissions),
        prev_hash: prevHash, entry_hash: null};
    stored.entry_hash = _hashOf(stored);

    await exec.runCmd(`INSERT INTO audit_event (audit_id, org_id, occurred_at, actor_person_id, actor_kind,
        action, object_type, object_ref, subject_person_id, reason, effective_permissions, detail,
        retention_until, prev_hash, entry_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [stored.audit_id, stored.org_id, stored.occurred_at, stored.actor_person_id, stored.actor_kind,
            stored.action, stored.object_type, stored.object_ref, stored.subject_person_id, stored.reason,
            stored.effective_permissions, stored.detail, stored.retention_until, stored.prev_hash, stored.entry_hash]);

    LOG.info(`Audit ${stored.action} by ${stored.actor_kind}${stored.actor_person_id?` ${stored.actor_person_id}`:""} in ${stored.org_id}.`);
    return stored;
}

/** The canonical form hashed into entry_hash. Field order is part of the contract. */
const _hashOf = row => crypto.createHash("sha256").update([
    row.org_id, row.occurred_at, row.actor_person_id||"", row.actor_kind, row.action,
    row.object_type, row.object_ref||"", row.subject_person_id||"", row.reason||"",
    row.effective_permissions, row.detail||"", row.retention_until, row.prev_hash||""
].join("\n")).digest("hex");

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * Reads the log at the caller's level. The level is decided by the same engine
 * that gates everything else, so the result set can never be wider than the
 * caller's capabilities — a caller with no read capability is refused rather than
 * handed an empty list.
 *
 * Levels: audit.read_all sees everything; audit.read_policy sees the compliance
 * and policy categories; audit.read_own sees entries about the caller and the
 * caller's own entries with no subject.
 *
 * @param {object} request {org_id, actor_person_id, subject_person_id, object_type, action, from, to, limit}
 * @returns The entries, newest first
 * @throws With err.decision set, when no read capability is in force
 */
exports.queryAsync = async function(request) {
    const {org_id, actor_person_id} = request;
    if (!org_id) throw new Error("An audit query needs an org_id.");
    if (!actor_person_id) throw new Error("An audit query needs an actor_person_id. A service reader holds grants under its own identity.");

    const readAll = await permissions.checkAsync({org_id, actor_person_id, capability: "audit.read_all"});
    let level;
    if (readAll.allowed) level = "all";
    else {
        const readPolicy = await permissions.checkAsync({org_id, actor_person_id, capability: "audit.read_policy"});
        if (readPolicy.allowed) level = "policy";
        else {
            const readOwn = await permissions.checkAsync({org_id, actor_person_id, capability: "audit.read_own",
                subject_person_id: actor_person_id});
            if (readOwn.allowed) level = "own";
            else throw Object.assign(new Error(
                `No audit read capability is in force for this person. ${readAll.who_can||""}`), {decision: readAll});
        }
    }

    let sql = "SELECT * FROM audit_event WHERE org_id=?", params = [org_id];
    if (level == "own") {sql += " AND (subject_person_id=? OR (actor_person_id=? AND subject_person_id IS NULL))";
        params.push(actor_person_id, actor_person_id);}
    if (request.subject_person_id) {sql += " AND subject_person_id=?"; params.push(request.subject_person_id);}
    if (request.object_type) {sql += " AND object_type=?"; params.push(request.object_type);}
    if (request.action) {sql += " AND action=?"; params.push(request.action);}
    if (request.from) {sql += " AND occurred_at >= ?"; params.push(request.from);}
    if (request.to) {sql += " AND occurred_at <= ?"; params.push(request.to);}
    sql += " ORDER BY occurred_at DESC, rowid DESC";

    let rows = await dblayer.getQueryOrThrow(sql, params);
    if (level == "policy") rows = rows.filter(row => HR_VISIBLE(row.action));
    if (request.limit) rows = rows.slice(0, request.limit);
    return rows;
}

// ---------------------------------------------------------------------------
// integrity and the published list
// ---------------------------------------------------------------------------

/**
 * Recomputes the hash chain. A row edited in place breaks its own hash and every
 * hash after it.
 * @param {string} org_id The org
 * @returns {object} {ok, count} or {ok, broken_at, expected, actual, why}
 */
exports.verifyIntegrityAsync = async function(org_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? ORDER BY rowid ASC", [org_id]);

    let prev = "";
    for (const row of rows) {
        if (row.prev_hash != prev) return {ok: false, broken_at: row.audit_id,
            why: `prev_hash is ${JSON.stringify(row.prev_hash)}, expected ${JSON.stringify(prev)}.`};
        const expected = _hashOf(row);
        if (row.entry_hash != expected) return {ok: false, broken_at: row.audit_id,
            expected, actual: row.entry_hash, why: "The entry content does not match its hash."};
        prev = row.entry_hash;
    }
    return {ok: true, count: rows.length};
}

/**
 * The logged-event list, published so nobody has to guess the coverage. Derived
 * from the capability catalogue — every capability marked always_audited — plus
 * the fixed events, so it cannot drift from what the engine enforces.
 * @returns {object} {always_audited, fixed_events, categories}
 */
exports.coverage = _ => ({
    always_audited: Object.entries(capabilities.CATALOGUE)
        .filter(([, definition]) => definition.always_audited)
        .map(([capability, definition]) => ({capability, label: definition.label})),
    fixed_events: [...FIXED_EVENTS],
    categories: Object.entries(CATEGORIES).map(([name, category]) => ({name, label: category.label}))
});

exports.HR_VISIBLE = HR_VISIBLE;
