/**
 * K12 slice 3 — diversity data, collected optionally and stored apart from
 * the candidate record decision-makers see, plus the adverse-impact report
 * that's the reason it's collected at all.
 *
 * "Structurally separated" means candidate_diversity_data is never joined
 * into candidateRecordAsync/pipelineBoardAsync (K4/K5) — confirmed by this
 * file being the only one that ever reads or writes that table. The
 * aggregate report below never returns a candidate_id or a name anywhere in
 * its response, enforced by the shape, the same discipline wellbeing.js's
 * own team-load aggregate already established.
 *
 * Deliberately not dependent on recruitment.js's private `_project` engine
 * (conditional rounds, parallel groups) — candidateretention.js already
 * chose the same thing in slice 1, re-deriving a simpler signal directly
 * from raw stage_transition/offer_version rows rather than exporting engine
 * internals just to reuse them here. "Evaluated" a round is a
 * stage_transition row with kind in (advanced, rejected, held) — a
 * `skipped` row exists for a conditionally-bypassed round and must not
 * count as evaluated. "Passed" is kind == advanced. This is a statistical
 * approximation, same as the legal 4/5ths rule itself is.
 *
 * No universal ethnicity taxonomy exists across the jurisdictions this app
 * already spans (org home_jurisdiction varies freely), so gender and
 * disability_status are small controlled lists but ethnicity is free text
 * — inventing a fixed taxonomy would be presumptuous and likely wrong for
 * some org. Same "placeholder pending a legal read" framing the retention
 * day-counts already carry (K12 slice 1).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);

const MINIMUM_GROUP_SIZE = 5;
const GENDERS = Object.freeze(["woman", "man", "non_binary", "prefer_not_to_say"]);
const DISABILITY_STATUSES = Object.freeze(["yes", "no", "prefer_not_to_say"]);
const DIMENSIONS = Object.freeze(["gender", "ethnicity", "disability_status"]);
const EVALUATING_KINDS = Object.freeze(["advanced", "rejected", "held"]);
const IMPACT_RATIO_THRESHOLD = 0.8;   // the standard 4/5ths rule

const _now = _ => Math.floor(Date.now()/1000);

async function _requireAsync(org_id, actor_person_id, capability, what) {
    const decision = await permissions.checkAsync({org_id, actor_person_id, capability});
    if (!decision.allowed) throw Object.assign(new Error(`${capability} is required to ${what}.`), {decision});
}

/** Validates a portal token and touches last_used_at — the same lookup every K9 portal op in recruitment.js uses. */
async function _portalTokenRowAsync(token) {
    if (!token) throw new Error("This link is not valid.");
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM candidate_portal_link WHERE token=?", [token]);
    const link = rows[0];
    if (!link) throw new Error("This link is not valid.");
    if (link.revoked_at) throw new Error("This link has been revoked.");
    await dblayer.runCmdOrThrow("UPDATE candidate_portal_link SET last_used_at=? WHERE link_id=?", [_now(), link.link_id]);
    return link;
}

async function _candidateIdForTokenAsync(token) {
    const link = await _portalTokenRowAsync(token);
    const application = (await dblayer.getQueryOrThrow("SELECT candidate_id FROM application WHERE org_id=? AND application_id=?",
        [link.org_id, link.application_id]))[0];
    if (!application) throw new Error(`No application ${link.application_id}.`);
    return {org_id: link.org_id, candidate_id: application.candidate_id};
}

// ---------------------------------------------------------------------------
// K9 portal — self-service, optional
// ---------------------------------------------------------------------------

/** @param {string} token The portal link's token @returns {object} {gender, ethnicity, disability_status} */
exports.portalGetDiversityAsync = async function(token) {
    const {org_id, candidate_id} = await _candidateIdForTokenAsync(token);
    const row = (await dblayer.getQueryOrThrow(
        "SELECT gender, ethnicity, disability_status FROM candidate_diversity_data WHERE org_id=? AND candidate_id=?",
        [org_id, candidate_id]))[0];
    return {gender: row?.gender || null, ethnicity: row?.ethnicity || null, disability_status: row?.disability_status || null};
}

/** @param {object} request {token, gender, ethnicity, disability_status} — each independently optional */
exports.portalSetDiversityAsync = async function(request) {
    const {org_id, candidate_id} = await _candidateIdForTokenAsync(request.token);
    if (request.gender && !GENDERS.includes(request.gender)) throw new Error(`gender must be one of ${GENDERS.join(", ")}.`);
    if (request.disability_status && !DISABILITY_STATUSES.includes(request.disability_status))
        throw new Error(`disability_status must be one of ${DISABILITY_STATUSES.join(", ")}.`);

    await dblayer.runCmdOrThrow(
        `INSERT INTO candidate_diversity_data (candidate_id, org_id, gender, ethnicity, disability_status, collected_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT (candidate_id) DO UPDATE SET gender=excluded.gender, ethnicity=excluded.ethnicity,
                disability_status=excluded.disability_status, collected_at=excluded.collected_at`,
        [candidate_id, org_id, request.gender || null, request.ethnicity?.trim() || null,
            request.disability_status || null, _now()]);
    await audit.writeAsync({org_id, action: "recruitment.candidate_diversity_set", object_type: "candidate",
        object_ref: candidate_id, actor_kind: "system", detail: {via: "candidate_portal"}});
    return "recorded";
}

