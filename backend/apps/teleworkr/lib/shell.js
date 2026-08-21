/**
 * A7 — the role projection behind the A2 shell.
 *
 * There is one screen set. What a person sees is a projection over their
 * capability x scope grants, computed here on the server, and the UI reflects it.
 * A nav array stored against a role would be a role fork by another name: two
 * copies of Tasks that drift apart by the second release.
 *
 * Nothing here is stored. The projection is recomputed on each read, for the same
 * reason overlap and leave balance are (A6) — a cached menu is wrong the moment a
 * grant expires, and a person keeps seeing a tab that no longer opens.
 *
 * One thing this module is not: authorization. Nav visibility answers "does this
 * person hold this capability at some scope", which is the right question for
 * whether to draw a tab. Every action behind the tab still goes through
 * permissions.checkAsync against its actual target. Hiding is a courtesy; the
 * refusal is the control.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);

/**
 * A7 classifies every screen, because the classification decides where the gating
 * logic lives rather than being a description after the fact.
 *
 *   shared     every signed-in person with an employment in force reaches it
 *   gated      reached by holding a capability; the region inside may narrow further
 *   exclusive  meaningless to other roles and correctly absent from their build
 */
const CLASS = Object.freeze({SHARED: "shared", GATED: "gated", EXCLUSIVE: "exclusive"});

/**
 * A1 fixes five tabs: Day, Tasks, Calendar, Timeline, Team. A2 freezes them into
 * the header. Everything else in the IA — leave, the consoles, Me — is reachable
 * but is not a tab, so each surface declares which it is.
 *
 * A surface with a tab appears in the header tab bar. A surface with a console
 * appears in that console's menu. A nav entry pointing at a screen nobody built is
 * worse than no entry, so this catalogue tracks what is actually implemented and
 * grows as screens land.
 *
 * capability / any_of name what must be held. A surface with neither is shared.
 */
const TABS = Object.freeze(["day", "tasks", "calendar", "timeline", "team"]);
const SURFACES = Object.freeze({
    // the five tabs A2 freezes into the header
    day:       {tab: "day",      label: "Day",       screen: "C1", order: 10, classification: CLASS.SHARED},
    tasks:     {tab: "tasks",    label: "Tasks",     screen: "D1", order: 20, classification: CLASS.GATED,
        capability: "task.read"},
    calendar:  {tab: "calendar", label: "Calendar",  screen: "E1", order: 30, classification: CLASS.SHARED},
    team:      {tab: "team",     label: "Team",      screen: "E3", order: 40, classification: CLASS.SHARED},
    // Timeline (D7) is the fifth tab and is not built yet, so it is absent rather
    // than present and dead. It joins here when its screen lands.

    // reachable, but not tabs
    timesheet: {console: "Me",    label: "Timesheet & Friday close", screen: "C5", order: 50, classification: CLASS.SHARED},
    me:        {console: "Me",    label: "What your manager sees",   screen: "H5", order: 60, classification: CLASS.SHARED},
    approvals: {console: "Me",    label: "Approvals",   screen: "C7", order: 70, classification: CLASS.GATED,
        any_of: ["timesheet.approve", "leave.approve"]},
    leave:     {console: "Leave", label: "My leave",    screen: "J3", order: 80, classification: CLASS.GATED,
        capability: "leave.request"},
    policy:    {console: "Leave", label: "Leave policy", screen: "J2", order: 90, classification: CLASS.EXCLUSIVE,
        capability: "leave_policy.publish"},
    runs:      {console: "Leave", label: "Scheduled runs", screen: "J7", order: 100, classification: CLASS.EXCLUSIVE,
        capability: "leave_run.operate"},
    people:    {console: "Admin", label: "People & import", screen: "B5", order: 110, classification: CLASS.EXCLUSIVE,
        capability: "people.import"},
    audit:     {console: "Admin", label: "Audit log",   screen: "H4", order: 120, classification: CLASS.EXCLUSIVE,
        any_of: ["audit.read_all", "audit.read_policy"]}
});

/**
 * Roles differ by entry point, never by screen identity. First rule whose test the
 * person passes wins, so a person holding two roles gets the widest entry point
 * rather than an ambiguous one — which is the open question A7 leaves behind the
 * union-of-capabilities answer.
 */
const HOME_RULES = Object.freeze([
    {any_of: ["people.import"], surface: "people"},
    {any_of: ["leave_policy.publish", "leave_run.operate"], surface: "leave"},
    {any_of: ["timesheet.approve", "leave.approve"], surface: "team"},
    {surface: "day"}
]);

/**
 * Fails loudly at startup if a surface names a capability that does not exist.
 * A typo here would hide a surface from every person forever, and it would look
 * exactly like a permission working correctly.
 * @throws If any surface references an unknown or ungrantable capability
 */
