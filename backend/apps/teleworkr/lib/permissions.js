/**
 * The L2 permission engine — capability x scope, with deny winning everywhere.
 *
 * Every decision this returns is explainable. A refusal carries the rule that
 * produced it and who can perform the action instead, because L2 is explicit that
 * a dead end with no name attached just generates a support ticket.
 *
 * A scope this engine cannot resolve is a refusal, never an allow. That is the A8
 * invariant applied to permissions: never silently succeed with wrong data.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);

const {SCOPES, EFFECTS} = capabilities;

const OUTCOMES = Object.freeze({
    ALLOWED: "allowed",
    CEILING: "ceiling",
    UNKNOWN_CAPABILITY: "unknown_capability",
    DENIED_BY_GRANT: "denied_by_grant",
    NO_GRANT: "no_grant",
    OUT_OF_SCOPE: "out_of_scope",
    SCOPE_UNRESOLVABLE: "scope_unresolvable",
    BLOCKED_BY_RULE: "blocked_by_rule"
});

const REPORTING_LINE_MAX_DEPTH = 20;        // a cycle in the manager chain must not hang a permission check
const LAST_USED_STAMP_INTERVAL = 3600;      // seconds; the access review needs days, not seconds

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

/** Run on the supplied transaction executor when given, else on the serial queue. */
const _run = (cmd, params, exec) => exec ? exec.runCmd(cmd, params) : dblayer.runCmdOrThrow(cmd, params);
/** Query on the supplied transaction executor when given, else on the serial queue. */
const _query = (cmd, params, exec) => exec ? exec.getQuery(cmd, params) : dblayer.getQueryOrThrow(cmd, params);

// ---------------------------------------------------------------------------
// checking
// ---------------------------------------------------------------------------

/**
 * The single decision point. Everything that gates on permission calls this, and
 * the UI reflects its answer rather than implementing its own.
 *
 * @param {object} request {org_id, actor_person_id, capability, subject_person_id,
 *      asOf, context} where context may carry {target:{jurisdiction, team, project, location},
 *      delegated_for, removes_admin_from}
 * @returns {object} A decision — always with an outcome and a reason, never a bare boolean
 */
