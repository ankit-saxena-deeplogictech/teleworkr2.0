/**
 * N — wiki & documentation.
 *
 * Same shape as every other published thing in this app: space -> page tree
 * -> page -> version, with the published version a pointer and history
 * append-only (mirrors `recruitment.publishWorkflowAsync`/
 * `leave.publishPolicyAsync` exactly). A page's status/owner/visibility/
 * review metadata is a mutable wrapper around that versioned content —
 * the same split `requisition` has around `offer_version`.
 *
 * `capabilities.js` already declared `wiki.publish_public` with
 * `irreversible: true` before this module existed — `audit.performAsync`
 * refuses to run an irreversible capability without a `precheck` function
 * (verified directly against `test_audit.js`'s own existing coverage of
 * this exact capability). `_scanForPublicAsync` below is that precheck.
 *
 * Narrowed, deliberately (see the wireframe's N1-N5 for the fuller
 * ambition; each of these is a real simplification, not an oversight):
 *   - No G2 (files) exists. An embedded reference is a plain string, and
 *     the public-publish scan blocks on any non-empty reference — there is
 *     no per-file sharing state to check, so removal is the only answer.
 *   - No rich/collaborative editor exists anywhere in this app. A page
 *     body is an ordered list of {heading, body} plain-text sections.
 *     Concurrent-edit presence, per-block locking and inline suggestions
 *     need real-time infrastructure (websockets, presence) this app has
 *     nowhere else either, and are not built.
 *   - Page-to-page links are author-curated (`linked_page_ids`), not
 *     parsed from text — no markup parser exists anywhere in this app.
 *   - Space membership is its own plain edge table
 *     (`wiki_space_member`), not routed through the permission engine's
 *     TEAM scope, which needs `scope_ref` plumbing no builtin role has
 *     (the same gap K already hit).
 *   - "Space approver" is a named individual
 *     (`wiki_space.public_approver_person_id`), not a capability scope —
 *     `wiki.publish_public` stays ORG-scoped (hr/admin); approving a
 *     request requires the actor to hold that capability AND be the
 *     space's named approver, giving real per-space routing without
 *     inventing scope machinery.
 *   - Templates are a small fixed set, not shared with D5 (doesn't exist).
 *     Auto-creation from D6/F4/B3 is deferred entirely — none of those
 *     sources exist, and the wireframe's own N5 spec agrees: build N1/N2
 *     first or the first integration invents its own page model. One
 *     live-rendered integration is built instead — the leave policy
 *     (`leave.policyForPersonAsync` already exists) — proving "renders,
 *     never copies" with real data.
 *   - Personal spaces are deferred, same as the wireframe's own "Open"
 *     note defers them (no promotion path, no L1 leaver flow to tie into).
 *   - N4's orphan/duplicate/contradiction detection need page-view
 *     tracking or semantic judgement this app has no basis for. Deferred;
 *     deprecated-page display, one-click review reset, must-read +
 *     acknowledgement tracking and basic search are real and built.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);

const VISIBILITIES = Object.freeze(["private", "space", "org", "public"]);
const REVERSIBLE_VISIBILITIES = Object.freeze(["private", "space", "org"]);
const VISIBILITY_RANK = Object.freeze({private: 0, space: 1, org: 2});
const REVIEW_CADENCES = Object.freeze([3, 6, 12]);
const STATUS = Object.freeze({DRAFT: "draft", IN_REVIEW: "in_review", PUBLISHED: "published",
    ARCHIVED: "archived", DEPRECATED: "deprecated"});
const SCAN_PATTERNS = Object.freeze(["password", "secret", "api_key", "api key", "token=", ".internal", "localhost"]);
const TEMPLATES = Object.freeze(["Runbook", "Decision record", "Post-incident", "Onboarding checklist",
    "Policy", "Meeting notes", "Client guide"]);

const _now = _ => Math.floor(Date.now()/1000);
const _uuid = _ => serverutils.generateUUID(false);

async function _requireAsync(org_id, actor_person_id, capability, what) {
    const decision = await permissions.checkAsync({org_id, actor_person_id, capability});
    if (!decision.allowed) throw Object.assign(new Error(`${capability} is required to ${what}.`), {decision});
}

// ---------------------------------------------------------------------------
// spaces
// ---------------------------------------------------------------------------

/**
 * Creates a space — the permission and publishing boundary (N1 item 1).
 * @param {object} request {org_id, actor_person_id, name, slug, description,
 *      kind, default_visibility, public_approver_person_id}
 */
