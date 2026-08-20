/**
 * The L2 capability catalogue, the ceiling, the built-in bundles and the
 * separation-of-duties rules.
 *
 * The unit is capability x scope. Roles are named bundles over that, because a
 * product that only has roles grows one role per person by month nine.
 *
 * Two things here are deliberately not configuration:
 *
 *   The ceiling. A capability in CEILING has no grant path, no role, no admin
 *   override. It is absent from the catalogue rather than present and unticked,
 *   because an unticked box is an invitation to tick it.
 *
 *   The separation-of-duties rules. They live in the engine and name themselves
 *   when they fire, so a blocked action can say which rule blocked it and who can
 *   do it instead. A dead end with no name attached just generates a ticket.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

/** Scope is a first-class axis. A capability without a scope is not a valid grant. */
const SCOPES = Object.freeze({
    SELF: "self",
    DIRECT_REPORTS: "direct_reports",
    REPORTING_LINE: "reporting_line",
    TEAM: "team",
    PROJECT: "project",
    LOCATION: "location",
    JURISDICTION: "jurisdiction",
    ORG: "org"
});

/** Scopes that name a particular thing, and so require a scope_ref. */
const SCOPES_NEEDING_REF = Object.freeze([SCOPES.TEAM, SCOPES.PROJECT, SCOPES.LOCATION, SCOPES.JURISDICTION]);

const EFFECTS = Object.freeze({ALLOW: "allow", DENY: "deny"});

/**
 * Structurally impossible. Not a row anyone can tick.
 *
 * The first entry is the product promise H3 makes in plain language and L2 gives a
 * mechanism, so it survives the first customer who asks for an exception. The rest
 * are the never-measured list — they are here so the prohibition has a runtime name
 * that refuses, rather than only a sentence in a document.
 */
const CEILING = Object.freeze({
    "activity.read_minute_level": "No one may read another person's minute-level activity. There is no grant path, no role and no admin override.",
    "keystrokes.read": "Keystrokes are never measured.",
    "screen.read": "Screen contents are never captured.",
    "camera.observe": "Camera and attention are never observed.",
    "sentiment.analyse": "Sentiment and tone are never analysed.",
    "message.read_content": "Message content is never read by the product.",
    "health.read": "Health and wearable data are never collected.",
    "session.proctor": "Proctoring of any kind is never performed."
});

/**
 * Every capability the product can grant. Anything absent is not grantable, which
 * is what makes the ceiling a structure rather than a policy.
 *
 *   scopes            the scope types this capability may be granted at
 *   action_requires_reason  the action must carry a reason, which H4 records
 *   step_up           re-authentication before the action
 *   always_audited    an audit entry is mandatory; the action fails without one
 *   irreversible      A8 refuses this outright if a pre-check is unavailable
 */
const CATALOGUE = Object.freeze({
    "time.read_own": {label: "Read own time entries", scopes: [SCOPES.SELF]},
    "timesheet.read": {label: "Read a timesheet", scopes: [SCOPES.SELF, SCOPES.DIRECT_REPORTS, SCOPES.REPORTING_LINE, SCOPES.TEAM, SCOPES.ORG]},
    "timesheet.approve": {label: "Approve a timesheet", scopes: [SCOPES.DIRECT_REPORTS, SCOPES.REPORTING_LINE, SCOPES.TEAM], always_audited: true},
    "time_entry.edit_other": {label: "Edit someone else's time entry", scopes: [SCOPES.DIRECT_REPORTS, SCOPES.ORG],
        action_requires_reason: true, always_audited: true},
    "leave.request": {label: "Request leave", scopes: [SCOPES.SELF]},
    "leave.approve": {label: "Approve a leave request", scopes: [SCOPES.DIRECT_REPORTS, SCOPES.REPORTING_LINE, SCOPES.TEAM, SCOPES.ORG], always_audited: true},
    "leave_policy.publish": {label: "Publish a leave policy version", scopes: [SCOPES.JURISDICTION, SCOPES.ORG],
        step_up: true, always_audited: true},
    "requisition.approve": {label: "Approve a requisition", scopes: [SCOPES.ORG, SCOPES.TEAM], always_audited: true},
    "candidate.read": {label: "Read candidate records", scopes: [SCOPES.TEAM, SCOPES.ORG]},
    "person_data.export": {label: "Export another person's data", scopes: [SCOPES.DIRECT_REPORTS, SCOPES.REPORTING_LINE, SCOPES.ORG],
        step_up: true, always_audited: true},
    "wiki.publish_public": {label: "Publish a wiki page to the internet", scopes: [SCOPES.TEAM, SCOPES.ORG],
        step_up: true, always_audited: true, irreversible: true},
    "user.impersonate": {label: "Impersonate a user", scopes: [SCOPES.ORG],
        step_up: true, always_audited: true, action_requires_reason: true},
    "role.assign": {label: "Assign a role", scopes: [SCOPES.ORG], always_audited: true},
    "capability.grant": {label: "Grant a capability", scopes: [SCOPES.ORG], always_audited: true, action_requires_reason: true},
    "capability.revoke": {label: "Revoke a capability", scopes: [SCOPES.ORG], always_audited: true},
    "audit.read_own": {label: "Read audit entries about yourself", scopes: [SCOPES.SELF]},
    "audit.read_all": {label: "Read the whole audit log", scopes: [SCOPES.ORG]},
    "audit.read_policy": {label: "Read compliance and policy audit entries", scopes: [SCOPES.ORG]},
    "wellbeing.read_own": {label: "Read your own load", scopes: [SCOPES.SELF]},
    "wellbeing.read_aggregate": {label: "Read team load as an aggregate", scopes: [SCOPES.DIRECT_REPORTS, SCOPES.TEAM, SCOPES.ORG]},

    // tasks (D1/D2) — collaboration objects, org-wide reads
    "task.create": {label: "Create tasks", scopes: [SCOPES.ORG]},
    "task.read": {label: "Read tasks", scopes: [SCOPES.ORG]},
    "task.edit": {label: "Edit task fields", scopes: [SCOPES.ORG]},
    "task.assign": {label: "Assign or reassign a task", scopes: [SCOPES.ORG], always_audited: true},
    "task.delete": {label: "Delete a task", scopes: [SCOPES.ORG], always_audited: true}
});