exports.checkAsync = async function(request) {
    const {org_id, actor_person_id, capability} = request;
    const subject_person_id = request.subject_person_id || null;
    const asOf = request.asOf || _today();
    const context = request.context || {};

    const decision = {allowed: false, outcome: null, capability, org_id, actor_person_id, subject_person_id,
        asOf, reason: null, rule: null, who_can: null, matched_grant: null, evaluated_at: _now()};

    if (!org_id || !capability) throw new Error("A permission check needs an org_id and a capability.");

    // 1. The ceiling. Checked before grants, because no arrangement of grants can reach it.
    if (capabilities.isCeiling(capability)) return {...decision, outcome: OUTCOMES.CEILING,
        reason: capabilities.CEILING[capability],
        who_can: "Nobody. This is a product invariant, not a permission setting."};

    // 2. A capability that is not in the catalogue is not grantable, so it is not checkable.
    if (!capabilities.definitionOf(capability)) return {...decision, outcome: OUTCOMES.UNKNOWN_CAPABILITY,
        reason: `${capability} is not in the capability catalogue.`,
        who_can: "Nobody, until the capability is added to the catalogue deliberately."};

    // 3. Separation of duties, before scope. These are engine rules rather than UI
    // hiding, and L2 requires a blocked action to say which rule blocked it — so they
    // run ahead of the grant lookup. Otherwise someone whose scope happens not to
    // cover themselves gets "out of scope", which is true but is not the reason.
    const ruleCtx = {org_id, actor_person_id, subject_person_id, capability, asOf, context};
    const deps = {countAdminsExcludingAsync: exports.countAdminsExcludingAsync};
    for (const [ruleId, rule] of Object.entries(capabilities.SOD_RULES)) {
        if (!rule.applies_to.includes(capability)) continue;
        if (await rule.blocks(ruleCtx, deps)) return {...decision, outcome: OUTCOMES.BLOCKED_BY_RULE,
            rule: ruleId, reason: `${rule.label}: ${rule.explain}`, who_can: rule.who_can};
    }

    const grants = await exports.activeGrantsAsync(org_id, actor_person_id, {capability, asOf});
    if (!grants.length) return {...decision, outcome: OUTCOMES.NO_GRANT,
        reason: `No grant of ${capability} is in force for this person on ${asOf}.`,
        who_can: await _describeWhoCanAsync(org_id, capability, subject_person_id, asOf, actor_person_id)};

    // 4. Deny wins, at every level. A matching deny ends the evaluation.
    let sawUnresolvableScope = null;
    for (const grant of grants.filter(g => g.effect == EFFECTS.DENY)) {
        const cover = await _scopeCoversAsync(grant, {org_id, actor_person_id, subject_person_id, asOf, context});
        if (cover.covers) return {...decision, outcome: OUTCOMES.DENIED_BY_GRANT, matched_grant: _summarise(grant),
            reason: `An explicit deny of ${capability} at scope ${grant.scope_type} is in force. Deny takes precedence over any allow.`,
            who_can: "Nobody, while this deny stands. An org admin can revoke it."};
    }

    // 5. An allow whose scope actually covers the target.
    let matched = null;
    for (const grant of grants.filter(g => g.effect == EFFECTS.ALLOW)) {
        const cover = await _scopeCoversAsync(grant, {org_id, actor_person_id, subject_person_id, asOf, context});
        if (cover.covers) {matched = grant; break;}
        if (cover.unresolvable) sawUnresolvableScope = cover.reason;
    }

    if (!matched) {
        if (sawUnresolvableScope) return {...decision, outcome: OUTCOMES.SCOPE_UNRESOLVABLE,
            reason: sawUnresolvableScope,
            who_can: "Nobody, until the scope can be resolved. Refusing rather than guessing is deliberate."};
        return {...decision, outcome: OUTCOMES.OUT_OF_SCOPE,
            reason: `This person holds ${capability}, but not at a scope covering ${subject_person_id ? "that person" : "that object"}.`,
            who_can: await _describeWhoCanAsync(org_id, capability, subject_person_id, asOf, actor_person_id)};
    }

    _stampLastUsed(matched);    // the access review needs this; it must never change the decision

    return {...decision, allowed: true, outcome: OUTCOMES.ALLOWED, matched_grant: _summarise(matched),
        reason: `Granted by ${matched.source_role ? `the ${matched.source_role} role` : "a direct grant"} at scope ${matched.scope_type}.`};
}

/**
 * Convenience for call sites that must not proceed on a refusal.
 * @param {object} request As for checkAsync
 * @returns The decision, when allowed
 * @throws An error carrying the decision, when refused
 */
exports.requireAsync = async function(request) {
    const decision = await exports.checkAsync(request);
    if (decision.allowed) return decision;
    const err = new Error(decision.reason);
    err.decision = decision;    // the caller renders the rule and who_can rather than a bare 403
    throw err;
}

// ---------------------------------------------------------------------------
// scope resolution
// ---------------------------------------------------------------------------

/**
 * Does this grant's scope cover the target of the action?
 * @returns {object} {covers, unresolvable, reason}
 */
async function _scopeCoversAsync(grant, ctx) {
    const {org_id, actor_person_id, subject_person_id, asOf, context} = ctx;
    const target = context.target || {};

    switch (grant.scope_type) {
        case SCOPES.SELF:
            return {covers: Boolean(subject_person_id) && (subject_person_id == actor_person_id)};

        case SCOPES.ORG:
            if (!subject_person_id) return {covers: true};   // an org-scoped grant covers an object with no person
            return {covers: Boolean(await spine.employmentAsOfAsync(org_id, subject_person_id, asOf))};

        case SCOPES.DIRECT_REPORTS: {
            if (!subject_person_id) return {covers: false};
            const manager = await spine.managerAsOfAsync(org_id, subject_person_id, asOf);
            return {covers: Boolean(manager) && (manager == actor_person_id)};
        }

        case SCOPES.REPORTING_LINE: {
            if (!subject_person_id) return {covers: false};
            return {covers: await _isInReportingLineAsync(org_id, actor_person_id, subject_person_id, asOf)};
        }

        case SCOPES.JURISDICTION: {
            if (subject_person_id) {
                const jurisdiction = await spine.jurisdictionAsOfAsync(org_id, subject_person_id, asOf);
                return {covers: Boolean(jurisdiction) && (jurisdiction == grant.scope_ref)};
            }
            if (target.jurisdiction) return {covers: target.jurisdiction == grant.scope_ref};
            return {covers: false, unresolvable: true,
                reason: `A grant scoped to jurisdiction ${grant.scope_ref} cannot be evaluated without a subject or a target jurisdiction.`};
        }

        // Membership for these lives in modules that do not exist yet. Refusing is
        // the correct answer until they do — an unresolved scope must never read as an allow.
        case SCOPES.TEAM:
        case SCOPES.PROJECT:
        case SCOPES.LOCATION:
            return {covers: false, unresolvable: true,
                reason: `Scope ${grant.scope_type} cannot be resolved yet — no membership record exists for it. The check is refused rather than guessed.`};

        default:
            return {covers: false, unresolvable: true, reason: `Unknown scope type ${grant.scope_type}.`};
    }
}