exports.createSpaceAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "create a space");
    if (!request.name?.trim()) throw new Error("A space needs a name.");
    if (!request.slug || !/^[a-z0-9-]{2,64}$/.test(request.slug)) throw new Error(
        "slug must be lowercase letters, digits and dashes (2-64).");
    const visibility = request.default_visibility || "space";
    if (!REVERSIBLE_VISIBILITIES.includes(visibility)) throw new Error(
        `default_visibility must be one of ${REVERSIBLE_VISIBILITIES.join(", ")} — a space is never public by default.`);
    const kind = request.kind || "team";
    if (!["team", "client"].includes(kind)) throw new Error("kind must be team or client.");

    const row = {space_id: _uuid(), org_id: request.org_id, name: request.name.trim(), slug: request.slug,
        description: request.description || null, kind, default_visibility: visibility,
        public_approver_person_id: request.public_approver_person_id || null,
        owner_person_id: request.actor_person_id, created_at: _now(), created_by: request.actor_person_id};
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_space (space_id, org_id, name, slug, description, kind, default_visibility,
            public_approver_person_id, owner_person_id, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [row.space_id, row.org_id, row.name, row.slug, row.description, row.kind, row.default_visibility,
            row.public_approver_person_id, row.owner_person_id, row.created_at, row.created_by]);
    await dblayer.runCmdOrThrow(
        "INSERT INTO wiki_space_member (org_id, space_id, person_id, added_at, added_by) VALUES (?,?,?,?,?)",
        [row.org_id, row.space_id, row.owner_person_id, row.created_at, row.owner_person_id]);
    return row;
}

/**
 * Lowers or raises a space's default visibility. Lowering cascades: any
 * page currently set above the new ceiling is demoted to it and recorded —
 * "it never silently leaves them exposed" (N3 item 6).
 * @param {object} request {org_id, actor_person_id, space_id, default_visibility}
 * @returns {object} {space, demoted_page_ids}
 */
exports.changeSpaceVisibilityAsync = async function(request) {
    const space = await _spaceRowAsync(request.org_id, request.space_id);
    if (!space) throw new Error(`No space ${request.space_id}.`);
    if (space.owner_person_id != request.actor_person_id) throw new Error("Only the space owner can change its visibility ceiling.");
    if (!REVERSIBLE_VISIBILITIES.includes(request.default_visibility)) throw new Error(
        `default_visibility must be one of ${REVERSIBLE_VISIBILITIES.join(", ")}.`);

    const newRank = VISIBILITY_RANK[request.default_visibility];
    await dblayer.runCmdOrThrow("UPDATE wiki_space SET default_visibility=? WHERE space_id=?",
        [request.default_visibility, request.space_id]);

    const pages = await dblayer.getQueryOrThrow(
        "SELECT * FROM wiki_page WHERE org_id=? AND space_id=? AND visibility IS NOT NULL",
        [request.org_id, request.space_id]);
    const demoted = [];
    for (const page of pages) {
        if (page.visibility == "public") continue;   // public sits outside this ladder entirely
        if (VISIBILITY_RANK[page.visibility] > newRank) {
            await dblayer.runCmdOrThrow("UPDATE wiki_page SET visibility=? WHERE page_id=?",
                [request.default_visibility, page.page_id]);
            demoted.push(page.page_id);
        }
    }
    return {space: await _spaceRowAsync(request.org_id, request.space_id), demoted_page_ids: demoted};
}

exports.spacesAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "wiki.read", "read spaces");
    return {spaces: await dblayer.getQueryOrThrow("SELECT * FROM wiki_space WHERE org_id=? ORDER BY name ASC", [org_id]),
        templates: TEMPLATES};
}

