/**
 * L2 — the permissions screen. Every function here is a thin wrapper
 * around `permissions.js`/`capabilities.js`, which have existed and been
 * exercised since the first feature this session touched — the engine was
 * never the gap, a screen for it was. Two genuinely new things: one query
 * (`rolesAsync` — nothing previously listed every role for an org) and one
 * capability (`role.create` — nothing previously named "compose a new
 * custom role" as its own grantable action).
 *
 * `permissions.revokeAsync` and `permissions.createCustomRoleAsync` don't
 * accept a transaction `exec` (unlike `grantAsync`/`assignRoleAsync`,
 * which both do — `createCustomRoleAsync` runs its own internal
 * transaction). Wrapping either inside `audit.performAsync`'s transaction
 * would be the same self-deadlock class already hit and fixed once this
 * session (every `dblayer` accessor is one serial queue; a plain call from
 * inside a transaction's callback queues behind the transaction holding
 * it, which can never then finish). For those two, the pattern is:
 * `permissions.requireAsync` first, run the plain self-transacting call,
 * then `audit.writeAsync` — the tool `audit.js`'s own docstring names for
 * exactly this ("a sensitive action already performed, needs its own
 * entry", as opposed to `performAsync` coupling the two as one unit).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);

const _today = _ => new Date().toISOString().substring(0, 10);

/** Reading the matrix/roles/elevations is admin-facing throughout — same gate as shell.js's `permissions` surface. */
async function _requireReadAsync(org_id, actor_person_id, what) {
    const grantGrants = await permissions.activeGrantsAsync(org_id, actor_person_id, {capability: "role.assign"});
    if (grantGrants.length) return;
    const capGrants = await permissions.activeGrantsAsync(org_id, actor_person_id, {capability: "capability.grant"});
    if (capGrants.length) return;
    throw new Error(`role.assign or capability.grant is required to ${what}.`);
}

async function _namesAsync(org_id) {
    return Object.fromEntries((await spine.rosterAsOfAsync(org_id)).map(row => [row.person_id, row.display_name || row.person_id]));
}

// ---------------------------------------------------------------------------
// static reference data — never re-derived, so it can't drift from the engine
// ---------------------------------------------------------------------------

exports.catalogueAsync = async function(org_id, actor_person_id) {
    await _requireReadAsync(org_id, actor_person_id, "read the capability catalogue");
    return {catalogue: capabilities.CATALOGUE, ceiling: capabilities.CEILING, scopes: capabilities.SCOPES,
        builtin_roles: capabilities.BUILTIN_ROLES, sod_rules: Object.fromEntries(
            Object.entries(capabilities.SOD_RULES).map(([id, rule]) => [id, {label: rule.label,
                applies_to: rule.applies_to, explain: rule.explain, who_can: rule.who_can}]))};
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

/** Every role for the org — built-in and custom — with its capabilities and how many people hold it. */
exports.rolesAsync = async function(org_id, actor_person_id) {
    await _requireReadAsync(org_id, actor_person_id, "read roles");
    const roles = await dblayer.getQueryOrThrow("SELECT * FROM role WHERE org_id=? ORDER BY is_builtin DESC, name ASC", [org_id]);
    const result = [];
    for (const role of roles) {
        const caps = await dblayer.getQueryOrThrow("SELECT * FROM role_capability WHERE role_id=?", [role.role_id]);
        const holders = await dblayer.getQueryOrThrow(
            "SELECT COUNT(DISTINCT person_id) AS c FROM capability_grant WHERE org_id=? AND source_role=? AND revoked_at IS NULL",
            [org_id, role.name]);
        result.push({...role, capabilities: caps.map(c => ({capability: c.capability, scope_type: c.scope_type,
            scope_ref: c.scope_ref, effect: c.effect})), holder_count: holders[0].c});
    }
    return {roles: result};
}

/** @param {object} request {org_id, actor_person_id, name, description, capabilities: [[capability, scope_type, scope_ref?]]} */
exports.createRoleAsync = async function(request) {
    await permissions.requireAsync({org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "role.create"});
    const result = await permissions.createCustomRoleAsync(request.org_id,
        {name: request.name, description: request.description, capabilities: request.capabilities},
        {created_by: request.actor_person_id});
    await audit.writeAsync({org_id: request.org_id, action: "role.created", object_type: "role",
        object_ref: result.role.role_id, actor_person_id: request.actor_person_id,
        detail: {name: result.role.name, capability_count: request.capabilities.length, warnings: result.warnings}});
    return result;
}

/** @param {object} request {org_id, actor_person_id, person_id, role_name, valid_from, valid_to} */
exports.assignRoleAsync = async function(request) {
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "role.assign",
        subject_person_id: request.person_id,
        audit: {action: "role.assigned", object_type: "person", object_ref: request.person_id,
            subject_person_id: request.person_id, detail: {role: request.role_name}},
        action: async exec => await permissions.assignRoleAsync(request.org_id, request.person_id, request.role_name,
            {granted_by: request.actor_person_id, valid_from: request.valid_from, valid_to: request.valid_to}, exec)});
}