/**
 * The five built-in roles from L2, as capability x scope bundles.
 *
 * Note what is absent. No role holds activity.read_minute_level, because no role
 * can — it is not in the catalogue to be listed.
 */
const BUILTIN_ROLES = Object.freeze({
    employee: {label: "Employee", capabilities: [
        ["time.read_own", SCOPES.SELF], ["timesheet.read", SCOPES.SELF], ["leave.request", SCOPES.SELF],
        ["audit.read_own", SCOPES.SELF], ["wellbeing.read_own", SCOPES.SELF],
        ["task.create", SCOPES.ORG], ["task.read", SCOPES.ORG], ["task.edit", SCOPES.ORG], ["task.assign", SCOPES.ORG]]},
    lead: {label: "Team lead", capabilities: [
        ["time.read_own", SCOPES.SELF], ["timesheet.read", SCOPES.DIRECT_REPORTS], ["timesheet.approve", SCOPES.DIRECT_REPORTS],
        ["leave.request", SCOPES.SELF], ["leave.approve", SCOPES.DIRECT_REPORTS],
        ["person_data.export", SCOPES.DIRECT_REPORTS], ["wellbeing.read_aggregate", SCOPES.DIRECT_REPORTS],
        ["audit.read_own", SCOPES.SELF], ["wellbeing.read_own", SCOPES.SELF],
        ["task.create", SCOPES.ORG], ["task.read", SCOPES.ORG], ["task.edit", SCOPES.ORG], ["task.assign", SCOPES.ORG]]},
    hr: {label: "HR", capabilities: [
        ["time.read_own", SCOPES.SELF], ["timesheet.read", SCOPES.ORG], ["timesheet.approve", SCOPES.DIRECT_REPORTS],
        ["time_entry.edit_other", SCOPES.ORG], ["leave.request", SCOPES.SELF], ["leave.approve", SCOPES.DIRECT_REPORTS],
        ["leave_policy.publish", SCOPES.ORG], ["candidate.read", SCOPES.ORG], ["person_data.export", SCOPES.ORG],
        ["wellbeing.read_aggregate", SCOPES.ORG], ["audit.read_own", SCOPES.SELF], ["audit.read_policy", SCOPES.ORG],
        ["wellbeing.read_own", SCOPES.SELF],
        ["task.create", SCOPES.ORG], ["task.read", SCOPES.ORG], ["task.edit", SCOPES.ORG], ["task.assign", SCOPES.ORG]]},
    admin: {label: "Org admin", capabilities: [
        ["time.read_own", SCOPES.SELF], ["leave.request", SCOPES.SELF], ["role.assign", SCOPES.ORG],
        ["capability.grant", SCOPES.ORG], ["capability.revoke", SCOPES.ORG], ["audit.read_all", SCOPES.ORG],
        ["audit.read_own", SCOPES.SELF], ["person_data.export", SCOPES.ORG], ["user.impersonate", SCOPES.ORG],
        ["wiki.publish_public", SCOPES.ORG], ["wellbeing.read_own", SCOPES.SELF],
        ["task.create", SCOPES.ORG], ["task.read", SCOPES.ORG], ["task.edit", SCOPES.ORG], ["task.assign", SCOPES.ORG], ["task.delete", SCOPES.ORG]]},
    guest: {label: "Guest", capabilities: [["audit.read_own", SCOPES.SELF]]}
});