exports.addSpaceMemberAsync = async function(request) {
    const space = await _spaceRowAsync(request.org_id, request.space_id);
    if (!space) throw new Error(`No space ${request.space_id}.`);
    if (space.owner_person_id != request.actor_person_id) throw new Error("Only the space owner can add members.");
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_space_member (org_id, space_id, person_id, added_at, added_by) VALUES (?,?,?,?,?)
            ON CONFLICT (space_id, person_id) DO NOTHING`,
        [request.org_id, request.space_id, request.person_id, _now(), request.actor_person_id]);
    return "added";
}

exports.removeSpaceMemberAsync = async function(request) {
    const space = await _spaceRowAsync(request.org_id, request.space_id);
    if (!space) throw new Error(`No space ${request.space_id}.`);
    if (space.owner_person_id != request.actor_person_id) throw new Error("Only the space owner can remove members.");
    await dblayer.runCmdOrThrow("DELETE FROM wiki_space_member WHERE space_id=? AND person_id=?",
        [request.space_id, request.person_id]);
    return "removed";
}

// ---------------------------------------------------------------------------
// pages & versions — draft, review, publish
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, space_id, parent_page_id, title, slug} */
exports.createPageDraftAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "create a page");
    const space = await _spaceRowAsync(request.org_id, request.space_id);
    if (!space) throw new Error(`No space ${request.space_id}.`);
    if (!(await _canWriteSpaceAsync(request.org_id, request.actor_person_id, space)))
        throw new Error(`You are not a member of ${space.name}.`);
    if (!request.title?.trim()) throw new Error("A page needs a title.");
    if (!request.slug || !/^[a-z0-9-]{2,80}$/.test(request.slug)) throw new Error(
        "slug must be lowercase letters, digits and dashes (2-80).");

    const row = {page_id: _uuid(), org_id: request.org_id, space_id: request.space_id,
        parent_page_id: request.parent_page_id || null, title: request.title.trim(), slug: request.slug,
        owner_person_id: request.actor_person_id, status: STATUS.DRAFT, visibility: null,
        review_cadence_months: null, created_at: _now(), created_by: request.actor_person_id};
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_page (page_id, org_id, space_id, parent_page_id, title, slug, owner_person_id,
            status, visibility, review_cadence_months, requires_acknowledgement, created_at, created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.page_id, row.org_id, row.space_id, row.parent_page_id, row.title, row.slug, row.owner_person_id,
            row.status, row.visibility, row.review_cadence_months, request.requires_acknowledgement ? 1 : 0,
            row.created_at, row.created_by]);
    return row;
}

/**
 * Saves a new draft version — never edits one in place (N1 item 3).
 * @param {object} request {org_id, actor_person_id, page_id, sections,
 *      linked_page_ids, embedded_file_refs, reason}
 */
exports.saveDraftVersionAsync = async function(request) {
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    if ([STATUS.ARCHIVED, STATUS.DEPRECATED].includes(page.status)) throw new Error(
        `This page is ${page.status} and cannot be edited.`);
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "edit a page");
    const sections = _validateSections(request.sections);
    const linkedIds = Array.isArray(request.linked_page_ids) ? request.linked_page_ids : [];
    for (const linkedId of linkedIds) if (!(await _pageRowAsync(request.org_id, linkedId))) throw new Error(
        `linked_page_ids references ${linkedId}, which is not a page in this org.`);
    const fileRefs = Array.isArray(request.embedded_file_refs) ? request.embedded_file_refs : [];

    const versions = await dblayer.getQueryOrThrow(
        "SELECT MAX(version) AS max FROM wiki_page_version WHERE org_id=? AND page_id=?",
        [request.org_id, request.page_id]);
    const current = await _currentVersionRowAsync(request.org_id, request.page_id);
    const row = {wiki_page_version_id: _uuid(), org_id: request.org_id, page_id: request.page_id,
        version: (versions[0].max || 0) + 1, sections: JSON.stringify(sections),
        linked_page_ids: JSON.stringify(linkedIds), embedded_file_refs: JSON.stringify(fileRefs),
        reason: request.reason || null, author_person_id: request.actor_person_id,
        based_on_version: current?.version || null, created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_page_version (wiki_page_version_id, org_id, page_id, version, sections,
            linked_page_ids, embedded_file_refs, reason, author_person_id, based_on_version, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [row.wiki_page_version_id, row.org_id, row.page_id, row.version, row.sections, row.linked_page_ids,
            row.embedded_file_refs, row.reason, row.author_person_id, row.based_on_version, row.created_at]);
    if (page.status == STATUS.PUBLISHED) await dblayer.runCmdOrThrow(
        "UPDATE wiki_page SET status=? WHERE page_id=?", [STATUS.DRAFT, request.page_id]);
    return row;
}

function _validateSections(sections) {
    if (!Array.isArray(sections) || !sections.length) throw new Error("A page needs at least one section.");
    return sections.map(section => {
        if (!section?.heading?.trim()) throw new Error("Every section needs a heading.");
        return {heading: section.heading.trim(), body: section.body || ""};
    });
}

/** @param {object} request {org_id, actor_person_id, page_id, wiki_page_version_id, reviewer_person_id} */
exports.requestReviewAsync = async function(request) {
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "request a review");
    const row = {review_id: _uuid(), org_id: request.org_id, page_id: request.page_id,
        wiki_page_version_id: request.wiki_page_version_id, reviewer_person_id: request.reviewer_person_id,
        status: "pending", requested_at: _now(), decided_at: null};
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_review (review_id, org_id, page_id, wiki_page_version_id, reviewer_person_id, status, requested_at)
            VALUES (?,?,?,?,?,?,?)`,
        [row.review_id, row.org_id, row.page_id, row.wiki_page_version_id, row.reviewer_person_id, row.status, row.requested_at]);
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET status=? WHERE page_id=?", [STATUS.IN_REVIEW, request.page_id]);
    return row;
}

exports.approveReviewAsync = async function(request) {
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM wiki_review WHERE org_id=? AND review_id=?",
        [request.org_id, request.review_id]);
    const review = rows[0];
    if (!review) throw new Error(`No review ${request.review_id}.`);
    if (review.reviewer_person_id != request.actor_person_id) throw new Error("You are not the assigned reviewer.");
    if (review.status != "pending") throw new Error("This review already has a decision.");
    await dblayer.runCmdOrThrow("UPDATE wiki_review SET status='approved', decided_at=? WHERE review_id=?",
        [_now(), request.review_id]);
    return "approved";
}

/**
 * Publishes a draft version — mirrors `recruitment.publishWorkflowAsync`
 * exactly: immutable versions, a moved pointer, an audit entry every time
 * (N2 item 4: "writes to audit log: always"). Refuses without an owner or
 * a review cadence (N1 item 5) and while a requested review is still
 * outstanding.
 * @param {object} request {org_id, actor_person_id, page_id,
 *      wiki_page_version_id, review_cadence_months}
 */
