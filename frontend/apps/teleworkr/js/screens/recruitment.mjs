/**
 * K — recruitment, Phase 1: the pipeline core. Requisitions (K3), workflows
 * (K1/K2), and the pipeline board with the candidate drawer and scorecards
 * (K4/K5/K7). HR/admin only in this phase — see lib/recruitment.js's header
 * for the full list of what Phase 1 deliberately narrows.
 *
 * The engine is the source of truth for what can happen next: every action
 * button here is built from `legal_actions`, not guessed at by this screen,
 * so a disabled control always carries the engine's own reason (K4/K7's
 * "never a greyed control with no explanation").
 *
 * K6 panel scheduling lives in the candidate drawer, per open round. The
 * availability strip is the calendar API's own E3 board (leave wired in),
 * drawn in the candidate's timezone by default — they are the one person
 * who can't see anyone else's calendar. The strip is a guide; the server
 * re-checks every slot against the same board and names each misfit.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "recruitment", API_CALENDAR = "calendar";   // availability is the calendar API's E3 board, not ours
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _draftId = _ => Math.random().toString(36).slice(2, 10);

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, tab: "requisitions",
        canPublishWorkflow: caps.includes("workflow.publish"), canCreate: caps.includes("requisition.create"),
        canApprove: caps.includes("requisition.approve"), canRecord: caps.includes("stage_transition.record"),
        canScore: caps.includes("scorecard.submit"), canSchedule: caps.includes("panel.schedule"),
        composerOpen: false, workflowDraft: null, requisitionDraft: null,
        selectedRequisitionId: null, selectedApplicationId: null, addCandidateOpen: false,
        reschedulingPanelId: null, roster: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "requisitions" ? " on" : ""}" data-rc="tab" data-tab="requisitions">Requisitions</button>
            <button class="tr-tab${state.tab == "workflows" ? " on" : ""}" data-rc="tab" data-tab="workflows">Workflows</button>
            <button class="tr-tab${state.tab == "pipeline" ? " on" : ""}" data-rc="tab" data-tab="pipeline">Pipeline</button>
        </div>
        <div class="tr-view" id="rc-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-rc=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#rc-view");
    try {
        if (state.tab == "workflows") return await _workflows(view);
        if (state.tab == "pipeline") return await _pipeline(view);
        return await _requisitions(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load recruitment",
            what: err.message, safe: "Nothing you have recorded is affected.",
            reference: `K-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// K3 — requisitions
// ---------------------------------------------------------------------------

async function _requisitions(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const response = await _rest("requisitions");
    if (!response) return;
    const workflows = state.canCreate ? await _rest("workflows") : null;
    _renderRequisitions(root, response, workflows);
}

function _renderRequisitions(root, response, workflows) {
    root.innerHTML = `
        <div class="row"><span class="tr-band-title"><span class="code">Requisitions</span></span>
            ${state.canCreate ? `<button class="btn pri push" data-rc="new-req">${
                state.composerOpen ? "Close" : "+ New requisition"}</button>` : ""}</div>
        <div class="tr-card" style="padding:0">
            ${response.requisitions.length ? response.requisitions.map(_requisitionRow).join("") :
                `<div class="tr-empty">No requisitions raised yet.</div>`}
        </div>
        ${state.composerOpen && state.canCreate ? _requisitionComposerHtml(state.requisitionDraft, response, workflows) : ""}`;

    root.querySelector("[data-rc=\"new-req\"]")?.addEventListener("click", _ => {
        if (!state.composerOpen) state.requisitionDraft = _blankRequisitionDraft();
        state.composerOpen = !state.composerOpen; _renderRequisitions(root, response, workflows);
    });

    for (const row of root.querySelectorAll("[data-req-row]")) {
        const requisitionId = row.getAttribute("data-req-row");
        row.querySelector("[data-rc=\"approve\"]")?.addEventListener("click", async _ => {
            const result = await _rest("approve_requisition", {requisition_id: requisitionId});
            if (!result) return;
            states.toast({message: "Requisition approved."}); await _requisitions(root);
        });
        row.querySelector("[data-rc=\"open-pipeline\"]")?.addEventListener("click", _ => {
            state.tab = "pipeline"; state.selectedRequisitionId = requisitionId;
            state.selectedApplicationId = null; _view();
        });
    }

    if (state.composerOpen && state.canCreate) _wireRequisitionComposer(root, response, workflows);
}

const _requisitionRow = requisition => `
    <div class="tr-track-row sv-manage-row" data-req-row="${states.esc(requisition.requisition_id)}">
        <span class="grow"><b>${states.esc(requisition.title)}</b> ·
            <span class="chip">${states.esc(requisition.status.replace(/_/g, " "))}</span></span>
        <span class="sm t3">${states.esc(requisition.team || "—")} · ${requisition.positions} position${
            requisition.positions == 1 ? "" : "s"} · ${states.esc(requisition.band || "no band")} ·
            target start ${states.esc(requisition.target_start)} · ${requisition.applicants} applicant${
                requisition.applicants == 1 ? "" : "s"}</span>
        <span class="sv-manage-actions">
            ${requisition.status == "pending_approval" && state.canApprove ?
                `<button class="btn sm pri" data-rc="approve">Approve</button>` : ""}
            ${requisition.status == "approved" ? `<button class="btn sm" data-rc="open-pipeline">Open pipeline</button>` : ""}
        </span>
    </div>`;

function _blankRequisitionDraft() {
    return {title: "", team: "", positions: 1, req_type: "new", location: "", employment_type: "", band: "",
        target_start: "", workflow_code: ""};
}

function _requisitionComposerHtml(draft, response, workflows) {
    return `<div class="tr-card">
        <div class="tr-card-top">
            <div class="grow"><h2 style="font-size:16px">New requisition</h2>
                <p class="sm t2">Headcount, band and the workflow chosen up front.</p></div>
        </div>
        <div class="row wrap">
            <input class="inp grow" id="rq-title" placeholder="Role title" value="${states.esc(draft.title)}">
            <input class="inp" id="rq-team" placeholder="Team" style="width:150px" value="${states.esc(draft.team)}">
            <input class="inp" id="rq-positions" type="number" min="1" placeholder="positions" style="width:100px" value="${draft.positions}">
            <select class="inp" id="rq-type">
                ${response.req_types.map(t => `<option value="${t}"${draft.req_type == t ? " selected" : ""}>${t}</option>`).join("")}
            </select>
        </div>
        <div class="row wrap">
            <input class="inp" id="rq-location" placeholder="Location" style="width:170px" value="${states.esc(draft.location)}">
            <input class="inp" id="rq-employment" placeholder="Employment type" style="width:170px" value="${states.esc(draft.employment_type)}">
            <input class="inp" id="rq-band" placeholder="Band" style="width:110px" value="${states.esc(draft.band)}">
            <input class="inp" id="rq-start" type="date" style="width:160px" value="${draft.target_start}">
        </div>
        <div class="row">
            <select class="inp grow" id="rq-workflow">
                <option value="">Select a workflow…</option>
                ${(workflows?.workflows || []).map(wf => `<option value="${states.esc(wf.workflow_code)}"${
                    draft.workflow_code == wf.workflow_code ? " selected" : ""}>${states.esc(wf.title)} (v${wf.version})</option>`).join("")}
            </select>
            <button class="btn pri" data-rc="raise">Raise requisition</button>
        </div>
        ${!workflows?.workflows?.length ? `<span class="sm t3">No workflows published yet — publish one on the Workflows tab first.</span>` : ""}
    </div>`;
}

function _wireRequisitionComposer(root, response, workflows) {
    root.querySelector("[data-rc=\"raise\"]")?.addEventListener("click", async _ => {
        const d = state.requisitionDraft;
        d.title = root.querySelector("#rq-title").value;
        d.team = root.querySelector("#rq-team").value;
        d.positions = Number(root.querySelector("#rq-positions").value) || 1;
        d.req_type = root.querySelector("#rq-type").value;
        d.location = root.querySelector("#rq-location").value;
        d.employment_type = root.querySelector("#rq-employment").value;
        d.band = root.querySelector("#rq-band").value;
        d.target_start = root.querySelector("#rq-start").value;
        d.workflow_code = root.querySelector("#rq-workflow").value;
        if (!d.title.trim()) {states.toast({message: "A requisition needs a title."}); return;}
        if (!d.workflow_code) {states.toast({message: "Pick a workflow."}); return;}
        if (!d.target_start) {states.toast({message: "A requisition needs a target start date."}); return;}

        const result = await _rest("raise_requisition", d);
        if (!result) return;
        states.toast({message: "Requisition raised — pending approval."});
        state.requisitionDraft = _blankRequisitionDraft(); state.composerOpen = false;
        await _requisitions(root);
    });
}

// ---------------------------------------------------------------------------
// K1/K2 — workflows
// ---------------------------------------------------------------------------

async function _workflows(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const response = await _rest("workflows");
    if (!response) return;
    if (!state.workflowDraft) state.workflowDraft = _blankWorkflowDraft();
    _renderWorkflows(root, response);
}

function _renderWorkflows(root, response) {
    root.innerHTML = `
        <div class="row"><span class="tr-band-title"><span class="code">Workflows</span></span>
            ${state.canPublishWorkflow ? `<button class="btn pri push" data-rc="new-wf">${
                state.composerOpen ? "Close" : "+ New workflow"}</button></div>` : `</div>`}
        <div class="tr-card" style="padding:0">
            ${response.workflows.length ? response.workflows.map(_workflowRow).join("") :
                `<div class="tr-empty">No workflows published yet.</div>`}
        </div>
        ${state.composerOpen && state.canPublishWorkflow ? _workflowComposerHtml(state.workflowDraft) : ""}`;

    root.querySelector("[data-rc=\"new-wf\"]")?.addEventListener("click", _ => {
        state.composerOpen = !state.composerOpen; _renderWorkflows(root, response);});

    for (const row of root.querySelectorAll("[data-wf-row]"))
        row.querySelector("[data-rc=\"new-version\"]")?.addEventListener("click", _ => {
            const code = row.getAttribute("data-wf-row");
            const existing = response.workflows.find(wf => wf.workflow_code == code);
            state.workflowDraft = _blankWorkflowDraft();
            if (existing) {
                state.workflowDraft.workflow_code = existing.workflow_code;
                state.workflowDraft.title = existing.title;
                state.workflowDraft.job_family = existing.job_family || "";
            }
            state.composerOpen = true; _renderWorkflows(root, response);
        });

    if (state.composerOpen && state.canPublishWorkflow) _wireWorkflowComposer(root, response);
}

const _workflowRow = workflow => `
    <div class="tr-track-row sv-manage-row" data-wf-row="${states.esc(workflow.workflow_code)}">
        <span class="grow"><b>${states.esc(workflow.title)}</b> · v${workflow.version}${
            workflow.job_family ? ` · <span class="chip">${states.esc(workflow.job_family)}</span>` : ""}</span>
        <span class="sm t3">${states.esc(workflow.workflow_code)} · ${workflow.rounds.length} round${
            workflow.rounds.length == 1 ? "" : "s"}</span>
        <span class="sv-manage-actions">
            ${state.canPublishWorkflow ? `<button class="btn sm" data-rc="new-version">New version</button>` : ""}
        </span>
    </div>`;

function _blankWorkflowDraft() {
    return {title: "", workflow_code: "", job_family: "", rounds: [_blankRound(1)]};
}
const _blankRound = sequence => ({draftId: _draftId(), title: "", round_type: "", sequence, parallel_group: "",
    owner_role: "", sla_days: 2, optional: false, skip_role: "", criteria: [""],
    conditional: false, condition_round_draft_id: "", condition_operator: "<", condition_value: 3});

function _workflowComposerHtml(draft) {
    return `<div class="tr-card">
        <div class="tr-card-top">
            <div class="grow"><h2 style="font-size:16px">New workflow version</h2>
                <p class="sm t2">Rounds, sequence, and — for a scored round — its criteria.</p></div>
        </div>
        <div class="row wrap">
            <input class="inp grow" id="wf-title" placeholder="Title" value="${states.esc(draft.title)}">
            <input class="inp" id="wf-code" placeholder="workflow-code" style="width:180px" value="${states.esc(draft.workflow_code)}">
            <input class="inp" id="wf-family" placeholder="Job family (e.g. Engineering)" style="width:220px" value="${states.esc(draft.job_family)}">
        </div>
        <div class="up t3">Rounds</div>
        ${draft.rounds.map(round => _roundHtml(round, draft.rounds)).join("")}
        <button class="btn sm" data-rc="add-round">+ Round</button>
        <div class="row"><button class="btn pri push" data-rc="publish-wf">Publish…</button></div>
    </div>`;
}

function _roundHtml(round, allRounds) {
    const earlier = allRounds.filter(r => r.draftId != round.draftId && Number(r.sequence) < Number(round.sequence));
    return `<div class="build-section" data-round="${round.draftId}">
        <div class="row wrap">
            <input class="inp grow" placeholder="Round title" data-r-title value="${states.esc(round.title)}">
            <input class="inp" placeholder="Round type" style="width:150px" data-r-type value="${states.esc(round.round_type)}">
            <input class="inp" type="number" min="1" step="1" placeholder="sequence" style="width:100px" data-r-sequence value="${round.sequence}">
            <input class="inp" placeholder="parallel group (optional)" style="width:170px" data-r-parallel value="${states.esc(round.parallel_group)}">
            <button class="btn sm" data-rc="remove-round">Remove round</button>
        </div>
        <div class="row wrap">
            <input class="inp" placeholder="Owner role" style="width:150px" data-r-owner value="${states.esc(round.owner_role)}">
            <input class="inp" type="number" min="0" placeholder="SLA (days)" style="width:120px" data-r-sla value="${round.sla_days}">
            <label class="build-check"><input type="checkbox" data-r-optional${round.optional ? " checked" : ""}> optional</label>
            ${round.optional ? `<input class="inp grow" placeholder="Skip authoriser role" data-r-skip value="${states.esc(round.skip_role)}">` : ""}
        </div>

        <div class="build-q">
            <div class="sm t3">Scorecard criteria — leave empty for a read-and-acknowledge round</div>
            ${round.criteria.map((label, ci) => `<div class="row" data-c="${ci}">
                <input class="inp grow" placeholder="Criterion" data-r-criterion value="${states.esc(label)}">
                ${round.criteria.length > 1 ? `<button class="btn sm" data-rc="remove-criterion">×</button>` : ""}
            </div>`).join("")}
            <button class="btn sm" data-rc="add-criterion">+ Criterion</button>
        </div>

        <div class="build-q">
            <label class="build-check"><input type="checkbox" data-r-conditional${round.conditional ? " checked" : ""}>
                conditional on an earlier round's score</label>
            ${round.conditional ? `<div class="row wrap">
                <select class="inp" data-r-cond-round>
                    <option value="">— earlier round —</option>
                    ${earlier.map(r => `<option value="${r.draftId}"${round.condition_round_draft_id == r.draftId ? " selected" : ""}>${
                        states.esc(r.title || "(untitled)")}</option>`).join("")}
                </select>
                <select class="inp" data-r-cond-op style="width:80px">
                    ${["<", "<=", ">", ">=", "=="].map(op => `<option value="${op}"${round.condition_operator == op ? " selected" : ""}>${op}</option>`).join("")}
                </select>
                <input class="inp" type="number" step="0.1" style="width:100px" data-r-cond-value value="${round.condition_value}">
                <span class="sm t3">${earlier.length ? "" : "No earlier round to condition on yet."}</span>
            </div>` : ""}
        </div>
    </div>`;
}

function _wireWorkflowComposer(root, response) {
    root.querySelector("[data-rc=\"add-round\"]")?.addEventListener("click", _ => {
        _syncWorkflowDraft(root);
        const nextSeq = Math.max(0, ...state.workflowDraft.rounds.map(r => Number(r.sequence))) + 1;
        state.workflowDraft.rounds.push(_blankRound(nextSeq)); _renderWorkflows(root, response);
    });
    for (const button of root.querySelectorAll("[data-rc=\"remove-round\"]"))
        button.addEventListener("click", _ => {
            const draftId = button.closest(".build-section").getAttribute("data-round");
            _syncWorkflowDraft(root);
            state.workflowDraft.rounds = state.workflowDraft.rounds.filter(r => r.draftId != draftId);
            // any round conditioned on the removed one loses that condition — it no longer exists to reference
            for (const round of state.workflowDraft.rounds)
                if (round.condition_round_draft_id == draftId) {round.conditional = false; round.condition_round_draft_id = "";}
            _renderWorkflows(root, response);
        });
    for (const section of root.querySelectorAll(".build-section")) {
        section.querySelector("[data-r-optional]")?.addEventListener("change", _ => {
            _syncWorkflowDraft(root); _renderWorkflows(root, response);});
        section.querySelector("[data-r-conditional]")?.addEventListener("change", _ => {
            _syncWorkflowDraft(root); _renderWorkflows(root, response);});
        section.querySelector("[data-r-sequence]")?.addEventListener("change", _ => {
            _syncWorkflowDraft(root); _renderWorkflows(root, response);});
    }
    for (const button of root.querySelectorAll("[data-rc=\"add-criterion\"]"))
        button.addEventListener("click", _ => {
            const draftId = button.closest(".build-section").getAttribute("data-round");
            _syncWorkflowDraft(root);
            state.workflowDraft.rounds.find(r => r.draftId == draftId).criteria.push("");
            _renderWorkflows(root, response);
        });
    for (const button of root.querySelectorAll("[data-rc=\"remove-criterion\"]"))
        button.addEventListener("click", _ => {
            const draftId = button.closest(".build-section").getAttribute("data-round");
            const ci = Number(button.closest("[data-c]").getAttribute("data-c"));
            _syncWorkflowDraft(root);
            const round = state.workflowDraft.rounds.find(r => r.draftId == draftId);
            round.criteria.splice(ci, 1);
            _renderWorkflows(root, response);
        });
    root.querySelector("[data-rc=\"publish-wf\"]")?.addEventListener("click", _ => _doPublishWorkflow(root));
}

function _syncWorkflowDraft(root) {
    const d = state.workflowDraft;
    if (root.querySelector("#wf-title")) d.title = root.querySelector("#wf-title").value;
    if (root.querySelector("#wf-code")) d.workflow_code = root.querySelector("#wf-code").value.trim().toLowerCase();
    if (root.querySelector("#wf-family")) d.job_family = root.querySelector("#wf-family").value;

    for (const section of root.querySelectorAll(".build-section")) {
        const round = d.rounds.find(r => r.draftId == section.getAttribute("data-round"));
        if (!round) continue;
        round.title = section.querySelector("[data-r-title]")?.value ?? round.title;
        round.round_type = section.querySelector("[data-r-type]")?.value ?? round.round_type;
        round.sequence = Math.round(Number(section.querySelector("[data-r-sequence]")?.value)) || round.sequence;
        round.parallel_group = section.querySelector("[data-r-parallel]")?.value ?? round.parallel_group;
        round.owner_role = section.querySelector("[data-r-owner]")?.value ?? round.owner_role;
        round.sla_days = Number(section.querySelector("[data-r-sla]")?.value) || 0;
        round.optional = section.querySelector("[data-r-optional]")?.checked ?? round.optional;
        const skip = section.querySelector("[data-r-skip]"); if (skip) round.skip_role = skip.value;
        for (const criterionRow of section.querySelectorAll("[data-c]")) {
            const ci = Number(criterionRow.getAttribute("data-c"));
            const input = criterionRow.querySelector("[data-r-criterion]");
            if (input) round.criteria[ci] = input.value;
        }
        round.conditional = section.querySelector("[data-r-conditional]")?.checked ?? round.conditional;
        const condRound = section.querySelector("[data-r-cond-round]"); if (condRound) round.condition_round_draft_id = condRound.value;
        const condOp = section.querySelector("[data-r-cond-op]"); if (condOp) round.condition_operator = condOp.value;
        const condValue = section.querySelector("[data-r-cond-value]"); if (condValue) round.condition_value = Number(condValue.value);
    }
}

async function _doPublishWorkflow(root) {
    _syncWorkflowDraft(root);
    const d = state.workflowDraft;
    if (!d.title.trim()) {states.toast({message: "A workflow needs a title."}); return;}
    if (!/^[a-z0-9-]{2,64}$/.test(d.workflow_code)) {
        states.toast({message: "The code must be lowercase letters, digits and dashes (2-64)."}); return;}
    if (!d.rounds.length) {states.toast({message: "A workflow needs at least one round."}); return;}
    for (const round of d.rounds) {
        if (!round.title.trim()) {states.toast({message: "Every round needs a title."}); return;}
        if (!round.owner_role.trim()) {states.toast({message: `${round.title} needs an owner role.`}); return;}
        if (round.optional && !round.skip_role.trim()) {
            states.toast({message: `${round.title} is optional and needs a skip authoriser role.`}); return;}
        if (round.conditional && !round.condition_round_draft_id) {
            states.toast({message: `${round.title} is marked conditional but no earlier round is selected.`}); return;}
    }

    const idByDraftId = Object.fromEntries(d.rounds.map((round, i) => [round.draftId, `r${i + 1}`]));
    const rounds = d.rounds.map((round, i) => {
        const built = {id: `r${i + 1}`, title: round.title.trim(), round_type: round.round_type.trim() || "custom",
            sequence: round.sequence, owner_role: round.owner_role.trim(), sla_days: round.sla_days,
            optional: Boolean(round.optional)};
        if (round.parallel_group.trim()) built.parallel_group = round.parallel_group.trim();
        if (round.optional) built.skip_role = round.skip_role.trim();
        const criteria = round.criteria.filter(c => c.trim());
        built.scorecard_criteria = criteria.map((label, ci) => ({id: `c${ci + 1}`, label: label.trim()}));
        if (round.conditional && round.condition_round_draft_id) built.condition = {
            round_id: idByDraftId[round.condition_round_draft_id], operator: round.condition_operator,
            value: round.condition_value};
        return built;
    });

    const response = await _rest("publish_workflow", {workflow_code: d.workflow_code, title: d.title.trim(),
        job_family: d.job_family.trim() || undefined, rounds});
    if (!response) return;
    states.toast({message: `Published — v${response.version}.`});
    state.workflowDraft = null; state.composerOpen = false;
    await _workflows(root);
}

// ---------------------------------------------------------------------------
// K4/K5/K7 — pipeline board, candidate drawer, scorecards
// ---------------------------------------------------------------------------

async function _pipeline(root) {
    const requisitions = await _rest("requisitions");
    if (!requisitions) return;
    const approved = requisitions.requisitions.filter(r => r.status == "approved");
    if (!state.selectedRequisitionId && approved.length) state.selectedRequisitionId = approved[0].requisition_id;

    if (!state.selectedRequisitionId) {
        root.innerHTML = `<div class="tr-empty">No approved requisitions yet — approve one on the Requisitions tab first.</div>`;
        return;
    }

    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const [from_date, to_date] = _thisWeek();
    const [board, load] = await Promise.all([_rest("board", {requisition_id: state.selectedRequisitionId}),
        _rest("interviewer_load", {from_date, to_date})]);
    if (!board) return;
    _renderPipeline(root, board, approved, load);
}

function _renderPipeline(root, board, approved, load) {
    root.innerHTML = `
        <div class="row wrap">
            <select class="inp" id="rc-req-select">
                ${approved.map(r => `<option value="${states.esc(r.requisition_id)}"${
                    r.requisition_id == state.selectedRequisitionId ? " selected" : ""}>${states.esc(r.title)}</option>`).join("")}
            </select>
            ${state.canRecord ? `<button class="btn pri push" data-rc="add-candidate">${
                state.addCandidateOpen ? "Close" : "+ Add candidate"}</button>` : ""}
        </div>
        ${state.addCandidateOpen && state.canRecord ? _addCandidateHtml() : ""}

        <div class="row wrap" style="align-items:flex-start;gap:10px;margin-top:10px">
            ${board.columns.map(column => `<div class="tr-panel" style="flex:1;min-width:150px">
                <div class="sm"><b>${states.esc(column.title)}</b></div>
                <div class="sm t3">${column.cards.length}</div>
                ${column.cards.map(card => `<div class="sm" style="padding:6px 0;cursor:pointer;border-top:1px solid var(--stroke)" data-card="${states.esc(card.application_id)}">
                    ${states.esc(card.candidate_name)}</div>`).join("")}
            </div>`).join("")}
        </div>

        <div class="tr-card mt2" style="${board.held.length ? "" : "display:none"}">
            <div class="up t3">Held — by name, and only this</div>
            ${board.held.map(card => `<div class="tr-track-row" data-card="${states.esc(card.application_id)}" style="cursor:pointer">
                <span class="grow"><b>${states.esc(card.candidate_name)}</b> · ${states.esc(card.round_title)}</span>
                <span class="sm" style="color:var(--dawn)">review ${states.esc(card.review_date)}</span></div>`).join("")}
        </div>
        <div class="row wrap mt2" style="gap:16px">
            <div class="sm t3">Rejected: ${board.rejected.length}</div>
            <div class="sm t3">Completed: ${board.completed.length}</div>
        </div>
        ${load ? _loadHtml(load) : ""}
        <div id="rc-drawer"></div>`;

    root.querySelector("#rc-req-select").addEventListener("change", event => {
        state.selectedRequisitionId = event.target.value; state.selectedApplicationId = null; _pipeline(root);});
    root.querySelector("[data-rc=\"add-candidate\"]")?.addEventListener("click", _ => {
        state.addCandidateOpen = !state.addCandidateOpen; _renderPipeline(root, board, approved, load);});
    if (state.addCandidateOpen && state.canRecord) _wireAddCandidate(root);

    for (const card of root.querySelectorAll("[data-card]"))
        card.addEventListener("click", _ => {
            state.selectedApplicationId = card.getAttribute("data-card"); state.reschedulingPanelId = null;
            _renderDrawer(root);
        });

    if (state.selectedApplicationId) _renderDrawer(root);
}

// interviewing is work, shown as work — listed by name, never ranked by load (K11)
const _loadHtml = load => `<div class="tr-card">
    <div class="up t3">Interviewer load · this week</div>
    ${load.interviewers.length ? load.interviewers.map(row => `<div class="tr-track-row">
        <span class="grow"><b>${states.esc(row.name)}</b></span>
        <span class="sm t3">${row.panels} panel${row.panels == 1 ? "" : "s"}${row.completed ?
            ` · ${row.completed} held` : ""} · ${_hm(row.seconds)}</span></div>`).join("") :
        `<div class="tr-empty">No panels scheduled this week.</div>`}
</div>`;

const _addCandidateHtml = _ => `<div class="tr-card">
    <div class="row wrap">
        <input class="inp grow" id="rc-cand-name" placeholder="Full name">
        <input class="inp grow" id="rc-cand-email" placeholder="Email">
        <input class="inp" id="rc-cand-phone" placeholder="Phone" style="width:150px">
        <select class="inp" id="rc-cand-source">
            <option value="referral">referral</option><option value="job_board">job board</option>
            <option value="careers_page">careers page</option><option value="internal">internal</option>
            <option value="other" selected>other</option>
        </select>
    </div>
    <div class="row wrap">
        <input class="inp" id="rc-cand-tz" placeholder="Timezone, e.g. Asia/Kolkata" style="width:220px">
        <input class="inp grow" id="rc-cand-avail" placeholder="When they said they can talk (optional)">
        <button class="btn pri" data-rc="submit-candidate">Add</button>
    </div>
</div>`;

function _wireAddCandidate(root) {
    root.querySelector("[data-rc=\"submit-candidate\"]").addEventListener("click", async _ => {
        const full_name = root.querySelector("#rc-cand-name").value.trim();
        const email = root.querySelector("#rc-cand-email").value.trim();
        if (!full_name || !email) {states.toast({message: "A candidate needs a name and an email."}); return;}
        const result = await _rest("apply", {requisition_id: state.selectedRequisitionId, full_name, email,
            phone: root.querySelector("#rc-cand-phone").value.trim(), source: root.querySelector("#rc-cand-source").value,
            timezone: root.querySelector("#rc-cand-tz").value.trim() || undefined,
            availability_notes: root.querySelector("#rc-cand-avail").value.trim() || undefined});
        if (!result) return;
        states.toast({message: `${full_name} added to the pipeline.`});
        state.addCandidateOpen = false; await _pipeline(root);
    });
}

async function _renderDrawer(root) {
    const holder = root.querySelector("#rc-drawer");
    holder.innerHTML = `<div class="tr-card mt2">${states.loading({rows: 3})}</div>`;
    const [record, legal] = await Promise.all([
        _rest("candidate", {application_id: state.selectedApplicationId}),
        _rest("legal_actions", {application_id: state.selectedApplicationId})]);
    if (!record || !legal) return;
    if (state.canSchedule && !state.roster)
        state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];

    const candidate = record.candidate;
    holder.innerHTML = `<div class="tr-card mt2">
        <div class="tr-card-top">
            <div class="grow"><h2 style="font-size:16px">${states.esc(candidate.full_name)}</h2>
                <p class="sm t2">${states.esc(candidate.email)}${candidate.phone ? ` · ${states.esc(candidate.phone)}` : ""} ·
                    source: ${states.esc(candidate.source)}${candidate.referrer_person_id ?
                        ` · referred` : ""}</p></div>
            <button class="btn" data-rc="close-drawer">Close</button>
        </div>

        <div class="sm t2">${candidate.timezone ? `Timezone <b>${states.esc(candidate.timezone)}</b>` :
            "No timezone recorded — panel times show in yours until one is"}${candidate.availability_notes ?
            ` · they said “${states.esc(candidate.availability_notes)}”` : ""}</div>
        ${state.canSchedule ? `<div class="row wrap">
            <input class="inp" data-rc-tz placeholder="Timezone, e.g. Asia/Kolkata" style="width:220px"
                value="${states.esc(candidate.timezone || "")}">
            <input class="inp grow" data-rc-avail placeholder="When they said they can talk"
                value="${states.esc(candidate.availability_notes || "")}">
            <button class="btn sm" data-rc="save-availability">Save</button>
        </div>` : ""}

        <div class="row wrap" style="gap:5px">
            ${record.workflow.map(round => {
                const color = round.status == "passed" ? "var(--mint)" : round.status == "rejected" ? "var(--ember)" :
                    round.status == "held" ? "var(--dawn)" : "var(--t3)";
                return `<span class="mono sm" style="padding:3px 8px;border-radius:6px;background:var(--raise);color:${color}">
                    ${states.esc(round.title)} · ${states.esc(round.status.replace(/_/g, " "))}</span>`;
            }).join("<span class=\"sm t3\">→</span>")}
        </div>
        ${record.terminal ? `<div class="tr-note">${record.terminal.kind == "completed" ?
            "Completed the whole pipeline." : `Rejected at ${states.esc(record.workflow.find(r => r.id == record.terminal.round_id)?.title || record.terminal.round_id)} — ${states.esc(record.terminal.reason)}`}</div>` : ""}

        ${legal.current_rounds.map(round => _currentRoundHtml(round, record)).join("")}

        <div class="up t3">Evaluations</div>
        ${record.evaluations.map(evaluation => `<div class="tr-panel">
            <div class="sm"><b>${states.esc(evaluation.title)}</b> · ${evaluation.scorecard_count} scorecard${evaluation.scorecard_count == 1 ? "" : "s"}</div>
            ${evaluation.visible ? evaluation.scorecards.map(card => `<div class="sm">
                <b>${states.esc(card.recommendation)}</b>${card.score != null ? ` · ${card.score}` : ""} — ${states.esc(card.evidence || "")}</div>`).join("") :
                `<div class="sm t3">Not visible until you submit your own for this round.</div>`}
        </div>`).join("")}

        <div class="up t3">Activity</div>
        <div class="tr-panel">
            ${record.activity.map(item => `<div class="sm">${states.esc(item.kind)} · ${states.esc(item.round_id)}${
                item.reason ? ` — ${states.esc(item.reason)}` : ""}</div>`).join("") || `<div class="sm t3">Nothing yet.</div>`}
        </div>
    </div>`;

    holder.querySelector("[data-rc=\"close-drawer\"]").addEventListener("click", _ => {
        state.selectedApplicationId = null; state.reschedulingPanelId = null; holder.innerHTML = "";});
    holder.querySelector("[data-rc=\"save-availability\"]")?.addEventListener("click", async _ => {
        const result = await _rest("update_candidate", {candidate_id: candidate.candidate_id,
            timezone: holder.querySelector("[data-rc-tz]").value.trim() || undefined,
            availability_notes: holder.querySelector("[data-rc-avail]").value.trim() || undefined});
        if (!result) return;
        states.toast({message: "Saved — panel times now show in their timezone."}); _renderDrawer(root);
    });

    for (const roundBlock of holder.querySelectorAll("[data-round-actions]")) _wireCurrentRound(roundBlock, root, record);
}

function _currentRoundHtml(round, record) {
    const advance = round.actions.find(a => a.action == "advance");
    const skip = round.actions.find(a => a.action == "skip");
    return `<div class="tr-panel" data-round-actions="${states.esc(round.round_id)}">
        <div class="sm"><b>${states.esc(round.title)}</b>${round.state == "held" ?
            ` · held, review ${states.esc(round.review_date)}` : ""}</div>
        ${state.canScore && round.scorecard_criteria.length ? `
            <div class="up t3">Submit scorecard</div>
            ${round.scorecard_criteria.map(criterion => `<div class="row" data-crit="${states.esc(criterion.id)}">
                <span class="sm" style="flex:1">${states.esc(criterion.label)}</span>
                <select class="inp" data-sc-rating style="width:70px">
                    <option value="1">1</option><option value="2">2</option><option value="3" selected>3</option>
                    <option value="4">4</option><option value="5">5</option>
                </select></div>`).join("")}
            <textarea class="inp" data-sc-evidence placeholder="Evidence (80+ chars for a rating below 3 or above 4)" style="width:100%;min-height:50px"></textarea>
            <div class="row wrap">
                <select class="inp" data-sc-recommendation style="width:140px">
                    <option value="strong_no">Strong no</option><option value="no">No</option>
                    <option value="lean_yes">Lean yes</option><option value="yes" selected>Yes</option>
                    <option value="strong_yes">Strong yes</option>
                </select>
                <button class="btn pri" data-rc="submit-score">Submit scorecard</button>
            </div>` : ""}
        <div class="row wrap">
            <button class="btn pri" data-rc="advance"${advance.legal ? "" : " disabled"} title="${states.esc(advance.why_not || "")}">Advance${
                advance.legal ? "" : ` — ${states.esc(advance.why_not)}`}</button>
            <input class="inp" data-tr-reason placeholder="reason" style="width:140px">
            <button class="btn danger" data-rc="reject">Reject</button>
            <input class="inp" type="date" data-tr-review style="width:150px">
            <button class="btn" data-rc="hold">Hold</button>
            <button class="btn" data-rc="skip"${skip.legal ? "" : " disabled"} title="${states.esc(skip.why_not || "")}">Skip${
                skip.legal ? "" : ` — ${states.esc(skip.why_not)}`}</button>
            <button class="btn" data-rc="reschedule" title="Keeps the round and resets its SLA">Reschedule round</button>
            <button class="btn" data-rc="cancel" title="Removes this round from the candidate's process">Cancel round</button>
        </div>
        ${_panelsHtml(round, record)}
    </div>`;
}

// -- K6: the panels for one open round, and the composer that schedules or moves one --

function _panelsHtml(round, record) {
    const panels = record.panels.filter(panel => panel.round_id == round.round_id);
    const zone = _defaultZone(record);
    const moving = panels.find(panel => panel.panel_assignment_id == state.reschedulingPanelId);
    return `<div class="up t3">Panels</div>
        ${panels.length ? panels.map(panel => `<div class="tr-track-row sv-manage-row" data-panel="${states.esc(panel.panel_assignment_id)}">
            <span class="grow"><b>${states.esc(_slotText(panel.scheduled_start, panel.scheduled_end, zone))}</b> ·
                ${panel.interviewers.map(person => states.esc(person.name)).join(", ")}</span>
            <span class="sm t3">${states.esc(panel.status.replace(/_/g, " "))}${panel.reason ? ` — ${states.esc(panel.reason)}` : ""}</span>
            ${panel.status == "scheduled" && state.canSchedule ? `<span class="sv-manage-actions">
                <button class="btn sm" data-rc="panel-move">Move</button>
                <button class="btn sm pri" data-rc="panel-held">Held · log time</button>
                <input class="inp" data-panel-reason placeholder="reason" style="width:120px">
                <button class="btn sm" data-rc="panel-cancel">Cancel meeting</button>
                <button class="btn sm" data-rc="panel-noshow">No-show</button>
            </span>` : ""}
        </div>`).join("") : `<div class="sm t3">No panel scheduled for this round.</div>`}
        ${state.canSchedule ? _panelComposerHtml(record, moving) : ""}`;
}

function _panelComposerHtml(record, moving) {
    const candidateZone = _safeZone(record.candidate.timezone);
    const zones = [...new Set([candidateZone, _myZone(), "UTC"].filter(Boolean))];
    const date = moving ? _dateIn(moving.scheduled_start, zones[0]) : _tomorrow();
    const start = moving ? _timeIn(moving.scheduled_start, zones[0]) : "10:00";
    const minutes = moving ? Math.round((moving.scheduled_end - moving.scheduled_start)/60) : 60;
    const chosen = new Set(moving ? moving.interviewer_person_ids : []);
    const zoneLabel = zone => zone == candidateZone ? `Candidate's time (${zone})` :
        zone == "UTC" ? "UTC" : `My time (${zone})`;
    return `<div class="build-q" data-panel-composer>
        <div class="row"><span class="sm"><b>${moving ? "Move this panel" : "Schedule a panel"}</b></span>
            ${moving ? `<button class="btn sm push" data-rc="panel-move-cancel">Keep it where it is</button>` : ""}</div>
        <div class="row wrap">${(state.roster || []).map(person => `<label class="build-check">
            <input type="checkbox" data-pc-person="${states.esc(person.person_id)}"${chosen.has(person.person_id) ? " checked" : ""}${
                moving ? " disabled" : ""}> ${states.esc(person.display_name || person.person_id)}</label>`).join("") ||
            `<span class="sm t3">No one is in force in this organisation today.</span>`}</div>
        <div class="row wrap">
            <input class="inp" type="date" data-pc-date style="width:160px" value="${date}">
            <select class="inp" data-pc-zone data-prev="${states.esc(zones[0])}">${zones.map(zone =>
                `<option value="${states.esc(zone)}">${states.esc(zoneLabel(zone))}</option>`).join("")}</select>
            <button class="btn sm" data-rc="panel-check">Check availability</button>
        </div>
        <div data-pc-timeline></div>
        <div class="row wrap">
            <input class="inp" type="time" data-pc-start style="width:120px" value="${start}">
            <input class="inp" type="number" min="15" step="15" data-pc-minutes style="width:90px" value="${minutes}">
            <span class="sm t3">min</span>
            ${moving ? `<input class="inp grow" data-pc-reason placeholder="Why it's moving (optional)">` : ""}
            <button class="btn pri" data-rc="panel-submit">${moving ? "Move panel" : "Schedule"}</button>
        </div>
    </div>`;
}

/**
 * The E3 board drawn on the chosen zone's day. Each interviewer's working span,
 * or the reason they have none (leave, off day, no window); the band everyone
 * shares; and the slot being proposed. A guide — the server re-checks the slot.
 */
