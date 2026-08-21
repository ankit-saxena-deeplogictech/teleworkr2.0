/**
 * J1/J3 — the leave system of record.
 *
 * The policy is a versioned, effective-dated record with a published pointer.
 * Versions are immutable — supersession moves the pointer and never rewrites
 * what was published — and every evaluated record pins the version that
 * produced it, so a republished policy cannot silently re-evaluate the past.
 *
 * Balance is a projection over the append-only ledger under the policy version
 * in force on that date, plus the imported opening assertions (B6). Nothing
 * here stores a balance. Accruals are materialised as ledger rows, idempotently,
 * stamped with their policy version; expiry excludes units per their own clock.
 *
 * One evaluator answers every leave question. Screens ask; they never decide.
 * The primitives are the schema: anything the policy document contains that the
 * schema cannot express fails loudly at publish time, rather than becoming an
 * exception in a controller (J1 note 8).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const policyconflicts = require(`${TELEWORKR_CONSTANTS.LIBDIR}/policy_conflicts.js`);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPIRING_WINDOW_DAYS = 10;
const REQUEST_STATUS = Object.freeze({DRAFT: "draft", PENDING: "pending", APPROVED: "approved",
    DECLINED: "declined", CANCELLED: "cancelled"});
const DAY_MS = 86400000;

// The primitives are the schema. Unknown keys fail publish loudly (J1 note 8).
const KNOWN_TYPE_KEYS = Object.freeze(["code", "label", "allow_half_days", "quantum", "accrual",
    "eligibility", "notice", "max_per_request", "max_per_period", "carry_forward", "expiry",
    "clubbing", "approval_route", "combinable_with", "lifetime_max", "requires_exhausted",
    "proof_after_consecutive_days", "backdating"]);
const KNOWN_NESTED = Object.freeze({
    quantum: ["annual_days"], accrual: ["per_month", "pro_rata", "from", "freezes_on"],
    eligibility: ["states"], notice: ["multiplier", "floor_days", "short_notice_approvable"],
    max_per_period: ["days", "period"], carry_forward: ["cap_days"],
    expiry: ["months"], clubbing: ["mode", "window"], backdating: ["allowed_days", "for_types"]
});

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);
const _assertISODate = (date, label="date") => {
    if ((typeof date != "string") || (!ISO_DATE.test(date))) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

// ---------------------------------------------------------------------------
// publishing — versioned record, published pointer
// ---------------------------------------------------------------------------

/**
 * Publishes a policy version. Validated first — anything the schema cannot
 * express fails here, loudly — then written as a new immutable version and made
 * the published pointer for its scope, superseding whatever it pointed at.
 * Runs through the H4 wrapper: leave_policy.publish is always audited, so the
 * publish and its audit entry commit together.
 *
 * @param {object} request {org_id, actor_person_id, step_up_verified, scope,
 *      effective_from, policy, resolutions, dry_run}
 * @returns {object} {version, superseded, conflicts, resolutions}
 */