exports.publishPageAsync = async function(request) {
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "publish a page");
    if (!page.owner_person_id) throw new Error(
        "A page with no owner cannot be published — it stays a draft no matter how finished it looks (N1 item 5).");
    const cadence = request.review_cadence_months ?? page.review_cadence_months;
    if (!REVIEW_CADENCES.includes(cadence)) throw new Error(
        `A review cadence of ${REVIEW_CADENCES.join(", ")} months is required to publish.`);
    const version = (await dblayer.getQueryOrThrow(
        "SELECT * FROM wiki_page_version WHERE org_id=? AND wiki_page_version_id=?",
        [request.org_id, request.wiki_page_version_id]))[0];
    if (!version || version.page_id != request.page_id) throw new Error("That version does not belong to this page.");
    const outstanding = await dblayer.getQueryOrThrow(
        "SELECT * FROM wiki_review WHERE org_id=? AND wiki_page_version_id=? AND status='pending'",
        [request.org_id, request.wiki_page_version_id]);
    if (outstanding.length) throw new Error(
        `${outstanding.length} review(s) are still outstanding — publish is gated on them.`);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "wiki.write",
        audit: {action: "wiki.page_published", object_type: "wiki_page", object_ref: request.page_id,
            detail: {version: version.version, reason: version.reason}},
        action: async exec => {
            await exec.runCmd(
                `INSERT INTO wiki_page_pointer (org_id, page_id, wiki_page_version_id, updated_at) VALUES (?,?,?,?)
                    ON CONFLICT (org_id, page_id) DO UPDATE SET wiki_page_version_id=excluded.wiki_page_version_id,
                        updated_at=excluded.updated_at`,
                [request.org_id, request.page_id, request.wiki_page_version_id, _now()]);
            await exec.runCmd(
                `UPDATE wiki_page SET status=?, review_cadence_months=?, last_reviewed_at=?, last_reviewed_by=?
                    WHERE page_id=?`,
                [STATUS.PUBLISHED, cadence, _now(), request.actor_person_id, request.page_id]);
            return {page_id: request.page_id, version: version.version};
        }});
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * @param {string} org_id The org
 * @param {string} actor_person_id The reader
 * @param {string} page_id The page
 * @returns {object} {page, space, sections, linked_page_ids} — `sections`
 *      is rendered live from the source system when `source_type` is set,
 *      never a stored copy (N5's central rule).
 */
exports.pageAsync = async function(org_id, actor_person_id, page_id) {
    await _requireAsync(org_id, actor_person_id, "wiki.read", "read the wiki");
    const page = await _pageRowAsync(org_id, page_id);
    if (!page) throw new Error(`No page ${page_id}.`);
    const space = await _spaceRowAsync(org_id, page.space_id);
    if (!(await _canReadPageAsync(org_id, actor_person_id, page, space))) throw new Error(
        `This page is ${page.visibility || space.default_visibility}-visible and you are not covered by that.`);

    if (page.source_type == "leave_policy") return {page, space, sections: await _renderLeavePolicyAsync(org_id, page.source_ref),
        linked_page_ids: [], latest_version_id: null, latest_version_number: null};

    // The published pointer is what's shown by default (that's what "published" means);
    // a page with no published version yet (still drafting) falls back to its newest
    // draft, so an author can see what they wrote. Either way, `latest_version_id` is
    // always the newest saved version — what publishPageAsync itself needs, since the
    // published pointer and "the version to publish next" are frequently different rows.
    const published = await _currentVersionRowAsync(org_id, page_id);
    const latest = await _latestVersionRowAsync(org_id, page_id);
    const shown = published || latest;
    if (!shown) return {page, space, sections: [], linked_page_ids: [], latest_version_id: null, latest_version_number: null};
    return {page, space, sections: JSON.parse(shown.sections), linked_page_ids: JSON.parse(shown.linked_page_ids),
        version: shown.version, author_person_id: shown.author_person_id,
        latest_version_id: latest.wiki_page_version_id, latest_version_number: latest.version,
        published_version_id: published?.wiki_page_version_id || null};
}

async function _renderLeavePolicyAsync(org_id, jurisdiction) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM leave_policy_pointer WHERE org_id=? AND scope_key LIKE ? ORDER BY updated_at DESC LIMIT 1`,
        [org_id, `${jurisdiction}|%`]);
    if (!rows.length) return [{heading: "No published policy", body: `No leave policy is published for ${jurisdiction}.`}];
    const version = (await dblayer.getQueryOrThrow("SELECT * FROM leave_policy_version WHERE policy_version_id=?",
        [rows[0].policy_version_id]))[0];
    const policy = JSON.parse(version.policy);
    return [{heading: `Leave policy — ${jurisdiction} (v${version.version})`,
        body: `Effective from ${version.effective_from}.`},
        ...policy.leave_types.map(type => ({heading: type.label || type.code,
            body: `Annual entitlement: ${type.quantum?.annual_days ?? "not balance-gated"} day(s). Approval route: ${type.approval_route.join(" -> ")}.`}))];
}

/** @param {object} request {org_id, actor_person_id, q, space_id, current_only} */
exports.searchPagesAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.read", "search the wiki");
    let where = "org_id=?", params = [request.org_id];
    if (request.space_id) {where += " AND space_id=?"; params.push(request.space_id);}
    if (request.current_only) {where += " AND status='published'"; }
    const rows = await dblayer.getQueryOrThrow(`SELECT * FROM wiki_page WHERE ${where} ORDER BY title ASC`, params);
    const filtered = [];
    for (const page of rows) {
        const space = await _spaceRowAsync(request.org_id, page.space_id);
        if (!(await _canReadPageAsync(request.org_id, request.actor_person_id, page, space))) continue;
        if (request.q) {
            const version = await _currentVersionRowAsync(request.org_id, page.page_id);
            const haystack = (page.title + " " + (version ? JSON.parse(version.sections).map(s => `${s.heading} ${s.body}`).join(" ") : "")).toLowerCase();
            if (!haystack.includes(request.q.toLowerCase())) continue;
        }
        filtered.push(page);
    }
    return {pages: filtered};
}

// ---------------------------------------------------------------------------
// freshness (N4, narrowed)
// ---------------------------------------------------------------------------

/** The cheapest possible action — resets the review clock, never creates a version. */
exports.markStillCorrectAsync = async function(request) {
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    if (page.owner_person_id != request.actor_person_id) throw new Error(
        "Only the page owner can mark it still correct (N4 item 4).");
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET last_reviewed_at=?, last_reviewed_by=? WHERE page_id=?",
        [_now(), request.actor_person_id, request.page_id]);
    return "reviewed";
}

/** @param {object} request {org_id, actor_person_id, page_id, successor_page_id, reason} */
exports.deprecatePageAsync = async function(request) {
    if (!request.reason) throw new Error("Deprecating needs a reason — it names what replaced the page, not just that it did (N4).");
    if (!request.successor_page_id) throw new Error("Deprecating needs a named successor page.");
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "deprecate a page");
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET status=?, superseded_by_page_id=? WHERE page_id=?",
        [STATUS.DEPRECATED, request.successor_page_id, request.page_id]);
    return "deprecated";
}

/** @param {object} request {org_id, actor_person_id, page_id, reason} */
exports.archivePageAsync = async function(request) {
    if (!request.reason) throw new Error("Archiving needs a reason. An incoming link that 404s is worse than one that explains itself (N4).");
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "archive a page");
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET status=? WHERE page_id=?", [STATUS.ARCHIVED, request.page_id]);
    return "archived";
}

// ---------------------------------------------------------------------------
// acknowledgement — a separate, recorded concept from publication (N4 item 5)
// ---------------------------------------------------------------------------

exports.acknowledgeAsync = async function(request) {
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    const version = await _currentVersionRowAsync(request.org_id, request.page_id);
    if (!version) throw new Error("This page has no published version to acknowledge.");
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_acknowledgement (org_id, page_id, person_id, wiki_page_version_id, acknowledged_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT (page_id, person_id) DO UPDATE SET wiki_page_version_id=excluded.wiki_page_version_id,
                acknowledged_at=excluded.acknowledged_at`,
        [request.org_id, request.page_id, request.actor_person_id, version.wiki_page_version_id, _now()]);
    return "acknowledged";
}

