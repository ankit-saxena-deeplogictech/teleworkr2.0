/**
 * B5/B6 — admin day one: the standing setup checklist, its health, the one
 * metric it exists for, and the two imports (people, opening balances) that
 * get a real org running without corrupting the ledger model.
 *
 * An import is a dry run before it is ever a write. Preview and commit are the
 * same call with commit:false / true, so the numbers a preview reports are
 * exactly the numbers a commit will act on — never a second code path that
 * could drift from the first.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "setup";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

const STATUS_LABELS = {done: "Done", in_progress: "In progress", not_started: "Not started", deferred: "Deferred"};
const PEOPLE_COLUMNS = ["email", "display_name", "start_date", "jurisdiction", "contract_type",
    "employment_status", "manager_email"];
const BALANCE_COLUMNS = ["email", "leave_type", "days"];

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, tab: "checklist", status: null,
        peopleImport: {text: "", preview: null, batch: null},
        balancesImport: {text: "", cutover: new Date().toISOString().substring(0, 10), preview: null, batch: null}};
    await _view();
}

async function _view() {
    const root = state.root;
    const tabs = [["checklist", "Setup checklist"], ["import_people", "Import people"],
        ["import_balances", "Opening balances"]];
    root.innerHTML = `<div class="page pe">
        <div class="tr-tabs">${tabs.map(([id, label]) =>
            `<button class="tr-tab${state.tab == id ? " on" : ""}" data-pe="tab" data-tab="${id}">${label}</button>`).join("")}
        </div>
        <div class="pe-view" id="pe-view">${states.loading({rows: 5})}</div>
    </div>`;
    for (const button of root.querySelectorAll('[data-pe="tab"]'))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#pe-view");
    try {
        if (!state.status) {
            const response = await _rest("status", {});
            if (!response) return;
            state.status = response;
        }
        if (state.tab == "checklist") return _checklist(view);
        if (state.tab == "import_people") return _importPeople(view);
        return _importBalances(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load setup",
            what: err.message, safe: "Nothing you entered was sent.",
            reference: `B5-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// checklist, health, the one metric
// ---------------------------------------------------------------------------

function _checklist(root) {
    const {steps, health, metrics} = state.status;
    const pillClass = {done: "g", in_progress: "a", deferred: "d"};

    root.innerHTML = `
        <div class="pe-card">
            <div class="up t3">Setup, in dependency order</div>
            <div class="pe-steps">${steps.map((step, i) => `
                <div class="pe-step">
                    <span class="pe-pill ${pillClass[step.status] || ""}">${states.esc(STATUS_LABELS[step.status] || step.status)}</span>
                    <div class="grow">
                        <div class="pe-step-title">${i + 1} · ${states.esc(step.label)}${
                            step.required ? ` <span class="pe-req">Required</span>` : ""}</div>
                        ${step.reason ? `<div class="sm t3">${states.esc(step.reason)}</div>` : ""}
                    </div>
                    ${step.status != "done" ? `<div class="row" style="gap:6px">
                        <button class="btn sm" data-pe-mark="${states.esc(step.step)}" data-status="done">Mark done</button>
                        ${!step.required ? `<button class="btn sm" data-pe-mark="${states.esc(step.step)}" data-status="deferred">Defer</button>` : ""}
                    </div>` : ""}
                </div>`).join("")}
            </div>
        </div>

        <div class="pe-card">
            <div class="up t3">Setup health</div>
            ${health.length ? health.map(item => `
                <div class="pe-health">
                    <span class="sm">${states.esc(item.note)}</span>
                    ${(item.persons||[]).length ? `<div class="xs t3">${
                        item.persons.slice(0, 5).map(p => states.esc(p.email)).join(", ")}${
                        item.persons.length > 5 ? ` +${item.persons.length - 5} more` : ""}</div>` : ""}
                </div>`).join("") : `<div class="sm t2">Nothing is decaying — setup health is clean.</div>`}
        </div>

        <div class="pe-card pe-metric">
            <div class="up t3">Time to first clock-in</div>
            <div class="pe-metric-val mono">${metrics.time_to_first_clock_in_seconds != null ?
                _hm(metrics.time_to_first_clock_in_seconds) : "Not yet — nobody has clocked in."}</div>
        </div>`;

    for (const button of root.querySelectorAll("[data-pe-mark]"))
        button.addEventListener("click", async _ => {
            const step = button.getAttribute("data-pe-mark"), status = button.getAttribute("data-status");
            if (!(await _rest("mark", {step, status}))) return;
            states.toast({message: `Marked ${status.replace("_", " ")}.`});
            state.status = null; await _view();
        });
}

// ---------------------------------------------------------------------------
// import people (B6)
// ---------------------------------------------------------------------------

function _importPeople(root) {
    const imp = state.peopleImport;
    root.innerHTML = `
        <div class="pe-card">
            <div class="up t3">Import people</div>
            <div class="sm t3 mt">CSV with a header row: <span class="mono xs">${PEOPLE_COLUMNS.join(",")}</span>.
                employment_status defaults to active; manager_email is optional.
                Historical time and leave are deliberately not imported — the opening balance below is the boundary.</div>
            <textarea class="inp pe-csv" id="pe-people-csv" rows="8"
                placeholder="email,display_name,start_date,jurisdiction,contract_type&#10;jane@acme.test,Jane Doe,2026-09-01,IN,employee">${states.esc(imp.text)}</textarea>
            <div class="row" style="gap:8px;margin-top:8px">
                <button class="btn pri" data-pe="preview">Preview</button>
                ${imp.preview?.ok_rows ? `<button class="btn" data-pe="commit">Commit ${imp.preview.ok_rows} row${imp.preview.ok_rows == 1 ? "" : "s"}</button>` : ""}
            </div>
            <div id="pe-people-result">${imp.preview ? _resultHTML(imp.preview) : ""}</div>
            ${imp.batch ? _batchHTML(imp.batch) : ""}
        </div>`;

    root.querySelector("#pe-people-csv").addEventListener("input", event => imp.text = event.target.value);
    root.querySelector('[data-pe="preview"]').addEventListener("click", _ => _runImport("people", root, false));
    root.querySelector('[data-pe="commit"]')?.addEventListener("click", _ => _runImport("people", root, true));
    root.querySelector('[data-pe="rollback"]')?.addEventListener("click", _ => _rollback("people", root));
}

// ---------------------------------------------------------------------------
// opening balances (B6) — ledger entries, never a stored balance
// ---------------------------------------------------------------------------

function _importBalances(root) {
    const imp = state.balancesImport;
    root.innerHTML = `
        <div class="pe-card">
            <div class="up t3">Opening leave balances</div>
            <div class="sm t3 mt">Each row becomes a single dated ledger entry, attributed to the source system —
                never a stored balance (A6). CSV with a header row: <span class="mono xs">${BALANCE_COLUMNS.join(",")}</span>.
                Import people first; a balance row needs a person to attach to.</div>
            <label class="col sm t3" style="margin-top:8px;max-width:220px">Cutover date
                <input class="inp" type="date" id="pe-cutover" value="${states.esc(imp.cutover)}"></label>
            <textarea class="inp pe-csv" id="pe-balances-csv" rows="8"
                placeholder="email,leave_type,days&#10;jane@acme.test,annual,9">${states.esc(imp.text)}</textarea>
            <div class="row" style="gap:8px;margin-top:8px">
                <button class="btn pri" data-pe="preview">Preview</button>
                ${imp.preview?.ok_rows ? `<button class="btn" data-pe="commit">Commit ${imp.preview.ok_rows} row${imp.preview.ok_rows == 1 ? "" : "s"}</button>` : ""}
            </div>
            <div id="pe-balances-result">${imp.preview ? _resultHTML(imp.preview) : ""}</div>
            ${imp.batch ? _batchHTML(imp.batch) : ""}
        </div>`;

    root.querySelector("#pe-cutover").addEventListener("change", event => imp.cutover = event.target.value);
    root.querySelector("#pe-balances-csv").addEventListener("input", event => imp.text = event.target.value);
    root.querySelector('[data-pe="preview"]').addEventListener("click", _ => _runImport("balances", root, false));
    root.querySelector('[data-pe="commit"]')?.addEventListener("click", _ => _runImport("balances", root, true));
    root.querySelector('[data-pe="rollback"]')?.addEventListener("click", _ => _rollback("balances", root));
}

// ---------------------------------------------------------------------------
// shared: preview/commit, rollback, and the CSV parser
// ---------------------------------------------------------------------------

async function _runImport(kind, root, commit) {
    const imp = kind == "people" ? state.peopleImport : state.balancesImport;
    const rows = kind == "people" ? _parseCSV(imp.text, PEOPLE_COLUMNS) :
        _parseCSV(imp.text, BALANCE_COLUMNS).map(row => ({...row, days: Number(row.days)}));
    if (!rows.length) {states.toast({message: "Paste at least one data row under the header."}); return;}

    const op = kind == "people" ? "import_people" : "import_balances";
    const extra = {rows: JSON.stringify(rows), source: "csv", commit};   // the array is pre-serialized —
    // apiman's GET encoder turns a raw array of objects into repeated same-named query params, and the
    // server's query decoder collapses repeated keys onto one, silently keeping only the last row. A
    // single JSON string sidesteps that path entirely and survives the round trip intact.
    if (kind == "balances") extra.cutover_date = imp.cutover;

    const response = await _rest(op, extra);
    if (!response) return;

    imp.preview = response;
    if (commit && response.status == "committed") {
        imp.batch = {import_batch_id: response.batch_id, ok_rows: response.ok_rows, committed_at: Date.now()};
        states.toast({message: `Imported ${response.ok_rows} row${response.ok_rows == 1 ? "" : "s"}.`});
        state.status = null;      // the checklist and health derive from this data
    }
    kind == "people" ? _importPeople(root) : _importBalances(root);
}

async function _rollback(kind, root) {
    const imp = kind == "people" ? state.peopleImport : state.balancesImport;
    if (!imp.batch) return;
    const confirmed = await states.confirmDestructive({title: "Roll back this import?",
        body: `${imp.batch.ok_rows} imported row${imp.batch.ok_rows == 1 ? "" : "s"} will be removed whole.`,
        confirmLabel: "Roll back"});
    if (!confirmed) return;

    if (!(await _rest("rollback", {import_batch_id: imp.batch.import_batch_id}))) return;
    states.toast({message: "Import rolled back."});
    imp.batch = null; imp.preview = null; imp.text = "";
    state.status = null;
    kind == "people" ? _importPeople(root) : _importBalances(root);
}

const _resultHTML = preview => `
    <div class="pe-result">
        <div class="row" style="gap:8px">
            <span class="mono">${preview.ok_rows}</span><span class="sm t2">of</span>
            <span class="mono">${preview.total_rows}</span>
            <span class="sm t2">row${preview.total_rows == 1 ? "" : "s"} will import cleanly</span>
        </div>
        ${(preview.warnings||[]).map(w => `<div class="pe-warn">${w.row ? `Row ${w.row} — ` : ""}${states.esc(w.reason)}</div>`).join("")}
        ${(preview.failures||[]).map(f => `<div class="pe-fail">Row ${f.row} — ${states.esc(f.reason)}</div>`).join("")}
    </div>`;

const _batchHTML = batch => `
    <div class="pe-batch">
        <span class="sm t2">Batch <span class="mono">${states.esc(batch.import_batch_id.slice(0, 8))}</span> committed
            · ${batch.ok_rows} row${batch.ok_rows == 1 ? "" : "s"}</span>
        <span class="xs t3 grow">Reversible for 24 hours, or until something real is recorded against it.</span>
        <button class="btn sm danger" data-pe="rollback">Roll back</button>
    </div>`;

/** No quoted-comma support — a header row plus plain comma-separated values, matching what a spreadsheet export gives by default. */
function _parseCSV(text, columns) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const header = lines[0].split(",").map(cell => cell.trim().toLowerCase());
    return lines.slice(1).map(line => {
        const cells = line.split(",").map(cell => cell.trim());
        const row = {};
        header.forEach((key, i) => {if (columns.includes(key) && cells[i]) row[key] = cells[i];});
        return row;
    });
}

const _hm = totalSeconds => {
    const h = Math.floor(totalSeconds/3600), m = Math.floor((totalSeconds%3600)/60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

async function _rest(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Setup op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The setup service did not respond.", ms: 8000}); return null;}
    return response;
}