// ---------------------------------------------------------------------------
// HR-only adverse-impact reporting — aggregate, above a minimum group size
// ---------------------------------------------------------------------------

/**
 * Per-round pass rates and the overall selection-rate/impact-ratio, broken
 * down by one diversity dimension — never a candidate_id or a name anywhere
 * in the response, enforced by the shape.
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @param {object} request {workflow_code, dimension, from_date, to_date}
 * @returns {object} {workflow_code, dimension, rounds, overall}
 */
exports.adverseImpactAsync = async function(org_id, actor_person_id, request) {
    await _requireAsync(org_id, actor_person_id, "diversity.read_aggregate", "read adverse-impact reporting");
    if (!request?.workflow_code) throw new Error("workflow_code is required.");
    if (!DIMENSIONS.includes(request.dimension)) throw new Error(`dimension must be one of ${DIMENSIONS.join(", ")}.`);
    await audit.writeAsync({org_id, actor_person_id, actor_kind: "person", action: "diversity.aggregate_read",
        object_type: "workflow", object_ref: request.workflow_code, detail: {dimension: request.dimension}});

    const pointer = (await dblayer.getQueryOrThrow(
        "SELECT * FROM workflow_pointer WHERE org_id=? AND workflow_code=?", [org_id, request.workflow_code]))[0];
    if (!pointer) throw new Error(`No workflow ${request.workflow_code}.`);
    const version = (await dblayer.getQueryOrThrow("SELECT * FROM workflow_version WHERE workflow_version_id=?",
        [pointer.workflow_version_id]))[0];
    const rounds = JSON.parse(version.rounds).sort((a, b) => a.sequence - b.sequence);

    let dateClause = "", dateParams = [];
    if (request.from_date && request.to_date) {
        dateClause = " AND a.applied_at >= ? AND a.applied_at < ?";
        dateParams = [Date.parse(`${request.from_date}T00:00:00Z`)/1000, Date.parse(`${request.to_date}T00:00:00Z`)/1000 + 86400];
    }
    const applications = await dblayer.getQueryOrThrow(
        `SELECT a.application_id, a.candidate_id, d.${request.dimension} AS group_value
            FROM application a JOIN requisition r ON r.requisition_id = a.requisition_id
            JOIN candidate_diversity_data d ON d.candidate_id = a.candidate_id
            WHERE a.org_id=? AND r.workflow_code=? AND d.${request.dimension} IS NOT NULL${dateClause}`,
        [org_id, request.workflow_code, ...dateParams]);

    const groups = new Map();   // group_value -> {applied, evaluated: Map(round_id -> {evaluated, passed}), hired}
    for (const app of applications) {
        if (!groups.has(app.group_value)) groups.set(app.group_value, {applied: 0, byRound: new Map(), hired: 0});
        const g = groups.get(app.group_value);
        g.applied++;

        const transitions = await dblayer.getQueryOrThrow(
            "SELECT round_id, kind FROM stage_transition WHERE org_id=? AND application_id=?",
            [org_id, app.application_id]);
        for (const t of transitions) {
            if (!EVALUATING_KINDS.includes(t.kind)) continue;
            if (!g.byRound.has(t.round_id)) g.byRound.set(t.round_id, {evaluated: 0, passed: 0});
            const r = g.byRound.get(t.round_id);
            r.evaluated++;
            if (t.kind == "advanced") r.passed++;
        }

        const offers = await dblayer.getQueryOrThrow(
            "SELECT status FROM offer_version WHERE org_id=? AND application_id=? ORDER BY version DESC LIMIT 1",
            [org_id, app.application_id]);
        if (offers[0]?.status == "accepted") g.hired++;
    }

    const eligibleGroups = [...groups.entries()].filter(([, g]) => g.applied >= MINIMUM_GROUP_SIZE);
    const suppressedCount = groups.size - eligibleGroups.length;

    const roundsOut = rounds.map(round => ({round_id: round.id, title: round.title,
        groups: eligibleGroups.map(([group_value, g]) => {
            const r = g.byRound.get(round.id) || {evaluated: 0, passed: 0};
            return {group: group_value, evaluated: r.evaluated, passed: r.passed,
                pass_rate: r.evaluated ? Math.round((r.passed/r.evaluated)*1000)/1000 : null};
        })}));

    const selectionRates = eligibleGroups.map(([group_value, g]) => ({group: group_value,
        applied: g.applied, hired: g.hired, selection_rate: g.applied ? g.hired/g.applied : 0}));
    const maxRate = Math.max(0, ...selectionRates.map(s => s.selection_rate));
    const overall = selectionRates.map(s => ({group: s.group, applied: s.applied, hired: s.hired,
        selection_rate: Math.round(s.selection_rate*1000)/1000,
        impact_ratio: maxRate ? Math.round((s.selection_rate/maxRate)*1000)/1000 : null,
        adverse_impact: maxRate ? (s.selection_rate/maxRate) < IMPACT_RATIO_THRESHOLD : false}));

    return {workflow_code: request.workflow_code, dimension: request.dimension,
        rounds: roundsOut, overall, suppressed_group_count: suppressedCount};
}