exports.acknowledgementStatusAsync = async function(org_id, actor_person_id, page_id) {
    await _requireAsync(org_id, actor_person_id, "wiki.publish_public", "read acknowledgement status");
    return {acknowledgements: await dblayer.getQueryOrThrow(
        `SELECT a.*, p.display_name FROM wiki_acknowledgement a LEFT JOIN person p ON p.person_id=a.person_id
            WHERE a.org_id=? AND a.page_id=? ORDER BY a.acknowledged_at DESC`, [org_id, page_id])};
}

// ---------------------------------------------------------------------------
// visibility (N3) — three reversible levels, then the one that isn't
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, page_id, visibility} */
exports.changeVisibilityAsync = async function(request) {
    if (request.visibility == "public") throw new Error(
        "Public visibility is not a reversible toggle — request it via requestPublicPublishAsync.");
    if (request.visibility !== null && !REVERSIBLE_VISIBILITIES.includes(request.visibility)) throw new Error(
        `visibility must be one of ${REVERSIBLE_VISIBILITIES.join(", ")}, or null to inherit the space.`);
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    if (page.owner_person_id != request.actor_person_id) throw new Error("Only the page owner can change its visibility.");
    if (page.visibility == "public") throw new Error("This page is public — unpublish it first.");
    const space = await _spaceRowAsync(request.org_id, page.space_id);
    if (request.visibility && VISIBILITY_RANK[request.visibility] > VISIBILITY_RANK[space.default_visibility])
        throw new Error(`${space.name}'s ceiling is ${space.default_visibility} — a page cannot be more visible than its space (N3 item 6).`);
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET visibility=? WHERE page_id=?", [request.visibility, request.page_id]);
    return "changed";
}