exports.publishPolicyAsync = async function(request) {
    const scope = request.scope || request.policy?.scope || {};
    const policy = _validatePolicy(request.policy);
    _assertISODate(request.effective_from, "effective_from");
    const scopeKey = _scopeKey(scope);
    const detected = policyconflicts.detect(policy);
    const resolutions = policyconflicts.resolveForPolicy(policy, request.resolutions, request.actor_person_id);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "leave_policy.publish", step_up_verified: request.step_up_verified,
        audit: {action: "leave_policy.published", object_type: "leave_policy",
            object_ref: scopeKey, detail: {scope, effective_from: request.effective_from,
                leave_types: policy.leave_types.map(type => type.code), dry_run: request.dry_run === true}},
        action: async exec => {
            const current = await exec.getQuery(
                "SELECT * FROM leave_policy_pointer WHERE org_id=? AND scope_key=?", [request.org_id, scopeKey]);
            const versions = await exec.getQuery(
                "SELECT MAX(version) AS max FROM leave_policy_version WHERE org_id=?", [request.org_id]);
            const version = {policy_version_id: serverutils.generateUUID(false), org_id: request.org_id,
                version: (versions[0].max || 0) + 1, scope: JSON.stringify(scope),
                status: "published", effective_from: request.effective_from,
                policy: JSON.stringify(policy), resolutions: JSON.stringify(resolutions),
                published_at: _now(),
                published_by: request.actor_person_id, created_at: _now(), created_by: request.actor_person_id};

            await exec.runCmd(`INSERT INTO leave_policy_version (policy_version_id, org_id, version,
                scope, status, effective_from, policy, resolutions, published_at, published_by, created_at, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [version.policy_version_id, version.org_id, version.version, version.scope,
                    version.status, version.effective_from, version.policy, version.resolutions,
                    version.published_at, version.published_by, version.created_at, version.created_by]);
            if (current.length) await exec.runCmd(
                "UPDATE leave_policy_version SET status='superseded' WHERE policy_version_id=?",
                [current[0].policy_version_id]);
            await exec.runCmd(
                `INSERT INTO leave_policy_pointer (org_id, scope_key, policy_version_id, updated_at)
                    VALUES (?,?,?,?)
                    ON CONFLICT (org_id, scope_key) DO UPDATE SET policy_version_id=excluded.policy_version_id,
                        updated_at=excluded.updated_at`,
                [request.org_id, scopeKey, version.policy_version_id, _now()]);

            LOG.info(`Published leave policy v${version.version} for ${scopeKey} in ${request.org_id}.`);
            return {version, superseded: current.length ? current[0].policy_version_id : null,
                conflicts: detected.map(({id, title, why, class: cls, choices, default: def}) =>
                    ({id, title, why, class: cls, choices, default_reading: def || null})),
                resolutions};
        }});
}

/**
 * The J8 screen: all seven conflicts with, for the given policy version, which
 * were detected, what was resolved and whether it was explicit or a default.
 * @returns {array} Conflict rows with detection and resolution state
 */
exports.policyConflictsAsync = async function(org_id, policy_version_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_policy_version WHERE org_id=? AND policy_version_id=?",
        [org_id, policy_version_id]);
    if (!rows.length) throw new Error(`No policy version ${policy_version_id}.`);
    const version = rows[0];
    const policy = JSON.parse(version.policy);
    const detected = policyconflicts.detect(policy);
    const stored = JSON.parse(version.resolutions || "{}");
    return policyconflicts.CONFLICTS.map(conflict => ({
        id: conflict.id, title: conflict.title, why: conflict.why, class: conflict.class,
        choices: conflict.choices, default_reading: conflict.default || null,
        detected: detected.some(entry => entry.id == conflict.id),
        resolution: stored[conflict.id]?.choice || null,
        source: stored[conflict.id]?.source || null,
        decided_by: stored[conflict.id]?.decided_by || null,
        decided_at: stored[conflict.id]?.decided_at || null}));
}

/** The structural validator. Unknown keys and contradictory primitives fail loudly here. */
function _validatePolicy(policy) {
    if (!policy || !Array.isArray(policy.leave_types) || !policy.leave_types.length)
        throw new Error("A policy needs its leave types.");
    const codes = new Set();
    for (const type of policy.leave_types) {
        if (!type.code || codes.has(type.code)) throw new Error(
            `Every leave type needs a unique code; duplicate or missing: ${JSON.stringify(type.code)}.`);
        codes.add(type.code);
    }
    for (const type of policy.leave_types) {
        for (const key of Object.keys(type)) if (!KNOWN_TYPE_KEYS.includes(key)) throw new Error(
            `Leave type ${type.code} declares ${key}, which the policy schema cannot express. Publish is blocked rather than silently ignoring it (J1).`);
        for (const [group, allowed] of Object.entries(KNOWN_NESTED)) {
            if (!type[group] || typeof type[group] != "object") continue;
            for (const key of Object.keys(type[group])) if (!allowed.includes(key)) throw new Error(
                `Leave type ${type.code}: ${group}.${key} is not expressible in the schema. Publish is blocked.`);
        }
        if (!Array.isArray(type.approval_route) || !type.approval_route.length) throw new Error(
            `Leave type ${type.code} needs an approval route (J2 validator).`);
        if (type.clubbing?.mode == "exempt_first" && !type.clubbing.window) throw new Error(
            `Leave type ${type.code}: clubbing "exempt first, then counted" needs a window — the document does not specify one, so publish stays blocked (J2).`);
        if (type.notice && ((type.notice.multiplier ?? 0) < 0 || (type.notice.floor_days ?? 0) < 0))
            throw new Error(`Leave type ${type.code}: notice values cannot be negative.`);
        if (type.max_per_request !== undefined && !(type.max_per_request > 0)) throw new Error(
            `Leave type ${type.code}: max_per_request must be positive.`);
        for (const reference of [...(type.combinable_with||[]), ...(type.requires_exhausted||[])])
            if (!codes.has(reference)) throw new Error(
                `Leave type ${type.code} references ${reference}, which is not a declared type (J2 validator).`);
    }
    if (!policy.scope?.jurisdiction) throw new Error("A policy needs a scope with a jurisdiction.");
    if (policy.escalation_after_days !== undefined && !(policy.escalation_after_days > 0))
        throw new Error("escalation_after_days must be a positive number of days (J5).");
    return policy;
}

function _scopeKey(scope) {
    return [scope.jurisdiction, scope.contract_type || null,
        (scope.status||[]).slice().sort().join("+")].join("|");
}

/**
 * The policy version in force for a person on a date — matched through the
 * published pointer for their jurisdiction, then by the version's scope tags.
 * @returns The version row, or null
 */
async function _policyForPersonAsync(org_id, person_id, asOf) {
    const employment = await spine.employmentAsOfAsync(org_id, person_id, asOf);
    if (!employment) return {employment: null, version: null};

    const pointer = (await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_policy_pointer WHERE org_id=? AND scope_key LIKE ? ORDER BY updated_at DESC LIMIT 1",
        [org_id, `${employment.jurisdiction}|%`]))[0];
    if (!pointer) return {employment, version: null};

    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_policy_version WHERE policy_version_id=?", [pointer.policy_version_id]);
    const version = rows.length ? rows[0] : null;
    if (!version) return {employment, version: null};

    const scope = JSON.parse(version.scope);
    const covered = (!scope.contract_type || scope.contract_type == employment.contract_type) &&
        (!scope.status || !scope.status.length || scope.status.includes(employment.status));
    return {employment, version: covered ? version : null, scope_mismatch: !covered};
}

/** @see _policyForPersonAsync — the policy version in force for a person on a date. */
exports.policyForPersonAsync = _policyForPersonAsync;

// ---------------------------------------------------------------------------
// the evaluator — screens ask, they never decide
// ---------------------------------------------------------------------------

/**
 * The single decision point. Given a person, a date range and a leave type,
 * returns whether it is allowed, which rule decided, how many days deduct and
 * who approves — with the arithmetic shown line by line (J4).
 *
 * @param {object} request {org_id, person_id, leave_type, from_date, to_date,
 *      notice_days, asOf}
 * @returns {object} The evaluation
 */
exports.evaluateAsync = async function(request) {
    const {org_id, person_id, leave_type} = request;
    const from_date = _assertISODate(request.from_date, "from_date");
    const to_date = _assertISODate(request.to_date, "to_date");
    if (to_date < from_date) throw new Error("to_date must not be before from_date.");
    const asOf = request.asOf || _today();

    const evaluation = {allowed: false, leave_type, from_date, to_date, asOf,
        policy_version_id: null, rule_fired: null, reason: null, route: null,
        steps: [], warnings: [], days_deducted: 0, clubbed_days: 0,
        working_days: 0, proof_required: null, approval_route: null, balance_available: null};

    const {employment, version, scope_mismatch} = await _policyForPersonAsync(org_id, person_id, from_date);
    if (!employment) return {...evaluation, rule_fired: "no_employment",
        reason: "No employment is in force on the requested date."};
    if (!version) return {...evaluation, rule_fired: scope_mismatch ? "policy_scope" : "no_policy",
        reason: scope_mismatch ?
            `The policy for ${employment.jurisdiction} does not cover ${employment.contract_type} / ${employment.status} employment.` :
            `No published leave policy covers ${employment.jurisdiction}.`};
    evaluation.policy_version_id = version.policy_version_id;

    const policy = JSON.parse(version.policy);
    const type = policy.leave_types.find(entry => entry.code == leave_type);
    if (!type) return {...evaluation, rule_fired: "no_type",
        reason: `${leave_type} is not a leave type in policy v${version.version}.`};

    const step = (rule, ok, reason, route) => {
        evaluation.steps.push({rule, ok, reason});
        if (!ok) {evaluation.allowed = false; evaluation.rule_fired = rule;
            evaluation.reason = reason; evaluation.route = route || null;}
        return ok;
    };

    // 1. eligibility
    if (type.eligibility?.states?.length &&
        !type.eligibility.states.includes(employment.status) && !step("eligibility", false,
            `Policy v${version.version}: ${leave_type} is eligible in ${type.eligibility.states.join(", ")}, not in ${employment.status}.`))
        return evaluation;

    // 2. backdating
    const today = _today();
    const allowedBackdating = type.backdating?.allowed_days ?? 0;
    if (from_date < today && !step("backdating", _daysBetween(from_date, today) <= allowedBackdating,
        `Policy v${version.version} permits backdating ${allowedBackdating} day(s) for ${type.backdating?.for_types?.join(", ") || "no types"} only.`,
        "Request for the current or a future date."))
        return evaluation;

    // 3. the arithmetic — working days and the clubbing rule
    const window = await windows.getOpenWindowAsync(org_id, person_id);
    const workingDays = _workingDaysInRange(window, from_date, to_date);
    const clubbingCandidates = window ? _clubbingCandidates(window, from_date, to_date) : 0;
    const clubbedDays = await _clubbedDaysAsync(org_id, person_id, leave_type, type, from_date, clubbingCandidates, evaluation);
    const deduction = workingDays + clubbedDays;
    if (deduction <= 0) return {...evaluation, rule_fired: "no_working_days",
        reason: "The range contains no working days."};

    // 4. lifetime counters
    if (type.lifetime_max) {
        const used = await _lifetimeUsesAsync(org_id, person_id, leave_type);
        if (!step("lifetime_max", used < type.lifetime_max,
            `Policy v${version.version}: ${leave_type} is allowed ${type.lifetime_max} time(s) per lifetime; ${used} already used.`))
            return evaluation;
    }

    // 5. ordered exhaustion
    if (type.requires_exhausted?.length) {
        const remaining = [];
        for (const paidType of type.requires_exhausted) {
            const balance = await exports.balanceAsync({org_id, person_id, leave_type: paidType, asOf});
            if (balance.available > 0) remaining.push(`${paidType} (${balance.available})`);
        }
        if (!step("requires_exhausted", remaining.length == 0,
            `Policy v${version.version}: ${leave_type} needs ${type.requires_exhausted.join(", ")} exhausted first. Still available: ${remaining.join(", ")}.`))
            return evaluation;
    }

    // 6. consumption caps, separate from balance
    if (type.max_per_request && !step("max_per_request", deduction <= type.max_per_request,
        `Policy v${version.version}: at most ${type.max_per_request} day(s) per request; this would deduct ${deduction}.`))
        return evaluation;
    if (type.max_per_period) {
        const period = type.max_per_period.period || "quarter";
        const consumed = await _consumedInPeriodAsync(org_id, person_id, leave_type, from_date, period);
        if (!step("max_per_period", consumed + deduction <= type.max_per_period.days,
            `Policy v${version.version}: ${type.max_per_period.days} day(s) per ${period}, ${consumed} already used this ${period}.`,
            "Split the request across periods."))
            return evaluation;
    }

    // 7. balance — the projection. Types without a quantum (ML, LWP) are not
    // balance-gated: they are gated by eligibility, lifetime and exhaustion rules.
    const hasQuantum = Boolean(type.quantum || type.accrual);
    if (hasQuantum) {
        const balance = await exports.balanceAsync({org_id, person_id, leave_type, asOf});
        evaluation.balance_available = balance.available;
        const routes = [];
        if (!step("balance", balance.available >= deduction,
            `Policy v${version.version}: ${balance.available} day(s) available, ${deduction} needed.`, routes.join(" "))) {
            for (const other of policy.leave_types) {
                if (other.code == leave_type || !other.quantum) continue;
                const otherBalance = await exports.balanceAsync({org_id, person_id, leave_type: other.code, asOf});
                if (otherBalance.available > 0) routes.push(`${other.code} (${otherBalance.available} available)`);
            }
            evaluation.route = routes.length ? `Use ${routes.join(" or ")}.` : evaluation.route;
            return evaluation;
        }
    }

    // 8. exclusivity — non-combinable types check overlap with other pending requests
    const combinable = new Set([leave_type, ...(type.combinable_with||[])]);
    const overlaps = await _overlappingRequestsAsync(org_id, person_id, from_date, to_date);
    for (const overlap of overlaps) if (!combinable.has(overlap.leave_type) && !step("exclusivity", false,
        `Policy v${version.version}: ${leave_type} cannot be combined with ${overlap.leave_type} (${overlap.from_date}–${overlap.to_date}).`,
        `Make the whole request ${leave_type}, or split it.`))
        return evaluation;

    // 9. notice — a warning with a named exception path, not a hard block (J4)
    if (type.notice) {
        const required = Math.max(type.notice.floor_days || 0,
            (type.notice.multiplier || 0) * deduction);
        if ((request.notice_days ?? 0) < required && type.notice.short_notice_approvable)
            evaluation.warnings.push({rule: "notice",
                reason: `Notice is short: ${deduction} day(s) needs ${required} days' notice, you are giving ${request.notice_days ?? 0}. Your manager can approve it as a short-notice exception, explicitly, with HR copied.`});
    }

    // 10. escalating proof
    if (type.proof_after_consecutive_days && deduction >= type.proof_after_consecutive_days)
        evaluation.proof_required = `${leave_type} needs proof from day ${type.proof_after_consecutive_days} (policy v${version.version}).`;

    evaluation.allowed = true;
    evaluation.working_days = workingDays;
    evaluation.clubbed_days = clubbedDays;
    evaluation.days_deducted = deduction;
    evaluation.approval_route = type.approval_route;
    evaluation.reason = `Policy v${version.version}: ${workingDays} working day(s)${clubbedDays ? ` plus ${clubbedDays} clubbed` : ""} = ${deduction} deducted.`;
    evaluation.steps.push({rule: "allowed", ok: true, reason: evaluation.reason});
    return evaluation;
}

// ---------------------------------------------------------------------------
// the ledger and the projection
// ---------------------------------------------------------------------------

/**
 * The balance, projected over the ledger under the policy in force — never
 * stored. Opening assertions (B6), materialised accruals and deductions all
 * flow in; units past their own expiry clock do not. Accruals are materialised
 * idempotently first, so the projection always includes everything it should.
 *
 * @param {object} request {org_id, person_id, leave_type, asOf}
 * @returns {object} {available, opening, accrued, deducted, expiring, policy_version_id}
 */
exports.balanceAsync = async function(request) {
    const asOf = _assertISODate(request.asOf || _today(), "asOf");
    const {version} = await _policyForPersonAsync(request.org_id, request.person_id, asOf);
    const policy = version ? JSON.parse(version.policy) : null;
    const type = policy?.leave_types.find(entry => entry.code == request.leave_type) || null;

    if (type?.accrual) await _materialiseAccrualsAsync(request.org_id, request.person_id,
        request.leave_type, version, type, asOf);

    const opening = await dblayer.getQueryOrThrow(
        "SELECT COALESCE(SUM(days),0) AS days FROM opening_balance_entry WHERE org_id=? AND person_id=? AND leave_type=? AND cutover_date <= ?",
        [request.org_id, request.person_id, request.leave_type, asOf]);
    const entries = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_ledger_entry WHERE org_id=? AND person_id=? AND leave_type=? AND entry_date <= ? ORDER BY entry_date ASC",
        [request.org_id, request.person_id, request.leave_type, asOf]);

    let accrued = 0, deducted = 0; const expiring = [];
    for (const entry of entries) {
        const expiresOn = _expiresOn(entry, type);
        if (expiresOn && expiresOn <= asOf) continue;        // past its own expiry clock
        if (entry.days > 0) accrued += entry.days; else deducted += -entry.days;
        if (expiresOn && _daysBetween(asOf, expiresOn) <= EXPIRING_WINDOW_DAYS)
            expiring.push({entry_id: entry.leave_ledger_entry_id, leave_type: entry.leave_type,
                days: entry.days, entry_date: entry.entry_date, expires_on: expiresOn});
    }
    const available = opening[0].days + accrued - deducted;
    return {available, opening: opening[0].days, accrued, deducted, expiring,
        policy_version_id: version?.policy_version_id || null};
}