function _timelineHtml(board, date, zone, slot) {
    const dayStart = _dayStartMinutes(date, zone);
    const pct = minute => Math.max(0, Math.min(100, (minute - dayStart)/14.4));
    const bar = (span, color) => span ? `<span style="position:absolute;top:0;bottom:0;left:${pct(span.from)}%;width:${
        Math.max(0, pct(span.to) - pct(span.from))}%;background:${color};border-radius:3px"></span>` : "";
    const row = (label, inner, note = "") => `<div class="row" style="gap:8px">
        <span class="sm" style="width:130px;flex:none">${label}</span>
        <div style="position:relative;height:10px;flex:1;background:var(--raise);border-radius:3px">${inner}</div>
        <span class="sm t3" style="width:150px;flex:none">${note}</span></div>`;
    const names = Object.fromEntries((state.roster || []).map(person => [person.person_id, person.display_name]));
    const slotSpan = slot ? {from: slot.from/60, to: slot.to/60} : null;
    return `<div class="col" style="gap:5px">
        ${board.per_person.map(person => row(states.esc(names[person.person_id] || person.person_id),
            person.workday ? bar(person.span, "var(--mint)") : "",
            person.workday ? "" : states.esc(REASON_TEXT[person.reason] || person.reason))).join("")}
        ${row("<b>Everyone free</b>", bar(board.span, "var(--brand)"),
            board.shared_minutes ? _hm(board.shared_minutes*60) : "no shared time")}
        ${slotSpan ? row("Proposed slot", bar(slotSpan, "var(--dawn)")) : ""}
        <div class="row" style="gap:8px"><span style="width:130px;flex:none"></span>
            <div class="row mono sm t3" style="flex:1;justify-content:space-between">
                <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
            <span style="width:150px;flex:none"></span></div>
    </div>`;
}