/**
 * Walks the manager chain upward from the subject, looking for the actor.
 * Depth-guarded, because a manager cycle must refuse rather than hang.
 */
async function _isInReportingLineAsync(org_id, actor_person_id, subject_person_id, asOf) {
    let current = subject_person_id; const seen = new Set([subject_person_id]);
    for (let depth = 0; depth < REPORTING_LINE_MAX_DEPTH; depth++) {
        const manager = await spine.managerAsOfAsync(org_id, current, asOf);
        if (!manager) return false;
        if (manager == actor_person_id) return true;
        if (seen.has(manager)) {
            LOG.error(`Manager cycle detected in org ${org_id} at ${manager} while resolving a reporting line.`);
            return false;
        }
        seen.add(manager); current = manager;
    }
    LOG.error(`Reporting line deeper than ${REPORTING_LINE_MAX_DEPTH} in org ${org_id}; refusing the check.`);
    return false;
}

// ---------------------------------------------------------------------------
// grants
// ---------------------------------------------------------------------------

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {object} filter {capability, asOf}
 * @param {object} exec Optional transaction executor, when called inside
 *      dblayer.runInTransactionAsync — the accessors would deadlock there
 * @returns The grants in force
 */
exports.activeGrantsAsync = async function(org_id, person_id, filter={}, exec) {
    if (!person_id) return [];
    const asOf = filter.asOf || _today();
    const params = [org_id, person_id, asOf, asOf];
    let sql = `SELECT * FROM capability_grant WHERE org_id=? AND person_id=? AND revoked_at IS NULL
        AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`;
    if (filter.capability) {sql += " AND capability=?"; params.push(filter.capability);}
    return exec ? await exec.getQuery(sql, params) : await dblayer.getQueryOrThrow(sql, params);
}

/**
 * Grants a capability at a scope.
 *
 * An ad-hoc grant — one not produced by a role — is an elevation, and L2 requires
 * elevation to carry an expiry and a reason at the moment it is granted. Permanent
 * by accident is how a five-role model becomes a twenty-role model.
 *
 * @param {object} grant {org_id, person_id, capability, scope_type, scope_ref, effect,
 *      granted_by, reason, valid_from, valid_to, source_role}
 * @param {object} exec Optional transaction executor
 * @returns The stored grant
 */