/** The pre-publish scan — also `wiki.publish_public`'s required precheck. */
async function _scanForPublicAsync(org_id, page_id) {
    const page = await _pageRowAsync(org_id, page_id);
    const version = await _currentVersionRowAsync(org_id, page_id);
    const blocks = [], warnings = [];
    if (!version) {blocks.push("This page has no published content to scan."); return {blocks, warnings, clear: false};}

    for (const linkedId of JSON.parse(version.linked_page_ids || "[]")) {
        const linked = await _pageRowAsync(org_id, linkedId);
        const effectivelyPublic = linked && linked.visibility == "public" && !linked.public_unpublished_at;
        if (!effectivelyPublic) blocks.push(`Links to a page that is not public: "${linked?.title || linkedId}".`);
    }
    const fileRefs = JSON.parse(version.embedded_file_refs || "[]");
    if (fileRefs.length) blocks.push(
        `${fileRefs.length} embedded file reference(s) — publishing a page never publishes its attachments; each needs its own decision.`);

    const bodyText = JSON.parse(version.sections).map(s => `${s.heading} ${s.body}`).join(" ").toLowerCase();
    for (const pattern of SCAN_PATTERNS) if (bodyText.includes(pattern)) warnings.push(
        `Body text matches "${pattern}" — pattern match, not judgement. A human still reads it.`);
    const children = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_page WHERE org_id=? AND parent_page_id=?", [org_id, page_id]))[0].c;
    if (children) warnings.push(`Page has ${children} child page(s). Publishing a tree is separate approvals, deliberately.`);

    return {blocks, warnings, clear: blocks.length == 0 && warnings.length == 0};
}

/** @param {object} request {org_id, actor_person_id, page_id, reason, slug, allow_indexing} */
exports.requestPublicPublishAsync = async function(request) {
    if (!request.reason?.trim()) throw new Error("A public-publish request needs a reason.");
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    if (page.status != STATUS.PUBLISHED) throw new Error("Only a published page can be requested for public visibility.");
    if (!request.slug || !/^[a-z0-9-]{2,120}$/.test(request.slug)) throw new Error(
        "A public slug (lowercase letters, digits and dashes) is required.");
    const slugTaken = await dblayer.getQueryOrThrow(
        "SELECT 1 FROM wiki_page WHERE org_id=? AND public_slug=? AND page_id != ?",
        [request.org_id, request.slug, request.page_id]);
    if (slugTaken.length) throw new Error(`The slug "${request.slug}" is already in use.`);

    const scan = await _scanForPublicAsync(request.org_id, request.page_id);
    if (scan.blocks.length) throw new Error(
        `Cannot request public visibility — the scan blocks: ${scan.blocks.join(" ")}`);

    const row = {request_id: _uuid(), org_id: request.org_id, page_id: request.page_id,
        requested_by: request.actor_person_id, reason: request.reason, scan_result: JSON.stringify(scan),
        status: "pending", slug: request.slug, allow_indexing: request.allow_indexing ? 1 : 0, created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_public_request (request_id, org_id, page_id, requested_by, reason, scan_result,
            status, slug, allow_indexing, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [row.request_id, row.org_id, row.page_id, row.requested_by, row.reason, row.scan_result,
            row.status, row.slug, row.allow_indexing, row.created_at]);
    return row;
}

/**
 * The approver's queue — every pending request, with the page/space
 * context an approver needs (N3 item 3: "approver sees the rendered page,
 * the scan results, the requester's reason"). `wiki.publish_public` gates
 * reading the queue at all; deciding a given row still separately requires
 * being that row's space's named approver (checked in
 * `decidePublicRequestAsync`, not duplicated here — a non-approver can see
 * the queue exists without being able to act on every row in it).
 */
exports.pendingPublicRequestsAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "wiki.publish_public", "read the public-publish request queue");
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM wiki_public_request WHERE org_id=? AND status='pending' ORDER BY created_at ASC", [org_id]);
    const requests = [];
    for (const row of rows) {
        const page = await _pageRowAsync(org_id, row.page_id);
        const space = page ? await _spaceRowAsync(org_id, page.space_id) : null;
        requests.push({...row, scan_result: JSON.parse(row.scan_result), page_title: page?.title || null,
            space_name: space?.name || null, is_approver: space?.public_approver_person_id == actor_person_id});
    }
    return {requests};
}

/**
 * Decides a public-publish request. Approving requires the actor to hold
 * `wiki.publish_public` (checked by `audit.performAsync`, ORG-scoped —
 * hr/admin) AND be the space's own named `public_approver_person_id` —
 * both, not either (Context's per-space-approver answer). Re-scans at
 * decision time, since content can change between request and decision;
 * the re-scan is also the capability's own required `precheck`.
 * @param {object} request {org_id, actor_person_id, request_id, decision,
 *      decision_reason, step_up_verified}
 */