function _wireCurrentRound(block, root, record) {
    const roundId = block.getAttribute("data-round-actions");
    block.querySelector("[data-rc=\"submit-score\"]")?.addEventListener("click", async _ => {
        const criteria_ratings = [...block.querySelectorAll("[data-crit]")].map(row => ({
            criterion_id: row.getAttribute("data-crit"), rating: Number(row.querySelector("[data-sc-rating]").value)}));
        const result = await _rest("scorecard", {application_id: state.selectedApplicationId, round_id: roundId,
            criteria_ratings, evidence: block.querySelector("[data-sc-evidence]").value,
            recommendation: block.querySelector("[data-sc-recommendation]").value});
        if (!result) return;
        states.toast({message: "Scorecard submitted."}); await _pipeline(root);
    });

    const doTransition = async kind => {
        const reason = block.querySelector("[data-tr-reason]")?.value.trim();
        const review_date = block.querySelector("[data-tr-review]")?.value;
        if (["rejected", "held", "cancelled"].includes(kind) && !reason) {
            states.toast({message: `${kind} needs a reason.`}); return;}
        if (kind == "held" && !review_date) {states.toast({message: "A hold needs a review date."}); return;}
        const result = await _rest("transition", {application_id: state.selectedApplicationId, round_id: roundId,
            kind, reason: reason || undefined, review_date: review_date || undefined,
            client_event_id: crypto.randomUUID()});
        if (!result) return;
        states.toast({message: `Recorded — ${kind}.`}); await _pipeline(root);
    };
    block.querySelector("[data-rc=\"advance\"]")?.addEventListener("click", _ => doTransition("advanced"));
    block.querySelector("[data-rc=\"reject\"]")?.addEventListener("click", _ => doTransition("rejected"));
    block.querySelector("[data-rc=\"hold\"]")?.addEventListener("click", _ => doTransition("held"));
    block.querySelector("[data-rc=\"skip\"]")?.addEventListener("click", _ => doTransition("skipped"));
    block.querySelector("[data-rc=\"reschedule\"]")?.addEventListener("click", _ => doTransition("rescheduled"));
    block.querySelector("[data-rc=\"cancel\"]")?.addEventListener("click", _ => doTransition("cancelled"));

    // K6 — the panels already on this round
    for (const row of block.querySelectorAll("[data-panel]")) {
        const panelId = row.getAttribute("data-panel");
        const outcome = async (kind, needsReason) => {
            const reason = row.querySelector("[data-panel-reason]")?.value.trim();
            if (needsReason && !reason) {states.toast({message: "Give a reason — it's recorded with the panel."}); return;}
            const result = await _rest("panel_outcome", {panel_assignment_id: panelId, outcome: kind,
                reason: reason || undefined});
            if (!result) return;
            states.toast({message: kind == "completed" ? `Logged — ${result.time_entries.length} interviewer${
                result.time_entries.length == 1 ? "'s" : "s'"} time is on their timesheet.` : `Recorded — ${kind.replace("_", "-")}.`});
            await _pipeline(root);
        };
        row.querySelector("[data-rc=\"panel-move\"]")?.addEventListener("click", _ => {
            state.reschedulingPanelId = panelId; _renderDrawer(root);});
        row.querySelector("[data-rc=\"panel-held\"]")?.addEventListener("click", async _ => {
            const confirmed = await states.confirmAction({title: "Mark this panel as held?",
                body: "Each interviewer gets the panel's length logged as interview time on their timesheet.",
                confirmLabel: "Log it"});
            if (confirmed) await outcome("completed", false);
        });
        row.querySelector("[data-rc=\"panel-cancel\"]")?.addEventListener("click", _ => outcome("cancelled", true));
        row.querySelector("[data-rc=\"panel-noshow\"]")?.addEventListener("click", _ => outcome("no_show", true));
    }

    // K6 — the composer
    const composer = block.querySelector("[data-panel-composer]");
    if (!composer) return;
    const field = name => composer.querySelector(`[data-pc-${name}]`);
    const read = _ => ({zone: field("zone").value, date: field("date").value, start: field("start").value,
        minutes: Number(field("minutes").value),
        people: [...composer.querySelectorAll("[data-pc-person]:checked")].map(input => input.getAttribute("data-pc-person"))});
    let lastBoard = null;
    const paint = _ => {
        if (!lastBoard) return;
        const {zone, date, start, minutes} = read();
        const from = date && start ? _slotEpoch(date, start, zone) : null;
        field("timeline").innerHTML = _timelineHtml(lastBoard, date, zone,
            from != null && minutes > 0 ? {from, to: from + minutes*60} : null);
    };

    composer.querySelector("[data-rc=\"panel-check\"]").addEventListener("click", async _ => {
        const {date, people} = read();
        if (!people.length) {states.toast({message: "Pick at least one interviewer."}); return;}
        if (!date) {states.toast({message: "Pick a date."}); return;}
        lastBoard = await _call(API_CALENDAR, "board", {person_ids: people, date});
        paint();
    });
    field("start").addEventListener("input", paint);
    field("minutes").addEventListener("input", paint);
    field("date").addEventListener("change", _ => {lastBoard = null; field("timeline").innerHTML = "";});
    // changing the zone keeps the same instant and re-reads it in the new zone, rather than
    // silently moving the panel by the difference between the two
    field("zone").addEventListener("change", _ => {
        const {date, start, zone} = read();
        if (date && start) {
            const epoch = _slotEpoch(date, start, field("zone").getAttribute("data-prev"));
            field("date").value = _dateIn(epoch, zone); field("start").value = _timeIn(epoch, zone);
        }
        field("zone").setAttribute("data-prev", zone); paint();
    });
    composer.querySelector("[data-rc=\"panel-move-cancel\"]")?.addEventListener("click", _ => {
        state.reschedulingPanelId = null; _renderDrawer(root);});

    composer.querySelector("[data-rc=\"panel-submit\"]").addEventListener("click", async event => {
        const {zone, date, start, minutes, people} = read();
        if (!people.length) {states.toast({message: "Pick at least one interviewer."}); return;}
        if (!date || !start) {states.toast({message: "Pick a date and a start time."}); return;}
        if (!(minutes > 0)) {states.toast({message: "A panel needs a length."}); return;}
        const scheduled_start = _slotEpoch(date, start, zone), scheduled_end = scheduled_start + minutes*60;
        const moving = record.panels.find(panel => panel.panel_assignment_id == state.reschedulingPanelId &&
            panel.round_id == roundId);

        event.target.disabled = true;     // one click, one panel
        const result = moving ?
            await _rest("reschedule_panel", {panel_assignment_id: moving.panel_assignment_id, scheduled_start,
                scheduled_end, reason: field("reason")?.value.trim() || undefined}) :
            await _rest("schedule_panel", {application_id: state.selectedApplicationId, round_id: roundId,
                interviewer_person_ids: people, scheduled_start, scheduled_end, timezone_base: zone,
                client_event_id: crypto.randomUUID()});
        if (!result) {event.target.disabled = false; return;}
        states.toast({message: `${moving ? "Moved" : "Scheduled"} — ${_slotText(scheduled_start, scheduled_end, zone)}.${
            _warningsText(result.warnings)}`, ms: result.warnings.length ? 12000 : 5000});
        state.reschedulingPanelId = null; await _pipeline(root);
    });
}

