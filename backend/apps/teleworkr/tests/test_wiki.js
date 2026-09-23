/**
 * Tests N — wiki & documentation. The versioned-pointer publish discipline
 * (owner + review cadence required, outstanding reviews gate it, old
 * versions stay queryable); the pre-publish scan as `wiki.publish_public`'s
 * own required precheck; the "capability AND named approver, both" rule;
 * unpublish's stated-not-404 behaviour; share-link expiry; and the
 * leave-policy page rendering live, never a stored copy.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests wiki
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const wiki = require(`${TELEWORKR_CONSTANTS.LIBDIR}/wiki.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Wiki test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}
const _now = () => Math.floor(Date.now()/1000);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "wiki")) {
        LOG.console("Skipping wiki test case, not called.\n"); return true;
    }
    LOG.console("\nN wiki & documentation\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testPublishDiscipline(w);
        await _testFreshness(w);
        await _testVisibilityCeiling(w);
        await _testPublicScan(w);
        await _testPublicApproval(w);
        await _testShareLinks(w);
        await _testLeavePolicyRendering(w);
        await _testCapabilityRefusals(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  wiki tests threw: ${err}\n`); LOG.error(`Wiki tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nWiki tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

async function _draftPage(w, spaceId, actor, title, slug) {
    const page = await wiki.createPageDraftAsync({org_id: w.org_id, actor_person_id: actor, space_id: spaceId, title, slug});
    const draft = await wiki.saveDraftVersionAsync({org_id: w.org_id, actor_person_id: actor, page_id: page.page_id,
        sections: [{heading: "Overview", body: "Plain body text."}], reason: "Initial draft."});
    return {page, draft};
}

async function _testPublishDiscipline(w) {
    LOG.console("\n publish discipline — the versioned pointer\n");
    const space = await wiki.createSpaceAsync({org_id: w.org_id, actor_person_id: w.carol,
        name: "Engineering", slug: `eng-${w.stamp}`, default_visibility: "org"});
    const {page, draft} = await _draftPage(w, space.space_id, w.carol, "Deploying the gateway", "deploy-gateway");

    await _checkThrows("publish refuses without a review cadence",
        _ => wiki.publishPageAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
            wiki_page_version_id: draft.wiki_page_version_id}));

    // an unowned page: created, then owner cleared directly (createPageDraftAsync always assigns one)
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET owner_person_id=NULL WHERE page_id=?", [page.page_id]);
    await _checkThrows("publish refuses without an owner (N1 item 5)",
        _ => wiki.publishPageAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
            wiki_page_version_id: draft.wiki_page_version_id, review_cadence_months: 6}));
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET owner_person_id=? WHERE page_id=?", [w.carol, page.page_id]);

    const review = await wiki.requestReviewAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
        wiki_page_version_id: draft.wiki_page_version_id, reviewer_person_id: w.dave});
    await _checkThrows("publish refuses while a requested review is outstanding",
        _ => wiki.publishPageAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
            wiki_page_version_id: draft.wiki_page_version_id, review_cadence_months: 6}));

    await wiki.approveReviewAsync({org_id: w.org_id, actor_person_id: w.dave, review_id: review.review_id});
    const published = await wiki.publishPageAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
        wiki_page_version_id: draft.wiki_page_version_id, review_cadence_months: 6});
    _check("publish succeeds once owned, cadenced and reviewed", published.version == 1, JSON.stringify(published));

    const read1 = await wiki.pageAsync(w.org_id, w.carol, page.page_id);
    _check("the page reads back as published, v1", read1.page.status == "published" && read1.version == 1, JSON.stringify(read1.page));

    const draft2 = await wiki.saveDraftVersionAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
        sections: [{heading: "Overview", body: "Updated body."}], reason: "Clarified the rollback step."});
    const read2 = await wiki.pageAsync(w.org_id, w.carol, page.page_id);
    _check("saving a new draft never rewrites the published version — the page shows v1 still, draft v2 is separate",
        read2.version == 1 && draft2.version == 2, JSON.stringify({shown: read2.version, draft: draft2.version}));

    w.publishedPage = page; w.publishedSpace = space;
}

async function _testFreshness(w) {
    LOG.console("\n freshness — reviewed, not edited\n");
    // Backdated rather than slept for — publish and this check can otherwise
    // land in the same wall-clock second, and the comparison needs real
    // separation, not a delay that merely makes it likely.
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET last_reviewed_at=? WHERE org_id=? AND page_id=?",
        [_now() - 3600, w.org_id, w.publishedPage.page_id]);
    const before = (await wiki.pageAsync(w.org_id, w.carol, w.publishedPage.page_id)).page.last_reviewed_at;
    const beforeVersionCount = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_page_version WHERE org_id=? AND page_id=?", [w.org_id, w.publishedPage.page_id]))[0].c;
    await wiki.markStillCorrectAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: w.publishedPage.page_id});
    const after = await wiki.pageAsync(w.org_id, w.carol, w.publishedPage.page_id);
    const afterVersionCount = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_page_version WHERE org_id=? AND page_id=?", [w.org_id, w.publishedPage.page_id]))[0].c;
    _check("marking still correct resets the review clock", after.page.last_reviewed_at > before, `${before} -> ${after.page.last_reviewed_at}`);
    _check("marking still correct creates no new version — the cheapest possible action", afterVersionCount == beforeVersionCount,
        `${beforeVersionCount} -> ${afterVersionCount}`);
    await _checkThrows("only the page owner can mark it still correct",
        _ => wiki.markStillCorrectAsync({org_id: w.org_id, actor_person_id: w.dave, page_id: w.publishedPage.page_id}));
}

async function _testVisibilityCeiling(w) {
    LOG.console("\n visibility — a page cannot exceed its space's ceiling\n");
    const space = await wiki.createSpaceAsync({org_id: w.org_id, actor_person_id: w.carol,
        name: "Client — Northwind", slug: `northwind-${w.stamp}`, default_visibility: "space"});
    const {page} = await _draftPage(w, space.space_id, w.carol, "Northwind guide", "northwind-guide");
    await _checkThrows("a page cannot be set more visible than its space's ceiling (space)",
        _ => wiki.changeVisibilityAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id, visibility: "org"}));
    const ok = await wiki.changeVisibilityAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id, visibility: "private"});
    _check("a page can be set below the ceiling", ok == "changed");

    // raise the space's page above the (about-to-be-lowered) ceiling, then lower the space and confirm the cascade
    await wiki.changeVisibilityAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id, visibility: "space"});
    const cascade = await wiki.changeSpaceVisibilityAsync({org_id: w.org_id, actor_person_id: w.carol,
        space_id: space.space_id, default_visibility: "private"});
    _check("lowering a space's ceiling demotes pages set above it, and names which ones",
        cascade.demoted_page_ids.includes(page.page_id), JSON.stringify(cascade.demoted_page_ids));
    const demoted = await wiki.pageAsync(w.org_id, w.carol, page.page_id);
    _check("the demoted page's own visibility now matches the new ceiling", demoted.page.visibility == "private");
}

async function _testPublicScan(w) {
    LOG.console("\n the pre-publish scan\n");
    const space = await wiki.createSpaceAsync({org_id: w.org_id, actor_person_id: w.carol,
        name: "Docs", slug: `docs-${w.stamp}`, default_visibility: "org", public_approver_person_id: w.carol});
    const {page: linkedPage} = await _draftPage(w, space.space_id, w.carol, "Internal reference", "internal-ref");
    await _publishSimple(w, linkedPage.page_id, w.carol, w.dave);

    const {page, draft} = await _draftPage(w, space.space_id, w.carol, "Public candidate", "public-candidate");
    await wiki.saveDraftVersionAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
        sections: [{heading: "Overview", body: "Clean body."}], linked_page_ids: [linkedPage.page_id], reason: "Add a link."});
    await _publishSimple(w, page.page_id, w.carol, w.dave);
    await _checkThrows("requesting public visibility blocks on a link to a non-public page",
        _ => wiki.requestPublicPublishAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: page.page_id,
            slug: `pub-${w.stamp}-a`, reason: "Share with the client."}));

    const {page: filePage} = await _draftPage(w, space.space_id, w.carol, "Has a file", "has-a-file");
    await wiki.saveDraftVersionAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: filePage.page_id,
        sections: [{heading: "Overview", body: "Clean body."}], embedded_file_refs: ["https://example.invalid/diagram.png"],
        reason: "Add a diagram."});
    await _publishSimple(w, filePage.page_id, w.carol, w.dave);
    await _checkThrows("requesting public visibility blocks on any embedded file reference — no G2 sharing state to check",
        _ => wiki.requestPublicPublishAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: filePage.page_id,
            slug: `pub-${w.stamp}-b`, reason: "Share with the client."}));

    const {page: cleanPage} = await _draftPage(w, space.space_id, w.carol, "Clean page", "clean-page");
    await _publishSimple(w, cleanPage.page_id, w.carol, w.dave);
    const request = await wiki.requestPublicPublishAsync({org_id: w.org_id, actor_person_id: w.carol,
        page_id: cleanPage.page_id, slug: `pub-${w.stamp}-c`, reason: "Share with the client."});
    _check("a page with no non-public links and no file references clears the scan and creates a request",
        request.status == "pending" && JSON.parse(request.scan_result).clear, JSON.stringify(request));

    w.publicSpace = space; w.cleanPageRequest = request; w.cleanPage = cleanPage;
}

async function _publishSimple(w, page_id, actor, reviewer) {
    const draft = (await dblayer.getQueryOrThrow(
        "SELECT * FROM wiki_page_version WHERE org_id=? AND page_id=? ORDER BY version DESC LIMIT 1", [w.org_id, page_id]))[0];
    const review = await wiki.requestReviewAsync({org_id: w.org_id, actor_person_id: actor, page_id,
        wiki_page_version_id: draft.wiki_page_version_id, reviewer_person_id: reviewer});
    await wiki.approveReviewAsync({org_id: w.org_id, actor_person_id: reviewer, review_id: review.review_id});
    return await wiki.publishPageAsync({org_id: w.org_id, actor_person_id: actor, page_id,
        wiki_page_version_id: draft.wiki_page_version_id, review_cadence_months: 6});
}

async function _testPublicApproval(w) {
    LOG.console("\n public approval — capability AND named approver, both\n");
    await _checkThrows("hr with the capability but not this space's named approver is refused",
        _ => wiki.decidePublicRequestAsync({org_id: w.org_id, actor_person_id: w.erin,
            request_id: w.cleanPageRequest.request_id, decision: "approved", step_up_verified: true}));

    // a space whose named approver is an employee — holds no wiki.publish_public at all
    const orphanSpace = await wiki.createSpaceAsync({org_id: w.org_id, actor_person_id: w.carol,
        name: "Orphan-approver space", slug: `orphan-${w.stamp}`, default_visibility: "org",
        public_approver_person_id: w.alice});
    const {page: orphanPage} = await _draftPage(w, orphanSpace.space_id, w.carol, "Orphan page", "orphan-page");
    await _publishSimple(w, orphanPage.page_id, w.carol, w.dave);
    const orphanRequest = await wiki.requestPublicPublishAsync({org_id: w.org_id, actor_person_id: w.carol,
        page_id: orphanPage.page_id, slug: `pub-${w.stamp}-orphan`, reason: "Test."});
    await _checkThrows("the named approver without wiki.publish_public is refused",
        _ => wiki.decidePublicRequestAsync({org_id: w.org_id, actor_person_id: w.alice,
            request_id: orphanRequest.request_id, decision: "approved", step_up_verified: true}));

    const queue = await wiki.pendingPublicRequestsAsync(w.org_id, w.carol);
    _check("the approver's queue lists the pending request with page/space context",
        queue.requests.some(r => r.request_id == w.cleanPageRequest.request_id && r.is_approver),
        JSON.stringify(queue.requests.map(r => r.request_id)));

    const decided = await wiki.decidePublicRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
        request_id: w.cleanPageRequest.request_id, decision: "approved", step_up_verified: true});
    _check("the named approver, holding the capability, approves successfully",
        decided.status == "approved" && decided.public_slug, JSON.stringify(decided));

    const publicRead = await wiki.publicPageBySlugAsync(w.org_id, decided.public_slug);
    _check("the page is readable at its public slug with no session", publicRead && !publicRead.unpublished, JSON.stringify(publicRead?.page?.status));

    await wiki.unpublishPublicAsync({org_id: w.org_id, actor_person_id: w.carol, page_id: w.cleanPage.page_id});
    const afterUnpublish = await wiki.publicPageBySlugAsync(w.org_id, decided.public_slug);
    _check("unpublishing keeps the slug resolving, stated as no longer published, never a 404",
        afterUnpublish && afterUnpublish.unpublished === true, JSON.stringify(afterUnpublish));
}

async function _testShareLinks(w) {
    LOG.console("\n shared links — reversible, expiring\n");
    const link = await wiki.createShareLinkAsync({org_id: w.org_id, actor_person_id: w.carol,
        page_id: w.publishedPage.page_id, recipient_name: "Client contact", expires_in_days: 14});
    const read = await wiki.readViaShareLinkAsync(link.token);
    _check("a live share link reads the page with no session", read.page.page_id == w.publishedPage.page_id);

    await dblayer.runCmdOrThrow("UPDATE wiki_share_link SET expires_at=? WHERE share_link_id=?",
        [_now() - 10, link.share_link_id]);
    await _checkThrows("an expired share link refuses", _ => wiki.readViaShareLinkAsync(link.token));

    const link2 = await wiki.createShareLinkAsync({org_id: w.org_id, actor_person_id: w.carol,
        page_id: w.publishedPage.page_id, recipient_name: "Another contact", expires_in_days: 14});
    await wiki.revokeShareLinkAsync(w.org_id, w.carol, link2.share_link_id);
    await _checkThrows("a revoked share link refuses immediately", _ => wiki.readViaShareLinkAsync(link2.token));
}

async function _testLeavePolicyRendering(w) {
    LOG.console("\n N5 — the leave policy page renders live, never a copy\n");
    await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol, effective_from: "2026-01-01",
        step_up_verified: true, policy: {scope: {jurisdiction: "IN"},
            leave_types: [{code: "EL", label: "Earned Leave — v1 label", quantum: {annual_days: 18}, approval_route: ["manager"]}]}});

    const page = await wiki.createPageDraftAsync({org_id: w.org_id, actor_person_id: w.carol,
        space_id: w.publishedSpace.space_id, title: "Leave policy — India", slug: `leave-policy-${w.stamp}`});
    await dblayer.runCmdOrThrow("UPDATE wiki_page SET source_type='leave_policy', source_ref='IN' WHERE page_id=?", [page.page_id]);
    const versionCountBefore = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_page_version WHERE org_id=? AND page_id=?", [w.org_id, page.page_id]))[0].c;

    const read1 = await wiki.pageAsync(w.org_id, w.carol, page.page_id);
    _check("the rendered page reflects the published policy's current label",
        JSON.stringify(read1.sections).includes("v1 label"), JSON.stringify(read1.sections));

    await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol, effective_from: "2026-02-01",
        step_up_verified: true, policy: {scope: {jurisdiction: "IN"},
            leave_types: [{code: "EL", label: "Earned Leave — v2 label", quantum: {annual_days: 20}, approval_route: ["manager"]}]}});
    const read2 = await wiki.pageAsync(w.org_id, w.carol, page.page_id);
    _check("re-reading after the policy republishes shows the new label with no wiki edit at all",
        JSON.stringify(read2.sections).includes("v2 label") && !JSON.stringify(read2.sections).includes("v1 label"),
        JSON.stringify(read2.sections));
    const versionCountAfter = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM wiki_page_version WHERE org_id=? AND page_id=?", [w.org_id, page.page_id]))[0].c;
    _check("no wiki_page_version was ever written for a source-rendered page",
        versionCountBefore == 0 && versionCountAfter == 0, `${versionCountBefore} -> ${versionCountAfter}`);
}

async function _testCapabilityRefusals(w) {
    LOG.console("\n capability refusals\n");
    // wiki.write is granted to every built-in role in this app, so there is no
    // "cannot write at all" role to test against — guest is the one role with
    // neither wiki.read nor wiki.write.
    await _checkThrows("a guest cannot read the wiki", _ => wiki.pageAsync(w.org_id, w.guest, w.publishedPage.page_id));
    await _checkThrows("a guest cannot create a page",
        _ => wiki.createPageDraftAsync({org_id: w.org_id, actor_person_id: w.guest, space_id: w.publishedSpace.space_id,
            title: "Should fail", slug: "should-fail"}));
    await _checkThrows("an employee cannot read the standing review report",
        _ => wiki.standingReviewReportAsync(w.org_id, w.alice));
    await _checkThrows("an employee cannot read the public-request queue",
        _ => wiki.pendingPublicRequestsAsync(w.org_id, w.alice));
    const report = await wiki.standingReviewReportAsync(w.org_id, w.carol);
    _check("hr can read the standing review report", Number.isInteger(report.public_pages));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Wiki test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {alice: "employee", carol: "hr", erin: "hr", dave: "admin", guest: "guest"};
    const people = {};
    for (const who of Object.keys(roleOf))
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of Object.entries(roleOf)) await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([name, person]) => [name, person.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["wiki_acknowledgement", "wiki_page_task_link", "wiki_share_link", "wiki_public_request",
        "wiki_review", "wiki_page_version", "wiki_page_pointer", "wiki_page", "wiki_space_member", "wiki_space",
        "leave_policy_version", "leave_policy_pointer", "audit_event"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "carol", "erin", "dave", "guest"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