exports.decidePublicRequestAsync = async function(request) {
    if (!["approved", "declined"].includes(request.decision)) throw new Error("decision must be approved or declined.");
    const pending = (await dblayer.getQueryOrThrow("SELECT * FROM wiki_public_request WHERE org_id=? AND request_id=?",
        [request.org_id, request.request_id]))[0];
    if (!pending || pending.status != "pending") throw new Error(`Request ${request.request_id} is not awaiting a decision.`);
    const page = await _pageRowAsync(request.org_id, pending.page_id);
    const space = await _spaceRowAsync(request.org_id, page.space_id);
    if (!space.public_approver_person_id || space.public_approver_person_id != request.actor_person_id) throw new Error(
        `Only ${space.name}'s named approver can decide this request.`);

    if (request.decision == "declined") {
        if (!request.decision_reason?.trim()) throw new Error("A decline needs a reason.");
        await dblayer.runCmdOrThrow(
            "UPDATE wiki_public_request SET status='declined', approver_person_id=?, decided_at=?, decision_reason=? WHERE request_id=?",
            [request.actor_person_id, _now(), request.decision_reason, request.request_id]);
        return {status: "declined"};
    }

    const rescan = await _scanForPublicAsync(request.org_id, pending.page_id);
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "wiki.publish_public", step_up_verified: request.step_up_verified,
        precheck: async _ => rescan.blocks.length == 0,
        audit: {action: "wiki.published_public", object_type: "wiki_page", object_ref: pending.page_id,
            detail: {slug: pending.slug, warnings: rescan.warnings, requested_by: pending.requested_by}},
        action: async exec => {
            await exec.runCmd(
                "UPDATE wiki_public_request SET status='approved', approver_person_id=?, decided_at=? WHERE request_id=?",
                [request.actor_person_id, _now(), request.request_id]);
            await exec.runCmd(
                "UPDATE wiki_page SET visibility='public', public_slug=?, allow_indexing=?, public_unpublished_at=NULL WHERE page_id=?",
                [pending.slug, pending.allow_indexing, pending.page_id]);
            return {status: "approved", public_slug: pending.slug};
        }});
}

/**
 * Unpublishes a public page. The slug keeps resolving — to a stated
 * "no longer published" state, never a 404 (N3's States list).
 * "Unpublishing removes it from this site — it does not remove copies
 * that have already been made."
 */
exports.unpublishPublicAsync = async function(request) {
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    if (page.visibility != "public") throw new Error("This page is not currently public.");
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.publish_public", "unpublish a public page");
    await dblayer.runCmdOrThrow(
        "UPDATE wiki_page SET visibility='org', public_unpublished_at=? WHERE page_id=?", [_now(), request.page_id]);
    return "unpublished";
}

/** The no-auth, internet-facing read. Never a 404 for a slug that was ever valid. */
exports.publicPageBySlugAsync = async function(org_id, public_slug) {
    const page = (await dblayer.getQueryOrThrow("SELECT * FROM wiki_page WHERE org_id=? AND public_slug=?",
        [org_id, public_slug]))[0];
    if (!page) return null;
    if (page.public_unpublished_at) return {page, unpublished: true, sections: []};
    const version = await _currentVersionRowAsync(org_id, page.page_id);
    return {page, unpublished: false, sections: version ? JSON.parse(version.sections) : []};
}

// ---------------------------------------------------------------------------
// shared links — the reversible middle ground (N3 item 2)
// ---------------------------------------------------------------------------

exports.createShareLinkAsync = async function(request) {
    const page = await _pageRowAsync(request.org_id, request.page_id);
    if (!page) throw new Error(`No page ${request.page_id}.`);
    if (page.owner_person_id != request.actor_person_id) throw new Error("Only the page owner can create a share link.");
    if (!request.recipient_name?.trim()) throw new Error("A share link needs a named recipient.");
    const expiresInDays = request.expires_in_days || 14;
    const row = {share_link_id: _uuid(), org_id: request.org_id, page_id: request.page_id,
        recipient_name: request.recipient_name.trim(), token: _uuid(),
        expires_at: _now() + expiresInDays*86400, revoked_at: null,
        created_by: request.actor_person_id, created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_share_link (share_link_id, org_id, page_id, recipient_name, token, expires_at,
            revoked_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.share_link_id, row.org_id, row.page_id, row.recipient_name, row.token, row.expires_at,
            row.revoked_at, row.created_by, row.created_at]);
    return row;
}

exports.revokeShareLinkAsync = async function(org_id, actor_person_id, share_link_id) {
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM wiki_share_link WHERE org_id=? AND share_link_id=?",
        [org_id, share_link_id]);
    if (!rows.length) throw new Error(`No share link ${share_link_id}.`);
    await dblayer.runCmdOrThrow("UPDATE wiki_share_link SET revoked_at=? WHERE share_link_id=?", [_now(), share_link_id]);
    return "revoked";
}

exports.shareLinksAsync = async function(org_id, actor_person_id, page_id) {
    await _requireAsync(org_id, actor_person_id, "wiki.read", "read share links");
    return {links: await dblayer.getQueryOrThrow(
        "SELECT * FROM wiki_share_link WHERE org_id=? AND page_id=? ORDER BY created_at DESC", [org_id, page_id])};
}