/** Writes the accrual rows owed up to asOf. Idempotent — a month already accrued stays put. */
async function _materialiseAccrualsAsync(org_id, person_id, leave_type, version, type, asOf) {
    const perMonth = type.accrual.per_month || 0;
    if (perMonth <= 0) return;
    const employment = await spine.getOpenEmploymentAsync(org_id, person_id);
    if (!employment) return;
    const from = employment.valid_from;

    let month = new Date(`${from}T00:00:00Z`);
    const upTo = new Date(`${asOf}T00:00:00Z`);
    while (month <= upTo) {
        const entryDate = month.toISOString().substring(0, 7) + "-01";
        const existing = await dblayer.getQueryOrThrow(
            `SELECT * FROM leave_ledger_entry WHERE org_id=? AND person_id=? AND leave_type=? AND kind='accrual' AND entry_date=?`,
            [org_id, person_id, leave_type, entryDate]);
        if (!existing.length) {
            // no accrual during approved unpaid leave (LWP freezes, J1)
            const frozen = await dblayer.getQueryOrThrow(
                `SELECT * FROM leave_request WHERE org_id=? AND person_id=? AND status='approved'
                    AND leave_type IN (${(type.accrual.freezes_on||[]).map(_ => "?").join(",") || "''"})
                    AND from_date <= ? AND to_date >= ? LIMIT 1`,
                [org_id, person_id, ...(type.accrual.freezes_on||[]), entryDate, entryDate]);
            if (!frozen.length) await _appendEntryAsync(org_id, person_id, leave_type, perMonth,
                "accrual", entryDate, version.policy_version_id, null, null, "system");
        }
        month = new Date(month.getTime() + 32*DAY_MS); month.setUTCDate(1);   // first of next month
    }
}

