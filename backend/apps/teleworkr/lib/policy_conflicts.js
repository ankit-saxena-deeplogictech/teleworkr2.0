/**
 * J8 — the seven policy conflicts the engine cannot resolve. Building the
 * evaluator forced each ambiguity into the open, because the code has to pick
 * one reading; this module is the record of that instead of whoever wrote the
 * controller choosing silently.
 *
 *   class "publish"  structural — the validator refuses to publish until HR
 *                    chooses a reading, because the evaluator would otherwise
 *                    return different answers on different code paths.
 *   class "assumed"  carries a working interpretation, confirmed or overridden.
 *   class "legal"    blocked until legal decides; more generous than statute is
 *                    permissible, but only deliberately.
 *
 * Resolutions are stored with the policy version (J8 interactions #2).
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const _now = () => Math.floor(Date.now()/1000);

const CONFLICTS = Object.freeze([
    {id: "leave_during_probation", class: "publish",
        title: "Leave during probation",
        why: "One clause allows short notice leave during probation; another says leave cannot be taken during probation at all. Eligibility must resolve to one answer per person per day.",
        choices: ["per_type_eligibility", "no_leave_during_probation"],
        detects: policy => (policy.scope?.status||[]).includes("probation") &&
            policy.leave_types.some(type => (type.eligibility?.states||[]).includes("probation"))},
    {id: "clubbing_window", class: "publish",
        title: "Clubbing — \"not counted the first time\"",
        why: "First within what window — financial year, quarter, rolling 12 months? The window the policy types is the answer, but it has to be chosen, not defaulted.",
        choices: ["per_financial_year", "per_quarter", "rolling_12m"],
        detects: policy => policy.leave_types.some(type => type.clubbing?.mode == "exempt_first")},
    {id: "backdating_exception", class: "assumed", default: "2d_snl_only",
        title: "Backdating",
        why: "The system may be updated up to 2 days backdated for sick and emergency leave; elsewhere, leaves cannot be approved at a past date. Reading taken: the 2-day window is the exception, for short notice leave only.",
        choices: ["2d_snl_only", "any_type"],
        detects: policy => policy.leave_types.some(type => type.backdating)},
    {id: "short_notice_rules", class: "assumed", default: "2d_foreseeable_4h_floor",
        title: "Short notice leave has two notice rules",
        why: "Two working days in advance, and separately, at least four hours before the shift. Reading taken: 2 days where foreseeable, 4 hours as the floor for genuine emergencies.",
        choices: ["2d_foreseeable_4h_floor", "single_rule"],
        detects: policy => policy.leave_types.some(type => type.notice?.short_notice_approvable)},
    {id: "carry_vs_exit_cap", class: "assumed", default: "exit_cap_covers_old_bucket",
        title: "Carry-forward 3 vs exit cap 30",
        why: "Earned leave carries a maximum of 3 days, yet the exit kitty is capped at 30. Only reconcilable if the exit cap covers the old bucket too.",
        choices: ["exit_cap_covers_old_bucket", "exit_cap_new_bucket_only"],
        detects: policy => policy.leave_types.some(type => type.carry_forward?.cap_days !== undefined)},
    {id: "maternity_third_child", class: "legal",
        title: "Maternity for a third child",
        why: "The document gives 26 weeks where the Maternity Benefit Act provides 12. The policy is more generous than the statute, which is permissible — but it should be deliberate.",
        choices: ["26w_as_written", "12w_statutory"],
        detects: policy => policy.leave_types.some(type => type.code == "ML" && type.quantum?.annual_days >= 180)},
    {id: "half_day_rule", class: "publish",
        title: "Half-day is both a request and a measurement",
        why: "A half-day needs 24 hours' notice, yet a 4.5–7 hour working day reads as half-day automatically. Recommended: detect the short day, tell the person, and ask them to confirm.",
        choices: ["auto_deduct_with_confirm", "confirm_not_deduct"],
        detects: policy => policy.leave_types.some(type => type.allow_half_days === true)}
]);

/** The conflicts this policy actually raises. */
exports.detect = policy => CONFLICTS.filter(conflict => conflict.detects(policy));

/**
 * Resolves the policy's detected conflicts against the supplied choices.
 * Publish-class and legal conflicts without an explicit choice block publish —
 * the refusal carries the conflict rows so the screen can show them (J8).
 * Assumed conflicts fall back to their working interpretation.
 *
 * @param {object} policy The validated policy
 * @param {object} supplied {conflict_id: choice}
 * @param {string} actor_person_id Who is deciding
 * @returns {object} The stored resolutions, one per detected conflict
 * @throws With err.conflicts when a publish/legal conflict is unresolved
 */
exports.resolveForPolicy = function(policy, supplied, actor_person_id) {
    const detected = exports.detect(policy);
    for (const id of Object.keys(supplied || {})) {
        const conflict = CONFLICTS.find(entry => entry.id == id);
        if (!conflict) throw new Error(`"${id}" is not a known policy conflict.`);
        if (!conflict.choices.includes(supplied[id])) throw new Error(
            `Conflict ${id} needs one of: ${conflict.choices.join(", ")}. Got ${JSON.stringify(supplied[id])}.`);
    }

    const missing = [];
    for (const conflict of detected)
        if (conflict.class != "assumed" && supplied?.[conflict.id] === undefined) missing.push(conflict);
    if (missing.length) {
        const err = new Error(
            `Publish is blocked by unresolved policy conflicts: ${missing.map(c => c.id).join(", ")}. HR must choose a reading for each.`);
        err.conflicts = missing.map(({id, title, why, class: cls, choices, default: def}) =>
            ({id, title, why, class: cls, choices, default_reading: def || null}));
        throw err;
    }

    // enforcements — the chosen reading changes what the schema will accept
    for (const conflict of detected) {
        const choice = supplied?.[conflict.id] ?? conflict.default;
        if (conflict.id == "clubbing_window" && choice)
            for (const type of policy.leave_types.filter(t => t.clubbing?.mode == "exempt_first"))
                if (type.clubbing.window && type.clubbing.window != choice) throw new Error(
                    `Conflict clubbing_window resolves to ${choice}, but ${type.code} types ${type.clubbing.window}. They must agree.`);
        if (conflict.id == "leave_during_probation" && choice == "no_leave_during_probation")
            for (const type of policy.leave_types)
                if ((type.eligibility?.states||[]).includes("probation")) throw new Error(
                    `leave_during_probation resolves to no_leave_during_probation, but ${type.code} grants probation eligibility. Remove it or change the reading.`);
    }

    const stored = {};
    for (const conflict of detected) {
        const explicit = supplied?.[conflict.id] !== undefined;
        stored[conflict.id] = {choice: supplied?.[conflict.id] ?? conflict.default,
            source: explicit ? "explicit" : "default",
            decided_by: explicit ? actor_person_id : null, decided_at: _now()};
    }
    return stored;
}

exports.CONFLICTS = CONFLICTS;