// ---------------------------------------------------------------------------
// time, read in a zone — the same noon probe windows.js uses, so the strip and
// the server agree about what a local time on a date means
// ---------------------------------------------------------------------------

const REASON_TEXT = {outside_window: "outside working hours", on_leave: "on leave",
    off_day: "not a working day", undeclared: "no working window declared", unavailable: "unavailable"};

function _warningsText(warnings = []) {
    if (!warnings.length) return "";
    const names = Object.fromEntries((state.roster || []).map(person => [person.person_id, person.display_name]));
    return ` Heads up — ${warnings.map(warning => `${names[warning.person_id] || "an interviewer"}: ${
        REASON_TEXT[warning.reason] || warning.reason}`).join("; ")}.`;
}

const _myZone = _ => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const _defaultZone = record => _safeZone(record.candidate.timezone) || _myZone();

function _safeZone(zone) {
    if (!zone) return null;
    try {new Intl.DateTimeFormat("en-US", {timeZone: zone}); return zone;} catch {return null;}
}

function _parts(epochSeconds, zone, options) {
    return Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone: zone, ...options})
        .formatToParts(new Date(epochSeconds*1000)).map(part => [part.type, part.value]));
}

/** local − UTC, in minutes, for a zone on a date */
function _offsetMinutes(dateISO, zone) {
    const noon = Date.parse(`${dateISO}T12:00:00Z`)/1000;
    const p = _parts(noon, zone, {hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"});
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute)/1000 - noon)/60);
}