function _ledgerRow(entry) {
    return {leave_ledger_entry_id: serverutils.generateUUID(false), org_id: entry.org_id,
        person_id: entry.person_id, leave_type: entry.leave_type, days: entry.days, kind: entry.kind,
        entry_date: entry.entry_date, policy_version_id: entry.policy_version_id || null,
        reason: entry.reason || null, source_request_id: entry.source_request_id || null,
        batch_id: entry.batch_id || null, recorded_at: _now(), recorded_by: entry.recorded_by || null};
}

/**
 * Inserts a prepared ledger row through an executor — the queued path and a
 * runInTransactionAsync path share this, so a J7 run can write its rows inside
 * the run's own transaction.
 * @param {object} exec {runCmd, getQuery}
 * @param {object} entry As for recordEntryAsync
 * @returns The recorded row
 */
exports.insertLedgerEntryAsync = async function(exec, entry) {
    const row = _ledgerRow(entry);
    await exec.runCmd(
        `INSERT INTO leave_ledger_entry (leave_ledger_entry_id, org_id, person_id, leave_type, days,
            kind, entry_date, policy_version_id, reason, source_request_id, batch_id, recorded_at, recorded_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.leave_ledger_entry_id, row.org_id, row.person_id, row.leave_type, row.days, row.kind,
            row.entry_date, row.policy_version_id, row.reason, row.source_request_id, row.batch_id,
            row.recorded_at, row.recorded_by]);
    return row;
}

async function _appendEntryAsync(org_id, person_id, leave_type, days, kind, entry_date,
    policy_version_id, reason, source_request_id, recorded_by, batch_id) {
    return await exports.insertLedgerEntryAsync({runCmd: dblayer.runCmdOrThrow},
        {org_id, person_id, leave_type, days, kind, entry_date, policy_version_id, reason,
            source_request_id, recorded_by, batch_id});
}

function _expiresOn(entry, type) {
    if (!type?.expiry?.months || entry.days <= 0) return null;
    const expires = new Date(`${entry.entry_date}T00:00:00Z`);
    expires.setUTCMonth(expires.getUTCMonth() + type.expiry.months);
    return expires.toISOString().substring(0, 10);
}

/**
 * Appends a ledger entry — the write path accruals, deductions, lapses and
 * adjustments all share. Every entry pins the policy version that produced it.
 * @param {object} entry {org_id, person_id, leave_type, days, kind, entry_date,
 *      policy_version_id, reason, source_request_id, recorded_by, batch_id}
 */
exports.recordEntryAsync = async function(entry) {
    return await _appendEntryAsync(entry.org_id, entry.person_id, entry.leave_type, entry.days,
        entry.kind, entry.entry_date, entry.policy_version_id, entry.reason,
        entry.source_request_id, entry.recorded_by, entry.batch_id);
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

/**
 * Creates a leave request. The evaluation is pinned to the request — the policy
 * version, every rule outcome and the deduction working — so a republished
 * policy never silently re-evaluates it. Hard refusals throw with the
 * evaluation attached; a short-notice warning does not block (J4).
 *
 * @param {object} request {org_id, person_id, leave_type, from_date, to_date,
 *      notice_days, reason, fields}
 * @returns {object} {request, evaluation}
 */
exports.requestLeaveAsync = async function(request) {
    const evaluation = await exports.evaluateAsync(request);
    if (!evaluation.allowed) {
        const err = new Error(`${evaluation.rule_fired}: ${evaluation.reason}`);
        err.evaluation = evaluation;
        throw err;
    }

    const row = {leave_request_id: serverutils.generateUUID(false), org_id: request.org_id,
        person_id: request.person_id, leave_type: request.leave_type,
        from_date: evaluation.from_date, to_date: evaluation.to_date,
        days_requested: evaluation.working_days, days_deducted: evaluation.days_deducted,
        status: REQUEST_STATUS.PENDING, policy_version_id: evaluation.policy_version_id,
        evaluation: JSON.stringify(evaluation), notice_days: request.notice_days || 0,
        fields: request.fields ? JSON.stringify(request.fields) : null,
        reason: request.reason || null, created_at: _now(), submitted_at: _now()};

    await dblayer.runCmdOrThrow(
        `INSERT INTO leave_request (leave_request_id, org_id, person_id, leave_type, from_date, to_date,
            days_requested, days_deducted, status, policy_version_id, evaluation, notice_days, fields,
            reason, created_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.leave_request_id, row.org_id, row.person_id, row.leave_type, row.from_date, row.to_date,
            row.days_requested, row.days_deducted, row.status, row.policy_version_id, row.evaluation,
            row.notice_days, row.fields, row.reason, row.created_at, row.submitted_at]);

    LOG.info(`Leave request ${row.leave_request_id}: ${request.leave_type} ${row.from_date}–${row.to_date} for ${request.person_id}.`);
    return {request: row, evaluation};
}