// ---------------------------------------------------------------------------
// elevation and the quarterly review — the same dataset, one list
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, person_id, capability, scope_type, scope_ref, valid_to, reason} */
exports.grantElevationAsync = async function(request) {
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "capability.grant",
        subject_person_id: request.person_id, reason: request.reason,
        audit: {action: "capability.granted", object_type: "person", object_ref: request.person_id,
            subject_person_id: request.person_id, reason: request.reason,
            detail: {capability: request.capability, scope_type: request.scope_type, scope_ref: request.scope_ref,
                valid_to: request.valid_to}},
        action: async exec => await permissions.grantAsync({org_id: request.org_id, person_id: request.person_id,
            capability: request.capability, scope_type: request.scope_type, scope_ref: request.scope_ref,
            granted_by: request.actor_person_id, reason: request.reason, valid_from: request.valid_from,
            valid_to: request.valid_to}, exec)});
}

/** @param {object} request {org_id, actor_person_id, grant_id} */
exports.revokeGrantAsync = async function(request) {
    const target = (await dblayer.getQueryOrThrow("SELECT * FROM capability_grant WHERE org_id=? AND grant_id=?",
        [request.org_id, request.grant_id]))[0];
    if (!target) throw new Error(`No grant ${request.grant_id}.`);
    // subject_person_id must be the grant's own owner, not omitted — sod.self_role_change
    // (applies_to includes capability.revoke) compares actor to subject to catch
    // someone revoking their own capability; passing no subject would silently
    // never fire that rule at all.
    await permissions.requireAsync({org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "capability.revoke", subject_person_id: target.person_id,
        context: {removes_admin_from: target.capability == "capability.grant" && target.scope_type == "org" ?
            target.person_id : undefined}});
    await permissions.revokeAsync(request.grant_id, {revoked_by: request.actor_person_id});
    await audit.writeAsync({org_id: request.org_id, action: "capability.revoked", object_type: "capability_grant",
        object_ref: request.grant_id, subject_person_id: target.person_id, actor_person_id: request.actor_person_id,
        detail: {capability: target.capability, scope_type: target.scope_type}});
    return "revoked";
}

/** The quarterly access review — every non-role-derived grant, with names and the propose-removal flag. */
exports.accessReviewAsync = async function(org_id, actor_person_id, options={}) {
    await _requireReadAsync(org_id, actor_person_id, "read the access review");
    const grants = await permissions.accessReviewAsync(org_id, options);
    const names = await _namesAsync(org_id);
    return {grants: grants.map(g => ({...g, person_name: names[g.person_id] || g.person_id,
        granted_by_name: names[g.granted_by] || g.granted_by || null}))};
}

// ---------------------------------------------------------------------------
// the reverse lookup, and one person's own grants
// ---------------------------------------------------------------------------

/** "Who can do this?" — the reverse query L2 calls a first-class view. */
exports.whoCanAsync = async function(org_id, actor_person_id, capability, subject_person_id) {
    await _requireReadAsync(org_id, actor_person_id, "look up who holds a capability");
    const holders = await permissions.whoCanAsync(org_id, capability, {subject_person_id});
    const names = await _namesAsync(org_id);
    return {holders: holders.map(h => ({...h, name: names[h.person_id] || h.person_id}))};
}

/** One person's full effective grant list — the matrix drilled into one row. */
exports.personGrantsAsync = async function(org_id, actor_person_id, subject_person_id) {
    await _requireReadAsync(org_id, actor_person_id, "read another person's grants");
    return {grants: await permissions.effectivePermissionsAsync(org_id, subject_person_id, _today())};
}