const _dayStartMinutes = (dateISO, zone) => Date.parse(`${dateISO}T00:00:00Z`)/60000 - _offsetMinutes(dateISO, zone);

function _slotEpoch(dateISO, hhmm, zone) {
    const [hour, minute] = hhmm.split(":").map(Number);
    return (_dayStartMinutes(dateISO, zone) + hour*60 + minute)*60;
}

function _dateIn(epochSeconds, zone) {
    const p = _parts(epochSeconds, zone, {year: "numeric", month: "2-digit", day: "2-digit"});
    return `${p.year}-${p.month}-${p.day}`;
}

function _timeIn(epochSeconds, zone) {
    const p = _parts(epochSeconds, zone, {hourCycle: "h23", hour: "2-digit", minute: "2-digit"});
    return `${p.hour}:${p.minute}`;
}

function _slotText(start, end, zone) {
    const day = new Date(start*1000).toLocaleDateString(undefined, {timeZone: zone, weekday: "short",
        day: "numeric", month: "short"});
    return `${day} · ${_timeIn(start, zone)}–${_timeIn(end, zone)} ${zone}`;
}

const _hm = seconds => `${Math.floor(seconds/3600)}h ${String(Math.floor(seconds%3600/60)).padStart(2, "0")}m`;
const _today = _ => new Date().toISOString().substring(0, 10);
const _tomorrow = _ => new Date(Date.now() + 86400000).toISOString().substring(0, 10);

/** Monday to Sunday of the current week, as ISO dates. */
function _thisWeek() {
    const monday = new Date(`${_today()}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    return [monday, sunday].map(date => date.toISOString().substring(0, 10));
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