/**
 * A person's requests, newest first.
 * @returns {array}
 */
exports.requestsForPersonAsync = async function(org_id, person_id) {
    return await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_request WHERE org_id=? AND person_id=? ORDER BY created_at DESC",
        [org_id, person_id]);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function _daysBetween(fromISO, toISO) {
    return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`))/DAY_MS);
}

function _isWorkday(window, isoDate) {
    if (!window) return true;       // no declared window — every day is a working day
    const weekday = ((new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    return JSON.parse(window.days).includes(weekday);
}

function _workingDaysInRange(window, fromISO, toISO) {
    let count = 0; const cursor = new Date(`${fromISO}T00:00:00Z`);
    const end = Date.parse(`${toISO}T00:00:00Z`);
    while (cursor.getTime() <= end) {
        if (_isWorkday(window, cursor.toISOString().substring(0, 10))) count++;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
}

/** Non-working days inside or adjacent to the range — the clubbing candidates (J4).
 * The scan reaches one day before and two after, so a Friday leave sees its whole weekend. */
function _clubbingCandidates(window, fromISO, toISO) {
    const cursor = new Date(Date.parse(`${fromISO}T00:00:00Z`) - DAY_MS);
    const end = Date.parse(`${toISO}T00:00:00Z`) + 2*DAY_MS;
    let count = 0;
    while (cursor.getTime() <= end) {
        const iso = cursor.toISOString().substring(0, 10);
        if (!_isWorkday(window, iso)) count++;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
}

/**
 * Applies the clubbing rule. "Exempt first, then counted" needs a window (J2),
 * and the first occurrence is resolved against the person's history in that
 * window — a weekend adjacent to leave is free the first time, charged from
 * the second clubbing onwards.
 */
async function _clubbedDaysAsync(org_id, person_id, leave_type, type, fromISO, candidates, evaluation) {
    if (!type.clubbing || !candidates || type.clubbing.mode == "never") return 0;
    if (type.clubbing.mode == "always") return candidates;

    const windowId = _clubbingWindowId(fromISO, type.clubbing.window);
    const prior = await dblayer.getQueryOrThrow(
        `SELECT * FROM leave_request WHERE org_id=? AND person_id=? AND leave_type=?
            AND status IN ('approved','pending') AND evaluation LIKE ? AND from_date < ? LIMIT 1`,
        [org_id, person_id, leave_type, `%"clubbing_window":"${windowId}"%`, fromISO]);
    if (prior.length) {
        evaluation.steps.push({rule: "clubbing", ok: true,
            reason: `This is a later clubbing in ${windowId}: ${candidates} non-working day(s) in or adjacent to the range are charged (policy: exempt first, then counted).`});
        evaluation.clubbing_window = windowId;
        return candidates;
    }
    evaluation.steps.push({rule: "clubbing", ok: true,
        reason: `First clubbing occurrence in ${windowId}: the ${candidates} adjacent non-working day(s) are not charged (policy: exempt first).`});
    evaluation.clubbing_window = windowId;
    evaluation.clubbing_exempted = candidates;
    return 0;
}

function _clubbingWindowId(isoDate, window) {
    if (window == "per_financial_year") {
        const month = isoDate.substring(5, 7);
        const year = parseInt(isoDate.substring(0, 4), 10);
        return month >= "04" ? `FY${year}` : `FY${year-1}`;
    }
    if (window == "per_calendar_year") return isoDate.substring(0, 4);
    return isoDate.substring(0, 7);
}

async function _lifetimeUsesAsync(org_id, person_id, leave_type) {
    const deductions = (await dblayer.getQueryOrThrow(
        `SELECT COALESCE(COUNT(*),0) AS c FROM leave_ledger_entry WHERE org_id=? AND person_id=?
            AND leave_type=? AND kind='deduction'`, [org_id, person_id, leave_type]))[0].c;
    const requests = (await dblayer.getQueryOrThrow(
        `SELECT COALESCE(COUNT(*),0) AS c FROM leave_request WHERE org_id=? AND person_id=?
            AND leave_type=? AND status IN ('approved','pending')`, [org_id, person_id, leave_type]))[0].c;
    return deductions + requests;
}

async function _consumedInPeriodAsync(org_id, person_id, leave_type, fromISO, period) {
    const start = period == "quarter" ? _quarterStart(fromISO) : `${fromISO.substring(0, 4)}-01-01`;
    const end = period == "quarter" ? _quarterEnd(fromISO) : `${fromISO.substring(0, 4)}-12-31`;
    const requests = (await dblayer.getQueryOrThrow(
        `SELECT COALESCE(SUM(days_deducted),0) AS days FROM leave_request WHERE org_id=? AND person_id=?
            AND leave_type=? AND status IN ('approved','pending') AND from_date >= ? AND from_date <= ?`,
        [org_id, person_id, leave_type, start, end]))[0].days;
    const ledger = (await dblayer.getQueryOrThrow(
        `SELECT COALESCE(SUM(-days),0) AS days FROM leave_ledger_entry WHERE org_id=? AND person_id=?
            AND leave_type=? AND kind='deduction' AND entry_date >= ? AND entry_date <= ?`,
        [org_id, person_id, leave_type, start, end]))[0].days;
    return requests + ledger;
}

function _quarterStart(isoDate) {
    const month = isoDate.substring(5, 7);
    const year = isoDate.substring(0, 4);
    return { "01": `${year}-01-01`, "02": `${year}-01-01`, "03": `${year}-01-01`,
        "04": `${year}-04-01`, "05": `${year}-04-01`, "06": `${year}-04-01`,
        "07": `${year}-07-01`, "08": `${year}-07-01`, "09": `${year}-07-01` }[month] || `${year}-10-01`;
}

function _quarterEnd(isoDate) {
    const start = _quarterStart(isoDate);
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 3); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().substring(0, 10);
}

async function _overlappingRequestsAsync(org_id, person_id, fromISO, toISO) {
    return await dblayer.getQueryOrThrow(
        `SELECT * FROM leave_request WHERE org_id=? AND person_id=? AND status IN ('pending','approved')
            AND from_date <= ? AND to_date >= ?`,
        [org_id, person_id, toISO, fromISO]);
}

// ---------------------------------------------------------------------------
// approvals — routing is policy data (J5)
// ---------------------------------------------------------------------------

const DEFAULT_ESCALATION_DAYS = 3;

/** The sequential approval steps — hr_informed is a notification, not a step. */
function _approvalSteps(route) {
    return route.filter(token => token != "hr_informed");
}

/** Does this step token accept this actor? manager is the person's manager as of the request. */
function _stepAccepts(token, actor, managerPersonId, isOrgApprover) {
    switch (token) {
        case "manager": return Boolean(managerPersonId) && managerPersonId == actor;
        case "hr":
        case "management_review": return isOrgApprover;
        case "manager_or_hr":
            return (Boolean(managerPersonId) && managerPersonId == actor) || isOrgApprover;
        default: return false;
    }
}

async function _isOrgApproverAsync(org_id, actor_person_id, subject_person_id) {
    const decision = await permissions.checkAsync({org_id, actor_person_id,
        capability: "leave.approve", subject_person_id});
    if (decision.allowed) return decision.matched_grant?.scope_type == "org";
    // Engine-blocked (for example sod.self_approval) still means org-scoped: the
    // block must surface as the decision error from the permission check inside
    // the approval, not be laundered into a routing refusal.
    return decision.outcome == "blocked_by_rule";
}

async function _getRequestAsync(org_id, leave_request_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_request WHERE org_id=? AND leave_request_id=?", [org_id, leave_request_id]);
    return rows.length ? rows[0] : null;
}

/** The routing context for a pending request: steps, current token, manager and org-approver flag. */
async function _approvalContextAsync(request, actor_person_id) {
    const versionRows = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_policy_version WHERE policy_version_id=?", [request.policy_version_id]);
    const policy = JSON.parse(versionRows[0].policy);
    const type = policy.leave_types.find(entry => entry.code == request.leave_type);
    const steps = _approvalSteps(type.approval_route);
    const token = steps[request.approval_step];
    const manager = await spine.managerAsOfAsync(request.org_id, request.person_id, request.from_date);
    const isOrgApprover = actor_person_id ?
        await _isOrgApproverAsync(request.org_id, actor_person_id, request.person_id) : false;
    const evaluation = JSON.parse(request.evaluation);
    return {policy, type, steps, token, manager, isOrgApprover, evaluation};
}

/**
 * Approves the request's current step. On a multi-step route the request stays
 * pending and advances; on the final step it becomes approved and the deduction
 * is written to the ledger — stamped with the policy version pinned at
 * evaluation. The approval is an audit signature; the write and the audit entry
 * commit together.
 *
 * A short-notice request needs the explicit exception flag — the policy requires
 * the manager to record it (J5), so the API refuses a silent approval.
 *
 * @param {object} request {org_id, actor_person_id, leave_request_id, approve_as_exception}
 * @returns {object} {result, balance_after}
 */
exports.approveLeaveRequestAsync = async function(request) {
    const pending = await _getRequestAsync(request.org_id, request.leave_request_id);
    if (!pending || pending.status != REQUEST_STATUS.PENDING) throw new Error(
        `Leave request ${request.leave_request_id} is not awaiting approval.`);
    const {steps, token, manager, isOrgApprover, evaluation} = await _approvalContextAsync(pending, request.actor_person_id);

    if (!_stepAccepts(token, request.actor_person_id, manager, isOrgApprover)) throw new Error(
        `You are not the approver for this step (${token}). ${token == "manager" ?
            "The approver is the person's manager of record." : "This step needs an org-scoped leave approver (HR or org admin)."}`);
    const shortNotice = evaluation.warnings.some(warning => warning.rule == "notice");
    if (token == "manager" && shortNotice && request.approve_as_exception !== true) throw new Error(
        "This request is short notice. The policy allows a manager-approved exception — approve it explicitly with approve_as_exception.");

    const isFinal = pending.approval_step + 1 >= steps.length;
    const result = await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "leave.approve", subject_person_id: pending.person_id,
        audit: {action: "leave.approved", object_type: "leave_request", object_ref: pending.leave_request_id,
            subject_person_id: pending.person_id,
            detail: {leave_type: pending.leave_type, from_date: pending.from_date, to_date: pending.to_date,
                days_deducted: pending.days_deducted, step: token, step_index: pending.approval_step,
                final: isFinal, short_notice_exception: request.approve_as_exception === true}},
        action: async exec => {
            const rows = await exec.getQuery(
                "SELECT * FROM leave_request WHERE leave_request_id=?", [pending.leave_request_id]);
            if (!rows.length || rows[0].status != REQUEST_STATUS.PENDING ||
                rows[0].approval_step != pending.approval_step) throw new Error(
                "The request moved while this approval was in flight. Refresh and try again.");

            const exceptions = JSON.parse(rows[0].approval_exceptions || "[]");
            if (request.approve_as_exception === true && !exceptions.includes("short_notice"))
                exceptions.push("short_notice");
            const exceptionsJSON = JSON.stringify(exceptions);

            if (isFinal) {
                await exec.runCmd(`UPDATE leave_request SET status='approved', decided_by=?, decided_at=?,
                    approval_exceptions=? WHERE leave_request_id=?`,
                    [request.actor_person_id, _now(), exceptionsJSON, pending.leave_request_id]);
                await exec.runCmd(`INSERT INTO leave_ledger_entry (leave_ledger_entry_id, org_id, person_id,
                    leave_type, days, kind, entry_date, policy_version_id, reason, source_request_id,
                    recorded_at, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [serverutils.generateUUID(false), pending.org_id, pending.person_id, pending.leave_type,
                        -pending.days_deducted, "deduction", pending.from_date, pending.policy_version_id,
                        "approved", pending.leave_request_id, _now(), request.actor_person_id]);
                return "approved";
            }
            await exec.runCmd(`UPDATE leave_request SET approval_step=approval_step+1, decided_by=?,
                decided_at=?, approval_exceptions=? WHERE leave_request_id=?`,
                [request.actor_person_id, _now(), exceptionsJSON, pending.leave_request_id]);
            return "partial";
        }});

    const balanceAfter = isFinal ? await exports.balanceAsync({org_id: request.org_id,
        person_id: pending.person_id, leave_type: pending.leave_type, asOf: pending.from_date}) : null;
    return {result, step: token, final: isFinal, balance_after: balanceAfter};
}