exports.grantAsync = async function(grant, exec) {
    const {org_id, person_id, capability} = grant;
    if (!org_id || !person_id) throw new Error("A grant needs an org_id and a person_id.");

    const effect = grant.effect || EFFECTS.ALLOW;
    if (effect == EFFECTS.ALLOW) capabilities.assertGrantable(capability, grant.scope_type, grant.scope_ref);
    else if (capabilities.isCeiling(capability)) throw new Error(
        `${capability} needs no deny. ${capabilities.CEILING[capability]}`);

    const isElevation = !grant.source_role;
    if (isElevation && effect == EFFECTS.ALLOW) {
        if (!grant.valid_to) throw new Error(
            `A direct grant of ${capability} is an elevation and must be time-boxed at grant. Supply valid_to.`);
        if (!grant.reason) throw new Error(
            `A direct grant of ${capability} is an elevation and must carry a reason at grant.`);
    }

    const row = {grant_id: grant.grant_id || serverutils.generateUUID(false), org_id, person_id, capability,
        scope_type: grant.scope_type, scope_ref: grant.scope_ref || null, effect,
        granted_by: grant.granted_by || null, reason: grant.reason || null,
        valid_from: grant.valid_from || _today(), valid_to: grant.valid_to || null,
        source_role: grant.source_role || null};

    await _run(
        `INSERT INTO capability_grant (grant_id, org_id, person_id, capability, scope_type, scope_ref,
            effect, granted_by, reason, valid_from, valid_to, source_role) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.grant_id, row.org_id, row.person_id, row.capability, row.scope_type, row.scope_ref,
            row.effect, row.granted_by, row.reason, row.valid_from, row.valid_to, row.source_role], exec);

    LOG.info(`Granted ${capability} at ${row.scope_type} to ${person_id} in ${org_id}${row.valid_to?`, expiring ${row.valid_to}`:""}.`);
    return row;
}

/**
 * Revokes a grant by closing it, never by deleting it. Grants are versioned, so
 * an access review in September can still see what was in force in March.
 * @param {string} grant_id The grant
 * @param {object} options {revoked_by, asOf}
 */
exports.revokeAsync = async function(grant_id, options={}) {
    const asOf = options.asOf || _today();
    await dblayer.runCmdOrThrow(
        "UPDATE capability_grant SET revoked_at=?, valid_to=COALESCE(valid_to, ?) WHERE grant_id=? AND revoked_at IS NULL",
        [_now(), asOf, grant_id]);
    LOG.info(`Revoked grant ${grant_id}${options.revoked_by?` by ${options.revoked_by}`:""}.`);
}

/**
 * The set that H4 pins into an audit entry. Serialisable and stable, so that "who
 * could see this in March" is answered from the entry rather than from today's grants.
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} asOf ISO date
 * @returns An ordered array of grant summaries
 */
exports.effectivePermissionsAsync = async function(org_id, person_id, asOf=_today(), exec) {
    const grants = await exports.activeGrantsAsync(org_id, person_id, {asOf}, exec);
    return grants.map(_summarise).sort((a, b) =>
        `${a.capability}${a.scope_type}${a.scope_ref||""}`.localeCompare(`${b.capability}${b.scope_type}${b.scope_ref||""}`));
}

/**
 * The reverse lookup. L2 calls this a first-class view, because nobody can review a
 * permission model they can only read column by column.
 * @param {string} org_id The org
 * @param {string} capability The capability
 * @param {object} options {subject_person_id, asOf}
 * @returns Everyone who currently holds it, and through which grant
 */
exports.whoCanAsync = async function(org_id, capability, options={}) {
    const asOf = options.asOf || _today();
    if (capabilities.isCeiling(capability)) return [];   // nobody, structurally

    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM capability_grant WHERE org_id=? AND capability=? AND effect='allow' AND revoked_at IS NULL
            AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`, [org_id, capability, asOf, asOf]);

    const holders = [];
    for (const grant of rows) {
        if (options.subject_person_id) {    // only those whose scope actually covers this person
            const cover = await _scopeCoversAsync(grant, {org_id, actor_person_id: grant.person_id,
                subject_person_id: options.subject_person_id, asOf, context: {}});
            if (!cover.covers) continue;
        }
        holders.push({person_id: grant.person_id, through: _summarise(grant)});
    }
    return holders;
}

/**
 * Counts who else would still hold org-admin capability if this person lost it.
 * Admin is defined by what it can do rather than by a role name, so a custom role
 * conferring the same capability counts.
 * @param {string} org_id The org
 * @param {string} excluding_person_id The person being removed
 * @returns The number of other people holding capability.grant at org scope
 */