/** No session — a bearer token, not an identity, same spirit as K9 but far smaller. */
exports.readViaShareLinkAsync = async function(token) {
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM wiki_share_link WHERE token=?", [token]);
    const link = rows[0];
    if (!link) throw new Error("This link is not valid.");
    if (link.revoked_at) throw new Error("This link has been revoked.");
    if (link.expires_at < _now()) throw new Error("This link has expired.");
    const page = await _pageRowAsync(link.org_id, link.page_id);
    const version = await _currentVersionRowAsync(link.org_id, link.page_id);
    return {page, sections: version ? JSON.parse(version.sections) : []};
}

// ---------------------------------------------------------------------------
// standing review (N3 item 5)
// ---------------------------------------------------------------------------

exports.standingReviewReportAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "wiki.publish_public", "read the standing review report");
    const publicPages = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_page WHERE org_id=? AND visibility='public' AND public_unpublished_at IS NULL",
        [org_id]))[0].c;
    const liveLinks = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_share_link WHERE org_id=? AND revoked_at IS NULL AND expires_at > ?",
        [org_id, _now()]))[0].c;
    const expiredEnabled = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_share_link WHERE org_id=? AND revoked_at IS NULL AND expires_at <= ?",
        [org_id, _now()]))[0].c;
    const staleThreshold = _now() - 365*86400;
    const staleReviewed = (await dblayer.getQueryOrThrow(
        `SELECT COUNT(*) AS c FROM wiki_page WHERE org_id=? AND visibility='public' AND public_unpublished_at IS NULL
            AND (last_reviewed_at IS NULL OR last_reviewed_at < ?)`, [org_id, staleThreshold]))[0].c;
    return {public_pages: publicPages, share_links_live: liveLinks, links_past_expiry_still_enabled: expiredEnabled,
        public_pages_not_reviewed_12m: staleReviewed};
}

// ---------------------------------------------------------------------------
// N5, narrowed — task<->page linking
// ---------------------------------------------------------------------------

exports.linkPageToTaskAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "wiki.write", "link a page to a task");
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_page_task_link (org_id, page_id, task_ref, created_at, created_by) VALUES (?,?,?,?,?)
            ON CONFLICT (page_id, task_ref) DO NOTHING`,
        [request.org_id, request.page_id, request.task_ref, _now(), request.actor_person_id]);
    return "linked";
}

exports.unlinkPageFromTaskAsync = async function(org_id, page_id, task_ref) {
    await dblayer.runCmdOrThrow("DELETE FROM wiki_page_task_link WHERE org_id=? AND page_id=? AND task_ref=?",
        [org_id, page_id, task_ref]);
    return "unlinked";
}

exports.pagesForTaskAsync = async function(org_id, task_ref) {
    return {pages: await dblayer.getQueryOrThrow(
        `SELECT p.* FROM wiki_page_task_link l JOIN wiki_page p ON p.page_id = l.page_id
            WHERE l.org_id=? AND l.task_ref=?`, [org_id, task_ref])};
}

exports.tasksForPageAsync = async function(org_id, page_id) {
    return {task_refs: (await dblayer.getQueryOrThrow(
        "SELECT task_ref FROM wiki_page_task_link WHERE org_id=? AND page_id=?", [org_id, page_id])).map(r => r.task_ref)};
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function _spaceRowAsync(org_id, space_id) {
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM wiki_space WHERE org_id=? AND space_id=?", [org_id, space_id]);
    return rows[0] || null;
}

async function _pageRowAsync(org_id, page_id) {
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM wiki_page WHERE org_id=? AND page_id=?", [org_id, page_id]);
    return rows[0] || null;
}

async function _currentVersionRowAsync(org_id, page_id) {
    const pointer = await dblayer.getQueryOrThrow("SELECT * FROM wiki_page_pointer WHERE org_id=? AND page_id=?", [org_id, page_id]);
    if (!pointer.length) return null;
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM wiki_page_version WHERE wiki_page_version_id=?",
        [pointer[0].wiki_page_version_id]);
    return rows[0] || null;
}

/** The newest saved version regardless of publish state — what an in-progress draft needs to publish itself. */
async function _latestVersionRowAsync(org_id, page_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM wiki_page_version WHERE org_id=? AND page_id=? ORDER BY version DESC LIMIT 1", [org_id, page_id]);
    return rows[0] || null;
}

async function _canWriteSpaceAsync(org_id, person_id, space) {
    if (space.owner_person_id == person_id) return true;
    const member = await dblayer.getQueryOrThrow(
        "SELECT 1 FROM wiki_space_member WHERE org_id=? AND space_id=? AND person_id=?", [org_id, space.space_id, person_id]);
    return member.length > 0;
}

async function _canReadPageAsync(org_id, person_id, page, space) {
    if (page.owner_person_id == person_id) return true;
    const level = page.visibility || space.default_visibility;
    if (level == "private") return false;
    if (level == "space") return await _canWriteSpaceAsync(org_id, person_id, space);
    return true;   // org or public — reachable by anyone holding wiki.read, already checked by the caller
}

exports.STATUS = STATUS;
exports.VISIBILITIES = VISIBILITIES;
exports.REVIEW_CADENCES = REVIEW_CADENCES;
exports.TEMPLATES = TEMPLATES;