/**
 * Declines a request, with a reason — every decline names why, and the reason
 * is kept on the record (J3 note 5). Audited like an approval.
 * @param {object} request {org_id, actor_person_id, leave_request_id, reason}
 */
exports.declineLeaveRequestAsync = async function(request) {
    if (!request.reason?.trim()) throw new Error(
        "A decline names the reason. A silent decline teaches people to stop asking (J3).");
    const pending = await _getRequestAsync(request.org_id, request.leave_request_id);
    if (!pending || pending.status != REQUEST_STATUS.PENDING) throw new Error(
        `Leave request ${request.leave_request_id} is not awaiting approval.`);
    const {steps, token, manager, isOrgApprover} = await _approvalContextAsync(pending, request.actor_person_id);
    if (!_stepAccepts(token, request.actor_person_id, manager, isOrgApprover)) throw new Error(
        `You are not the approver for this step (${token}).`);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "leave.approve", subject_person_id: pending.person_id,
        audit: {action: "leave.declined", object_type: "leave_request", object_ref: pending.leave_request_id,
            subject_person_id: pending.person_id, reason: request.reason,
            detail: {leave_type: pending.leave_type, from_date: pending.from_date, step: token}},
        action: async exec => {
            await exec.runCmd(`UPDATE leave_request SET status='declined', decided_by=?, decided_at=?,
                decision_reason=? WHERE leave_request_id=?`,
                [request.actor_person_id, _now(), request.reason, pending.leave_request_id]);
            return "declined";
        }});
}