/**
 * Separation-of-duties rules. Each names itself when it fires and says who can do
 * the action instead, because a block with no name attached is a support ticket.
 *
 * A rule may be async — sod.last_org_admin has to count what is left.
 */
const SOD_RULES = Object.freeze({
    "sod.self_approval": {
        label: "Self-approval",
        applies_to: ["timesheet.approve", "leave.approve", "requisition.approve"],
        blocks: async ctx => ctx.actor_person_id && (ctx.actor_person_id == ctx.subject_person_id),
        explain: "You cannot approve your own timesheet, leave or requisition.",
        who_can: "Your approver on the employment record in force, or anyone holding this capability at a wider scope."
    },
    "sod.self_role_change": {
        label: "Self role change",
        applies_to: ["role.assign", "capability.grant", "capability.revoke"],
        blocks: async ctx => ctx.actor_person_id && (ctx.actor_person_id == ctx.subject_person_id),
        explain: "You cannot change your own role or capabilities.",
        who_can: "Another org admin."
    },
    "sod.delegate_and_requester": {
        label: "Delegate approving their own request",
        applies_to: ["leave.approve", "timesheet.approve"],
        blocks: async ctx => Boolean(ctx.context?.delegated_for) && (ctx.context.delegated_for == ctx.actor_person_id),
        explain: "You cannot approve a request as the delegate for yourself.",
        who_can: "The original approver, or another delegate."
    },
    "sod.last_org_admin": {
        label: "Removing the last org admin",
        applies_to: ["capability.revoke", "role.assign"],
        blocks: async (ctx, deps) => {
            if (!ctx.context?.removes_admin_from) return false;
            const remaining = await deps.countAdminsExcludingAsync(ctx.org_id, ctx.context.removes_admin_from);
            return remaining < 1;
        },
        explain: "An org must keep at least one org admin.",
        who_can: "Assign another org admin first, then retry."
    }
});

exports.SCOPES = SCOPES;
exports.SCOPES_NEEDING_REF = SCOPES_NEEDING_REF;
exports.EFFECTS = EFFECTS;
exports.CEILING = CEILING;
exports.CATALOGUE = CATALOGUE;
exports.BUILTIN_ROLES = BUILTIN_ROLES;
exports.SOD_RULES = SOD_RULES;

/**
 * @param {string} capability The capability name
 * @returns true if the capability can never be granted to anyone
 */
exports.isCeiling = capability => Object.keys(CEILING).includes(capability);

/**
 * @param {string} capability The capability name
 * @returns The catalogue entry, or undefined
 */
exports.definitionOf = capability => CATALOGUE[capability];

/**
 * Validates a capability and scope as a grantable pair.
 * @param {string} capability The capability name
 * @param {string} scope_type The scope type
 * @param {string} scope_ref The scope reference, where the scope type needs one
 * @throws If the pair could never be a valid grant
 */
exports.assertGrantable = function(capability, scope_type, scope_ref) {
    if (exports.isCeiling(capability)) throw new Error(
        `${capability} cannot be granted. ${CEILING[capability]}`);

    const definition = CATALOGUE[capability];
    if (!definition) throw new Error(
        `${capability} is not in the capability catalogue, so it cannot be granted. Add it to the catalogue deliberately or correct the name.`);

    if (!scope_type) throw new Error(
        `${capability} needs a scope. A capability with no scope is not a valid grant.`);

    if (!Object.values(SCOPES).includes(scope_type)) throw new Error(`${scope_type} is not a known scope type.`);

    if (!definition.scopes.includes(scope_type)) throw new Error(
        `${capability} cannot be granted at scope ${scope_type}. It allows: ${definition.scopes.join(", ")}.`);

    if (SCOPES_NEEDING_REF.includes(scope_type) && !scope_ref) throw new Error(
        `Scope ${scope_type} names a particular thing, so it needs a scope_ref.`);
}

/**
 * Guard for the action site, not the grant site. H4 records the reason on a time
 * edit or an impersonation, and the action is not permitted without one.
 * @param {string} capability The capability being exercised
 * @param {string} reason The reason supplied with the action
 * @throws If this capability's actions require a reason and none was given
 */
exports.assertActionReason = function(capability, reason) {
    const definition = CATALOGUE[capability];
    if (definition?.action_requires_reason && !reason) throw new Error(
        `${capability} requires a reason on the action. It is recorded in the audit entry.`);
}
