/**
 * N — wiki & documentation. Browse (spaces, search, the page drawer — view
 * and, for the owner, edit/review/publish/visibility) is everyone's tab
 * (wiki.read/wiki.write, every built-in role); Public requests and
 * Standing review only appear with wiki.publish_public — same
 * per-capability internal tabbing every other multi-tab screen this
 * session already established.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "wiki";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _myId = _ => session.get(APP_CONSTANTS.USERID)?.toString();

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, tab: "browse", canPublishPublic: caps.includes("wiki.publish_public"),
        spaces: null, selectedSpaceId: null, selectedPageId: null, pageData: null,
        editMode: false, draftSections: null, searchQuery: "", newSpaceOpen: false, newPageOpen: false,
        shareOpen: false, publicRequestOpen: false};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "browse" ? " on" : ""}" data-wk="tab" data-tab="browse">Browse</button>
            ${state.canPublishPublic ? `<button class="tr-tab${state.tab == "requests" ? " on" : ""}" data-wk="tab" data-tab="requests">Public requests</button>` : ""}
            ${state.canPublishPublic ? `<button class="tr-tab${state.tab == "review" ? " on" : ""}" data-wk="tab" data-tab="review">Standing review</button>` : ""}
        </div>
        <div class="tr-view" id="wk-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-wk=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#wk-view");
    try {
        if (state.tab == "requests" && state.canPublishPublic) return await _requests(view);
        if (state.tab == "review" && state.canPublishPublic) return await _standingReview(view);
        return await _browse(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load the wiki", what: err.message,
            safe: "Nothing you have written is affected.", reference: `N-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// Browse — spaces, search, page list, the page drawer
// ---------------------------------------------------------------------------

async function _browse(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const spacesResponse = await _rest("spaces");
    if (!spacesResponse) return;
    state.spaces = spacesResponse.spaces; state.templates = spacesResponse.templates;
    if (!state.selectedSpaceId && state.spaces.length) state.selectedSpaceId = state.spaces[0].space_id;

    const search = await _rest("search", {space_id: state.selectedSpaceId || undefined, q: state.searchQuery || undefined});
    _renderBrowse(root, search?.pages || []);
}

function _renderBrowse(root, pages) {
    root.innerHTML = `
        <div class="row wrap">
            <select class="inp" id="wk-space-select">
                ${state.spaces.map(s => `<option value="${states.esc(s.space_id)}"${
                    s.space_id == state.selectedSpaceId ? " selected" : ""}>${states.esc(s.name)}</option>`).join("")}
            </select>
            <input class="inp" id="wk-search" placeholder="Search this space…" value="${states.esc(state.searchQuery)}" style="width:220px">
            <button class="btn pri push" data-wk="new-space">${state.newSpaceOpen ? "Close" : "+ New space"}</button>
            <button class="btn" data-wk="new-page">${state.newPageOpen ? "Close" : "+ New page"}</button>
        </div>
        ${state.newSpaceOpen ? _newSpaceHtml() : ""}
        ${state.newPageOpen ? _newPageHtml() : ""}

        <div class="tr-card" style="margin-top:10px">
            ${pages.length ? pages.map(page => `<div class="tr-track-row" data-wk="open-page" data-page="${states.esc(page.page_id)}" style="cursor:pointer">
                <span class="grow"><b>${states.esc(page.title)}</b>
                    ${page.status == "deprecated" ? ` <span class="sm t3">— deprecated</span>` : ""}
                    <br><span class="sm t3">${states.esc(page.owner_person_id ? "" : "no owner · ")}${
                        states.esc(page.visibility || "inherits space")} · ${states.esc(page.status)}</span></span>
            </div>`).join("") : `<div class="tr-empty">No pages here yet.</div>`}
        </div>
        <div id="wk-drawer"></div>`;

    root.querySelector("#wk-space-select").addEventListener("change", event => {
        state.selectedSpaceId = event.target.value; state.selectedPageId = null; _browse(root);});
    root.querySelector("#wk-search").addEventListener("change", event => {
        state.searchQuery = event.target.value; _browse(root);});
    root.querySelector("[data-wk=\"new-space\"]").addEventListener("click", _ => {
        state.newSpaceOpen = !state.newSpaceOpen; state.newPageOpen = false; _renderBrowse(root, pages);});
    root.querySelector("[data-wk=\"new-page\"]").addEventListener("click", _ => {
        state.newPageOpen = !state.newPageOpen; state.newSpaceOpen = false; _renderBrowse(root, pages);});
    if (state.newSpaceOpen) _wireNewSpace(root, pages);
    if (state.newPageOpen) _wireNewPage(root, pages);
    for (const row of root.querySelectorAll("[data-wk=\"open-page\"]")) row.addEventListener("click", _ => {
        state.selectedPageId = row.getAttribute("data-page"); state.editMode = false; state.shareOpen = false;
        state.publicRequestOpen = false; _renderDrawer(root);
    });
    if (state.selectedPageId) _renderDrawer(root);
}

const _newSpaceHtml = _ => `<div class="tr-card" style="margin-top:10px">
    <div class="up t3">New space</div>
    <div class="row wrap" style="gap:6px;margin-top:6px">
        <input class="inp" id="wk-space-name" placeholder="Name">
        <input class="inp" id="wk-space-slug" placeholder="slug-like-this" style="width:160px">
        <select class="inp" id="wk-space-visibility">
            <option value="space">space members</option><option value="private">private</option><option value="org">whole org</option>
        </select>
        <button class="btn pri" data-wk="do-new-space">Create</button>
    </div>
</div>`;

function _wireNewSpace(root, pages) {
    root.querySelector("[data-wk=\"do-new-space\"]").addEventListener("click", async _ => {
        const name = root.querySelector("#wk-space-name").value.trim();
        const slug = root.querySelector("#wk-space-slug").value.trim();
        const default_visibility = root.querySelector("#wk-space-visibility").value;
        if (!name || !slug) return;
        const result = await _rest("create_space", {name, slug, default_visibility});
        if (result) {states.toast({message: "Space created."}); state.newSpaceOpen = false;
            state.selectedSpaceId = result.space_id; await _browse(root);}
    });
}

const _newPageHtml = _ => `<div class="tr-card" style="margin-top:10px">
    <div class="up t3">New page</div>
    <div class="row wrap" style="gap:6px;margin-top:6px">
        <input class="inp" id="wk-page-title" placeholder="Title">
        <input class="inp" id="wk-page-slug" placeholder="slug-like-this" style="width:160px">
        <button class="btn pri" data-wk="do-new-page">Create draft</button>
    </div>
    <div class="sm t3" style="margin-top:6px">Templates: ${(state.templates||[]).join(" · ")}</div>
</div>`;

function _wireNewPage(root, pages) {
    root.querySelector("[data-wk=\"do-new-page\"]").addEventListener("click", async _ => {
        const title = root.querySelector("#wk-page-title").value.trim();
        const slug = root.querySelector("#wk-page-slug").value.trim();
        if (!title || !slug || !state.selectedSpaceId) return;
        const result = await _rest("create_page", {space_id: state.selectedSpaceId, title, slug});
        if (result) {states.toast({message: "Draft created."}); state.newPageOpen = false;
            state.selectedPageId = result.page_id; state.editMode = true; await _browse(root);}
    });
}

// ---------------------------------------------------------------------------
// the page drawer — view, and for the owner, edit/review/publish/visibility
// ---------------------------------------------------------------------------

async function _renderDrawer(root) {
    const drawer = root.querySelector("#wk-drawer");
    drawer.innerHTML = states.loading({rows: 3});
    const data = await _rest("page", {page_id: state.selectedPageId});
    if (!data) {drawer.innerHTML = ""; return;}
    state.pageData = data;
    const [tasks, shares] = await Promise.all([
        _rest("tasks_for_page", {page_id: state.selectedPageId}),
        data.page.owner_person_id == _myId() ? _rest("share_links", {page_id: state.selectedPageId}) : null]);
    _paintDrawer(drawer, data, tasks?.task_refs || [], shares?.links || []);
}

function _paintDrawer(drawer, data, taskRefs, shares) {
    const page = data.page, space = data.space, isOwner = page.owner_person_id == _myId();
    drawer.innerHTML = `<div class="tr-card" style="margin-top:10px">
        <div class="row wrap">
            <div><div class="up t3">${states.esc(page.title)}</div>
                <span class="sm t3">${states.esc(space.name)} · ${states.esc(page.status)} · ${
                    states.esc(page.visibility || `inherits ${space.default_visibility}`)}${
                    page.owner_person_id ? "" : " · no owner"}</span></div>
            <div class="push row wrap" style="gap:6px">
                ${isOwner && page.status != "archived" && page.status != "deprecated" ?
                    `<button class="btn" data-wk="toggle-edit">${state.editMode ? "View" : "Edit"}</button>` : ""}
                ${isOwner ? `<button class="btn" data-wk="still-correct" style="padding:3px 7px">Still correct</button>` : ""}
            </div>
        </div>

        ${state.editMode ? _editorHtml(data) : _viewerHtml(data)}

        <div class="sm t3" style="margin-top:8px">Reviewed ${page.last_reviewed_at ?
            new Date(page.last_reviewed_at*1000).toLocaleDateString() : "never"} by ${states.esc(page.last_reviewed_by || "—")}
            · review every ${page.review_cadence_months || "—"} month(s)</div>

        ${taskRefs.length ? `<div class="sm t3" style="margin-top:6px">Linked tasks: ${taskRefs.map(t => states.esc(t)).join(", ")}</div>` : ""}

        ${isOwner ? _ownerControlsHtml(page, shares) : ""}
    </div>`;

    drawer.querySelector("[data-wk=\"toggle-edit\"]")?.addEventListener("click", _ => {
        state.editMode = !state.editMode; _paintDrawer(drawer, data, taskRefs, shares);});
    drawer.querySelector("[data-wk=\"still-correct\"]")?.addEventListener("click", async _ => {
        const result = await _rest("mark_still_correct", {page_id: page.page_id});
        if (result) {states.toast({message: "Marked still correct."}); await _renderDrawer(drawer.closest(".tr-view") || drawer.parentElement);}
    });
    if (state.editMode) _wireEditor(drawer, data);
    if (isOwner) _wireOwnerControls(drawer, page, shares);
}

const _viewerHtml = data => `<div style="margin-top:8px">
    ${data.sections.map(s => `<div class="up t3" style="margin-top:8px">${states.esc(s.heading)}</div>
        <div class="sm" style="white-space:pre-wrap">${states.esc(s.body)}</div>`).join("")}
    ${!data.sections.length ? `<div class="tr-empty">No content yet.</div>` : ""}
</div>`;

function _editorHtml(data) {
    if (!state.draftSections) state.draftSections = data.sections.length ? data.sections.map(s => ({...s})) : [{heading: "", body: ""}];
    return `<div style="margin-top:8px" id="wk-sections">
        ${state.draftSections.map((s, i) => `<div class="row wrap" style="margin-top:6px;align-items:flex-start">
            <input class="inp" data-wk-heading="${i}" placeholder="Heading" value="${states.esc(s.heading)}" style="width:200px">
            <textarea class="inp grow" data-wk-body="${i}" placeholder="Body" rows="3">${states.esc(s.body)}</textarea>
            <button class="btn" data-wk="remove-section" data-i="${i}" style="padding:3px 7px">Remove</button>
        </div>`).join("")}
        <button class="btn" data-wk="add-section" style="margin-top:6px">+ Section</button>
        <div class="row wrap" style="margin-top:8px;gap:6px">
            <input class="inp grow" id="wk-save-reason" placeholder="Reason for this change">
            <button class="btn pri" data-wk="save-draft">Save draft</button>
        </div>
    </div>`;
}

function _wireEditor(drawer, data) {
    const container = drawer.querySelector("#wk-sections");
    for (const input of container.querySelectorAll("[data-wk-heading]"))
        input.addEventListener("input", e => state.draftSections[Number(e.target.getAttribute("data-wk-heading"))].heading = e.target.value);
    for (const textarea of container.querySelectorAll("[data-wk-body]"))
        textarea.addEventListener("input", e => state.draftSections[Number(e.target.getAttribute("data-wk-body"))].body = e.target.value);
    for (const button of container.querySelectorAll("[data-wk=\"remove-section\"]"))
        button.addEventListener("click", _ => {state.draftSections.splice(Number(button.getAttribute("data-i")), 1); _renderDrawer(drawer.closest(".tr-view") || drawer.parentElement);});
    container.querySelector("[data-wk=\"add-section\"]").addEventListener("click", _ => {
        state.draftSections.push({heading: "", body: ""}); _renderDrawer(drawer.closest(".tr-view") || drawer.parentElement);});
    container.querySelector("[data-wk=\"save-draft\"]").addEventListener("click", async _ => {
        const reason = drawer.querySelector("#wk-save-reason")?.value;
        const result = await _rest("save_draft", {page_id: data.page.page_id, sections: state.draftSections, reason});
        if (result) {states.toast({message: `Draft v${result.version} saved.`}); state.draftSections = null; state.editMode = false;
            await _renderDrawer(drawer.closest(".tr-view") || drawer.parentElement);}
    });
}

function _ownerControlsHtml(page, shares) {
    return `<div class="row wrap" style="margin-top:10px;gap:6px;border-top:1px solid var(--stroke);padding-top:8px">
        ${page.status != "published" ? `<select class="inp" id="wk-cadence" style="width:150px">
            <option value="3">review every 3mo</option><option value="6">review every 6mo</option><option value="12">review every 12mo</option>
        </select><button class="btn pri" data-wk="publish">Publish</button>` : ""}
        ${page.status == "published" ? `<button class="btn" data-wk="change-vis">Change visibility</button>` : ""}
        ${page.status == "published" && page.visibility != "public" ? `<button class="btn" data-wk="request-public">Request public…</button>` : ""}
        ${page.visibility == "public" ? `<button class="btn danger" data-wk="unpublish-public">Unpublish (irreversible copies may remain)</button>` : ""}
        <button class="btn" data-wk="share">Share a link…</button>
        <button class="btn" data-wk="archive">Archive</button>
    </div>
    ${state.shareOpen ? _shareHtml(shares) : ""}
    ${state.publicRequestOpen ? _publicRequestHtml() : ""}`;
}

function _shareHtml(shares) {
    return `<div class="tr-card" style="margin-top:8px">
        <div class="up t3">Share a link</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="wk-share-name" placeholder="Recipient name">
            <button class="btn pri" data-wk="do-share">Create link</button>
        </div>
        ${shares.map(s => `<div class="tr-track-row"><span class="grow">${states.esc(s.recipient_name)}${
            s.revoked_at ? " (revoked)" : ""}</span>
            <span class="sm t3">expires ${new Date(s.expires_at*1000).toLocaleDateString()}</span>
            ${!s.revoked_at ? `<button class="btn" data-wk="revoke-share" data-id="${states.esc(s.share_link_id)}" style="padding:3px 7px">Revoke</button>` : ""}
        </div>`).join("")}
    </div>`;
}

function _publicRequestHtml() {
    return `<div class="tr-card" style="margin-top:8px">
        <div class="up t3">Request public visibility</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="wk-public-slug" placeholder="public-url-slug">
            <input class="inp grow" id="wk-public-reason" placeholder="Reason">
            <label class="sm t3"><input type="checkbox" id="wk-public-indexing"> allow search engines</label>
            <button class="btn pri" data-wk="do-request-public">Submit</button>
        </div>
        <div class="sm t3" style="margin-top:6px">The scan runs on submit — a link to a non-public page or any embedded file reference blocks it.</div>
    </div>`;
}

function _wireOwnerControls(drawer, page, shares) {
    const rerender = _ => _renderDrawer(drawer.closest(".tr-view") || drawer.parentElement);
    drawer.querySelector("[data-wk=\"publish\"]")?.addEventListener("click", async _ => {
        const cadence = Number(drawer.querySelector("#wk-cadence")?.value || 3);
        if (!state.pageData.latest_version_id) {states.toast({message: "Save a draft before publishing."}); return;}
        const result = await _rest("publish_page", {page_id: page.page_id,
            wiki_page_version_id: state.pageData.latest_version_id, review_cadence_months: cadence});
        if (result) {states.toast({message: "Published."}); await rerender();}
    });
    drawer.querySelector("[data-wk=\"change-vis\"]")?.addEventListener("click", async _ => {
        const level = prompt("Set visibility to private, space or org:");
        if (!level) return;
        const result = await _rest("change_visibility", {page_id: page.page_id, visibility: level});
        if (result) {states.toast({message: "Visibility changed."}); await rerender();}
    });
    drawer.querySelector("[data-wk=\"request-public\"]")?.addEventListener("click", _ => {
        state.publicRequestOpen = !state.publicRequestOpen; state.shareOpen = false; rerender();});
    drawer.querySelector("[data-wk=\"do-request-public\"]")?.addEventListener("click", async _ => {
        const slug = drawer.querySelector("#wk-public-slug")?.value.trim();
        const reason = drawer.querySelector("#wk-public-reason")?.value.trim();
        const allow_indexing = drawer.querySelector("#wk-public-indexing")?.checked;
        if (!slug || !reason) return;
        const result = await _rest("request_public_publish", {page_id: page.page_id, slug, reason, allow_indexing});
        if (result) {states.toast({message: "Request submitted for approval."}); state.publicRequestOpen = false; await rerender();}
    });
    drawer.querySelector("[data-wk=\"unpublish-public\"]")?.addEventListener("click", async _ => {
        if (!confirm("This page will stop being served publicly. Copies already made (search caches, archives) are not removed. Continue?")) return;
        const result = await _rest("unpublish_public", {page_id: page.page_id});
        if (result) {states.toast({message: "Unpublished."}); await rerender();}
    });
    drawer.querySelector("[data-wk=\"share\"]")?.addEventListener("click", _ => {
        state.shareOpen = !state.shareOpen; state.publicRequestOpen = false; rerender();});
    drawer.querySelector("[data-wk=\"do-share\"]")?.addEventListener("click", async _ => {
        const recipient_name = drawer.querySelector("#wk-share-name")?.value.trim();
        if (!recipient_name) return;
        const result = await _rest("create_share_link", {page_id: page.page_id, recipient_name});
        if (result) {states.toast({message: "Link created."}); await rerender();}
    });
    for (const button of drawer.querySelectorAll("[data-wk=\"revoke-share\"]")) button.addEventListener("click", async _ => {
        const result = await _rest("revoke_share_link", {share_link_id: button.getAttribute("data-id")});
        if (result) {states.toast({message: "Revoked."}); await rerender();}
    });
    drawer.querySelector("[data-wk=\"archive\"]")?.addEventListener("click", async _ => {
        const reason = prompt("Reason for archiving:");
        if (!reason) return;
        const result = await _rest("archive_page", {page_id: page.page_id, reason});
        if (result) {states.toast({message: "Archived."}); state.selectedPageId = null; await _view();}
    });
}

// ---------------------------------------------------------------------------
// Public requests (hr/admin) and Standing review
// ---------------------------------------------------------------------------

async function _requests(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("pending_public_requests");
    if (!result) return;
    _renderRequests(root, result.requests);
}

function _renderRequests(root, requests) {
    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Pending public-publish requests</div>
        ${requests.length ? requests.map(r => `<div class="tr-track-row" style="align-items:flex-start;flex-direction:column;gap:4px">
            <div class="row wrap" style="width:100%">
                <span class="grow"><b>${states.esc(r.page_title || r.page_id)}</b> — ${states.esc(r.space_name || "")}
                    <br><span class="sm t3">Requested: ${states.esc(r.reason)} · slug: ${states.esc(r.slug)}</span></span>
                ${!r.is_approver ? `<span class="sm t3">not this space's approver</span>` : ""}
            </div>
            <div class="sm t3">Scan — blocks: ${r.scan_result.blocks.length ? r.scan_result.blocks.join("; ") : "none"}${
                r.scan_result.warnings.length ? ` · warns: ${r.scan_result.warnings.join("; ")}` : ""}</div>
            ${r.is_approver ? `<div class="row wrap" style="gap:6px">
                <label class="sm t3"><input type="checkbox" data-wk="step-up" data-id="${states.esc(r.request_id)}"> I have re-authenticated for this approval</label>
                <button class="btn pri" data-wk="approve" data-id="${states.esc(r.request_id)}" style="padding:3px 7px">Approve</button>
                <button class="btn" data-wk="decline" data-id="${states.esc(r.request_id)}" style="padding:3px 7px">Decline</button>
            </div>` : ""}
        </div>`).join("") : `<div class="tr-empty">No pending requests.</div>`}
    </div>`;

    for (const button of root.querySelectorAll("[data-wk=\"approve\"]")) button.addEventListener("click", async _ => {
        const id = button.getAttribute("data-id");
        const step_up_verified = root.querySelector(`[data-wk="step-up"][data-id="${id}"]`)?.checked;
        if (!step_up_verified) {states.toast({message: "Confirm re-authentication before approving — this is irreversible."}); return;}
        const result = await _rest("decide_public_request", {request_id: id, decision: "approved", step_up_verified: true});
        if (result) {states.toast({message: `Published — ${result.public_slug}.`}); await _requests(root);}
    });
    for (const button of root.querySelectorAll("[data-wk=\"decline\"]")) button.addEventListener("click", async _ => {
        const decision_reason = prompt("Reason for declining:");
        if (!decision_reason) return;
        const result = await _rest("decide_public_request", {request_id: button.getAttribute("data-id"), decision: "declined", decision_reason});
        if (result) {states.toast({message: "Declined."}); await _requests(root);}
    });
}

async function _standingReview(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const report = await _rest("standing_review");
    if (!report) return;
    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Standing review — external exposure</div>
        <div class="tr-track-row"><span class="grow">Public pages</span><span class="sm t3">${report.public_pages}</span></div>
        <div class="tr-track-row"><span class="grow">Shared links live</span><span class="sm t3">${report.share_links_live}</span></div>
        <div class="tr-track-row"><span class="grow">Links past expiry, still enabled</span>
            <span class="sm" style="color:${report.links_past_expiry_still_enabled ? "var(--ember)" : "var(--mint)"}">${report.links_past_expiry_still_enabled}</span></div>
        <div class="tr-track-row"><span class="grow">Public pages not reviewed in 12 months</span>
            <span class="sm" style="color:${report.public_pages_not_reviewed_12m ? "var(--ember)" : "var(--mint)"}">${report.public_pages_not_reviewed_12m}</span></div>
        <div class="sm t3" style="margin-top:6px">External exposure needs a standing report or it accumulates silently.</div>
    </div>`;
}

// ---------------------------------------------------------------------------

const _rest = (op, extra = {}) => _call(API, op, extra);

async function _call(api, op, extra = {}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${api}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`${api} op ${op} failed: ${err}`);}
    if (!response?.result) {
        states.toast({message: response?.reason || `The ${api} service did not respond.`, ms: 8000});
        return null;
    }
    return response;
}