/**
 * Cancels the person's own request. A pending request simply closes; an
 * approved one writes a reversal entry that returns the days — a cancellation
 * is a reversal, never an edit (J5 note 7).
 * @param {object} request {org_id, person_id, leave_request_id}
 */
exports.cancelLeaveRequestAsync = async function(request) {
    const own = await _getRequestAsync(request.org_id, request.leave_request_id);
    if (!own || own.person_id != request.person_id) throw new Error(
        `Leave request ${request.leave_request_id} was not found, or it is not yours.`);
    if (![REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED].includes(own.status)) throw new Error(
        `A ${own.status} request cannot be cancelled.`);

    return await dblayer.runInTransactionAsync(async exec => {
        let reversalDays = 0;
        if (own.status == REQUEST_STATUS.APPROVED) {
            reversalDays = own.days_deducted;
            await exec.runCmd(`INSERT INTO leave_ledger_entry (leave_ledger_entry_id, org_id, person_id,
                leave_type, days, kind, entry_date, policy_version_id, reason, source_request_id,
                recorded_at, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [serverutils.generateUUID(false), own.org_id, own.person_id, own.leave_type,
                    own.days_deducted, "reversal", own.from_date, own.policy_version_id,
                    "cancelled before start", own.leave_request_id, _now(), request.person_id]);
        }
        await exec.runCmd("UPDATE leave_request SET status='cancelled', decided_at=? WHERE leave_request_id=?",
            [_now(), own.leave_request_id]);
        await audit.insertEntryViaAsync(exec, {org_id: request.org_id, action: "leave.cancelled",
            object_type: "leave_request", object_ref: own.leave_request_id,
            actor_person_id: request.person_id, subject_person_id: request.person_id,
            detail: {reversed_days: reversalDays}},
            await permissions.effectivePermissionsAsync(request.org_id, request.person_id, _today(), exec));
        return {status: "cancelled", reversed_days: reversalDays};
    });
}

/**
 * The approvals queue for a person — every pending request whose current step
 * accepts them, with the context that decides it: balance after approval,
 * quarter usage, the short-notice flag, and whether proof was provided.
 * Documents themselves never appear here — approvers see that a certificate
 * exists, not the certificate (J5 note 8).
 * @param {object} request {org_id, actor_person_id}
 */
exports.pendingApprovalsForAsync = async function(request) {
    const pending = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_request WHERE org_id=? AND status='pending' ORDER BY submitted_at ASC",
        [request.org_id]);
    const queue = [];
    for (const leaveRequest of pending) {
        const {steps, token, manager, isOrgApprover, evaluation} = await _approvalContextAsync(leaveRequest, request.actor_person_id);
        if (!_stepAccepts(token, request.actor_person_id, manager, isOrgApprover)) continue;
        const balanceAfter = await exports.balanceAsync({org_id: request.org_id,
            person_id: leaveRequest.person_id, leave_type: leaveRequest.leave_type, asOf: _today()});
        const fields = leaveRequest.fields ? JSON.parse(leaveRequest.fields) : {};
        queue.push({leave_request_id: leaveRequest.leave_request_id, person_id: leaveRequest.person_id,
            leave_type: leaveRequest.leave_type, from_date: leaveRequest.from_date,
            to_date: leaveRequest.to_date, days_deducted: leaveRequest.days_deducted,
            step: token, step_index: leaveRequest.approval_step, steps: steps.length,
            balance_after: balanceAfter.available,
            short_notice: evaluation.warnings.some(warning => warning.rule == "notice"),
            proof_provided: Boolean(fields.proof || fields.medical_certificate),
            reason: leaveRequest.reason, submitted_at: leaveRequest.submitted_at});
    }
    return queue;
}

/**
 * Requests that have sat unanswered past the policy's escalation window. The
 * list names how long each has waited and where it should go next — nothing
 * sits unanswered (J5 note 6).
 * @param {string} org_id The org
 */
exports.escalationsDueAsync = async function(org_id) {
    const pending = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_request WHERE org_id=? AND status='pending' ORDER BY submitted_at ASC", [org_id]);
    const due = [];
    for (const leaveRequest of pending) {
        const versionRows = await dblayer.getQueryOrThrow(
            "SELECT * FROM leave_policy_version WHERE policy_version_id=?", [leaveRequest.policy_version_id]);
        const policy = JSON.parse(versionRows[0].policy);
        const windowDays = policy.escalation_after_days || DEFAULT_ESCALATION_DAYS;
        const waitingDays = Math.floor((_now() - leaveRequest.submitted_at)/86400);
        if (waitingDays < windowDays) continue;
        const {token, manager} = await _approvalContextAsync(leaveRequest, null);
        let routeTo = null;
        if (token == "manager" && manager)
            routeTo = await spine.managerAsOfAsync(org_id, manager, _today());
        due.push({leave_request_id: leaveRequest.leave_request_id, person_id: leaveRequest.person_id,
            leave_type: leaveRequest.leave_type, waiting_days: waitingDays, window_days: windowDays,
            stalled_at_step: token, route_to: routeTo});
    }
    return due;
}

exports.REQUEST_STATUS = REQUEST_STATUS;

/**
 * The approved-leave facts in force over a date range — J6's single source for
 * "is this person on leave on this date". Only approved requests are facts:
 * pending and declined requests are not yet, and a cancelled one stops being
 * one (its reversal is what the ledger says).
 *
 * @param {string} org_id The org
 * @param {array} person_ids The people
 * @param {string} from_date ISO date, inclusive
 * @param {string} to_date ISO date, inclusive
 * @returns {array} [{leave_request_id, person_id, leave_type, from_date, to_date, days_deducted}]
 */
exports.approvedLeaveForAsync = async function(org_id, person_ids, from_date, to_date) {
    if (!Array.isArray(person_ids) || !person_ids.length) return [];
    const placeholders = person_ids.map(_ => "?").join(",");
    return await dblayer.getQueryOrThrow(
        `SELECT leave_request_id, person_id, leave_type, from_date, to_date, days_deducted
            FROM leave_request WHERE org_id=? AND status='approved' AND from_date <= ?
                AND to_date >= ? AND person_id IN (${placeholders})
            ORDER BY from_date ASC, submitted_at ASC`,
        [org_id, to_date, from_date, ...person_ids]);
}