exports.countAdminsExcludingAsync = async function(org_id, excluding_person_id) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT DISTINCT person_id FROM capability_grant WHERE org_id=? AND capability='capability.grant'
            AND scope_type='org' AND effect='allow' AND revoked_at IS NULL
            AND (valid_to IS NULL OR valid_to > ?) AND person_id != ?`,
        [org_id, _today(), excluding_person_id]);
    return rows.length;
}

// ---------------------------------------------------------------------------
// roles as named bundles
// ---------------------------------------------------------------------------

/**
 * Seeds the five built-in roles for an org. Idempotent.
 * @param {string} org_id The org
 * @param {object} exec Optional transaction executor
 * @returns The roles, by name
 */
exports.ensureBuiltinRolesAsync = async function(org_id, exec) {
    const roles = {};
    for (const [name, definition] of Object.entries(capabilities.BUILTIN_ROLES)) {
        const existing = await _query("SELECT * FROM role WHERE org_id=? AND name=?", [org_id, name], exec);
        if (existing.length) {roles[name] = existing[0]; continue;}

        const role = {role_id: serverutils.generateUUID(false), org_id, name,
            description: definition.label, is_builtin: 1, created_at: _now(), created_by: "system"};
        const cmdObjs = [{cmd: `INSERT INTO role (role_id, org_id, name, description, is_builtin, created_at, created_by)
            VALUES (?,?,?,?,?,?,?)`, params: [role.role_id, org_id, name, role.description, 1, role.created_at, "system"]}];
        for (const [capability, scope_type, scope_ref] of definition.capabilities) {
            capabilities.assertGrantable(capability, scope_type, scope_ref);
            cmdObjs.push({cmd: `INSERT INTO role_capability (role_capability_id, org_id, role_id, capability,
                scope_type, scope_ref, effect, created_at) VALUES (?,?,?,?,?,?,?,?)`,
                params: [serverutils.generateUUID(false), org_id, role.role_id, capability, scope_type,
                    scope_ref || null, EFFECTS.ALLOW, _now()]});
        }
        if (exec) for (const cmdObj of cmdObjs) await exec.runCmd(cmdObj.cmd, cmdObj.params);
        else await dblayer.runTransactionOrThrow(cmdObjs);
        roles[name] = role;
    }
    return roles;
}

/**
 * @param {string} org_id The org
 * @param {string} name The role name
 * @param {object} exec Optional transaction executor
 * @returns {object} {role, capabilities} or null
 */
exports.getRoleAsync = async function(org_id, name, exec) {
    const rows = await _query("SELECT * FROM role WHERE org_id=? AND name=?", [org_id, name], exec);
    if (!rows.length) return null;
    const caps = await _query("SELECT * FROM role_capability WHERE role_id=?", [rows[0].role_id], exec);
    return {role: rows[0], capabilities: caps};
}

/**
 * Assigns a role by materialising its bundle as grants. The grants carry
 * source_role, so an access review can tell a role-derived grant from an elevation.
 *
 * Assigning a second role is a union of capabilities — a lead who is also an
 * interviewer holds both bundles rather than choosing between them.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} roleName The role
 * @param {object} options {granted_by, valid_from, valid_to}
 * @param {object} exec Optional transaction executor
 * @returns The grants created
 */
exports.assignRoleAsync = async function(org_id, person_id, roleName, options={}, exec) {
    const found = await exports.getRoleAsync(org_id, roleName, exec);
    if (!found) throw new Error(`No role named ${roleName} in org ${org_id}.`);

    const created = [];
    for (const rc of found.capabilities) created.push(await exports.grantAsync({org_id, person_id,
        capability: rc.capability, scope_type: rc.scope_type, scope_ref: rc.scope_ref, effect: rc.effect,
        granted_by: options.granted_by, valid_from: options.valid_from, valid_to: options.valid_to,
        source_role: roleName}, exec));

    LOG.info(`Assigned role ${roleName} to ${person_id} in ${org_id} as ${created.length} grants.`);
    return created;
}

/**
 * Creates a custom role by composing capabilities. Never by cloning an existing
 * role — a clone inherits a grant nobody remembers reviewing.
 *
 * Returns a warning rather than refusing when the new role overlaps an existing one
 * heavily, because that is usually a scope problem rather than a role problem.
 *
 * @param {string} org_id The org
 * @param {object} definition {name, description, capabilities: [[capability, scope_type, scope_ref?], ...]}
 * @param {object} options {created_by}
 * @returns {object} {role, warnings}
 */
exports.createCustomRoleAsync = async function(org_id, definition, options={}) {
    if (!definition?.name) throw new Error("A role needs a name.");
    if (!definition.capabilities?.length) throw new Error(
        "A role is composed from capabilities. Select at least one rather than cloning an existing role.");

    for (const [capability, scope_type, scope_ref] of definition.capabilities)
        capabilities.assertGrantable(capability, scope_type, scope_ref);

    const warnings = [];
    const newSet = new Set(definition.capabilities.map(([c, s, r]) => `${c}|${s}|${r||""}`));
    const existingRoles = await dblayer.getQueryOrThrow("SELECT * FROM role WHERE org_id=?", [org_id]);
    for (const existing of existingRoles) {
        const caps = await dblayer.getQueryOrThrow("SELECT * FROM role_capability WHERE role_id=?", [existing.role_id]);
        if (!caps.length) continue;
        const existingSet = new Set(caps.map(c => `${c.capability}|${c.scope_type}|${c.scope_ref||""}`));
        const shared = [...newSet].filter(k => existingSet.has(k)).length;
        const overlap = shared / Math.max(newSet.size, existingSet.size);
        if (overlap > 0.9) warnings.push(
            `${Math.round(overlap*100)}% of this role overlaps the existing role "${existing.name}". That is usually a scope problem rather than a role problem.`);
    }

    const role = {role_id: serverutils.generateUUID(false), org_id, name: definition.name,
        description: definition.description || null, is_builtin: 0, created_at: _now(),
        created_by: options.created_by || null};
    const cmdObjs = [{cmd: `INSERT INTO role (role_id, org_id, name, description, is_builtin, created_at, created_by)
        VALUES (?,?,?,?,?,?,?)`, params: [role.role_id, org_id, role.name, role.description, 0, role.created_at, role.created_by]}];
    for (const [capability, scope_type, scope_ref] of definition.capabilities)
        cmdObjs.push({cmd: `INSERT INTO role_capability (role_capability_id, org_id, role_id, capability,
            scope_type, scope_ref, effect, created_at) VALUES (?,?,?,?,?,?,?,?)`,
            params: [serverutils.generateUUID(false), org_id, role.role_id, capability, scope_type,
                scope_ref || null, EFFECTS.ALLOW, _now()]});

    await dblayer.runTransactionOrThrow(cmdObjs);
    for (const warning of warnings) LOG.warn(`Custom role ${role.name} in ${org_id}: ${warning}`);
    return {role, warnings};
}

/**
 * The quarterly access review. Every grant outside the built-in roles, with its
 * owner and last-used date; anything unused past the threshold is proposed for removal.
 * @param {string} org_id The org
 * @param {object} options {unused_days}
 * @returns The grants to review
 */
exports.accessReviewAsync = async function(org_id, options={}) {
    const unusedDays = options.unused_days || 90;
    const cutoff = _now() - (unusedDays * 86400);
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM capability_grant WHERE org_id=? AND revoked_at IS NULL AND source_role IS NULL
            ORDER BY capability`, [org_id]);

    return rows.map(grant => ({...(_summarise(grant)), person_id: grant.person_id,
        granted_by: grant.granted_by, reason: grant.reason, last_used_at: grant.last_used_at,
        propose_removal: (grant.last_used_at || 0) < cutoff,
        why: (grant.last_used_at || 0) < cutoff ?
            `Unused for more than ${unusedDays} days.` : "In use."}));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const _summarise = grant => ({grant_id: grant.grant_id, capability: grant.capability,
    scope_type: grant.scope_type, scope_ref: grant.scope_ref, effect: grant.effect,
    source_role: grant.source_role, valid_from: grant.valid_from, valid_to: grant.valid_to});