exports.validateCatalogueSync = function() {
    for (const [id, surface] of Object.entries(SURFACES)) {
        if (!surface.tab && !surface.console) throw new Error(
            `Surface ${id} is neither a tab nor part of a console, so nothing would ever draw it.`);
        if (surface.tab && !TABS.includes(surface.tab)) throw new Error(
            `Surface ${id} claims tab ${surface.tab}, which is not one of the five A1 fixes: ${TABS.join(", ")}.`);
        for (const capability of _requiredCapabilities(surface)) {
            if (capabilities.isCeiling(capability)) throw new Error(
                `Surface ${id} requires ${capability}, which is a ceiling capability and can never be held.`);
            if (!capabilities.definitionOf(capability)) throw new Error(
                `Surface ${id} requires ${capability}, which is not in the capability catalogue.`);
        }
    }
    return true;
}

/**
 * The whole shell projection for one person: who they are, what they can reach,
 * where they land, and what the header should say.
 *
 * @param {object} request {org_id, person_id, asOf}
 * @returns {object} The projection
 */
exports.projectAsync = async function(request) {
    const {org_id, person_id} = request;
    if (!org_id || !person_id) throw new Error("A shell projection needs an org_id and a person_id.");
    const asOf = request.asOf || new Date().toISOString().substring(0, 10);

    const person = await spine.getPersonAsync(person_id);
    if (!person) throw new Error(`No person ${person_id}.`);

    const employment = await spine.employmentAsOfAsync(org_id, person_id, asOf);
    if (!employment) return {          // signed in, but nothing is in force for them here
        person: _person(person), employment: null, capabilities: [], tabs: [], consoles: [], home: null,
        coverage: {visible: 0, total: Object.keys(SURFACES).length},
        banners: [{level: "blocked", source: "employment",
            message: "No employment is in force for you in this organisation on this date.",
            what_to_do: "Your administrator can check your start date and provisioning."}]};

    const held = await exports.heldCapabilitiesAsync(org_id, person_id, asOf);
    const heldSet = new Set(held);

    const visible = Object.entries(SURFACES)
        .filter(([_id, surface]) => _surfaceVisible(surface, heldSet))
        .sort((a, b) => a[1].order - b[1].order)
        .map(([id, surface]) => ({id, label: surface.label, tab: surface.tab||null,
            console: surface.console||null, screen: surface.screen, classification: surface.classification}));

    return {
        person: _person(person),
        employment: {status: employment.status, jurisdiction: employment.jurisdiction,
            manager_person_id: employment.manager_person_id, contract_type: employment.contract_type,
            valid_from: employment.valid_from},
        capabilities: held,
        tabs: visible.filter(surface => surface.tab),        // A2's header tab bar
        consoles: _group(visible.filter(surface => surface.console)),
        home: _home(heldSet, visible),
        // A7 publishes coverage per role so "what is this person's product" is answerable
        coverage: {visible: visible.length, total: Object.keys(SURFACES).length},
        // A2's system banner slot. Sources attach here as integrations land; an
        // empty list means nothing is degraded, never that nothing was checked.
        banners: []
    };
}

/**
 * Every capability this person holds at some scope, for the UI to reflect on gated
 * regions inside a screen. Not an authorization answer — see the module note.
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} asOf ISO date
 * @returns {array} Sorted capability names
 */
exports.heldCapabilitiesAsync = async function(org_id, person_id, asOf) {
    const grants = await permissions.activeGrantsAsync(org_id, person_id, {asOf});
    const denied = new Set(grants.filter(g => g.effect == "deny" && g.scope_type == "org")
        .map(g => g.capability));   // an org-wide deny removes the surface, not just the action
    const allowed = new Set(grants.filter(g => g.effect == "allow" && !denied.has(g.capability))
        .map(g => g.capability));
    return [...allowed].sort();
}

/**
 * @param {string} surfaceId The surface
 * @returns The surface definition, or undefined
 */
exports.surfaceOf = surfaceId => SURFACES[surfaceId];

exports.SURFACES = SURFACES;
exports.CLASS = CLASS;
exports.TABS = TABS;

// ---------------------------------------------------------------------------

const _requiredCapabilities = surface =>
    surface.any_of ? surface.any_of : (surface.capability ? [surface.capability] : []);

const _surfaceVisible = (surface, heldSet) => {
    const required = _requiredCapabilities(surface);
    if (!required.length) return true;              // shared
    return required.some(capability => heldSet.has(capability));   // any_of, and a single capability is a list of one
};

const _person = person => ({person_id: person.person_id, display_name: person.display_name,
    email: person.email, home_timezone: person.home_timezone});

function _group(visible) {
    const groups = [];
    for (const surface of visible) {
        let group = groups.find(g => g.console == surface.console);
        if (!group) {group = {console: surface.console, surfaces: []}; groups.push(group);}
        group.surfaces.push(surface);
    }
    return groups;
}

function _home(heldSet, visible) {
    const visibleIds = new Set(visible.map(s => s.id));
    for (const rule of HOME_RULES) {
        const matches = rule.any_of ? rule.any_of.some(capability => heldSet.has(capability)) : true;
        if (matches && visibleIds.has(rule.surface)) return rule.surface;
    }
    return visible.length ? visible[0].id : null;
}