/** Best-effort, throttled, and never allowed to affect the decision it follows. */
function _stampLastUsed(grant) {
    const now = _now();
    if (grant.last_used_at && ((now - grant.last_used_at) < LAST_USED_STAMP_INTERVAL)) return;
    grant.last_used_at = now;
    dblayer.runCmdBestEffortAsync("UPDATE capability_grant SET last_used_at=? WHERE grant_id=?", [now, grant.grant_id])
        .then(ok => {if (!ok) LOG.warn(`Could not stamp last_used_at on grant ${grant.grant_id}; the access review may under-report use.`)})
        .catch(err => LOG.warn(`Could not stamp last_used_at on grant ${grant.grant_id}: ${err}`));
}

async function _describeWhoCanAsync(org_id, capability, subject_person_id, asOf, excluding_person_id) {
    try {
        const holders = await exports.whoCanAsync(org_id, capability, {subject_person_id, asOf});
        const others = holders.filter(h => h.person_id != excluding_person_id);
        if (!others.length) return `Nobody currently holds ${capability} at a scope covering this. An org admin can grant it.`;
        return `${others.length} person(s) hold ${capability} at a covering scope: ${others.slice(0, 5).map(h => h.person_id).join(", ")}${others.length > 5 ? ", …" : ""}.`;
    } catch (err) {LOG.error(`Could not resolve who can ${capability} in ${org_id}: ${err}`); return null;}
}

exports.OUTCOMES = OUTCOMES;
