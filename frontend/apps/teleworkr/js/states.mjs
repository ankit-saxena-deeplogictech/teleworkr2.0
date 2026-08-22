/**
 * A4 — the state library, as renderers rather than as a page of pictures.
 *
 * A4 is the strongest page in the wireframe set and the hi-fi implements none of
 * it, which is how sixty-three screens end up with sixty-three error messages.
 * Every screen imports these instead of writing its own.
 *
 * The rules encoded here, so that a screen cannot skip one by accident:
 *   an error states what happened, whether the data is safe, and what to do next;
 *   the reference id sits beside the sentence, never inside it;
 *   a destructive confirm itemises its collateral damage before it offers the verb;
 *   a filtered-empty names the filters that emptied it;
 *   nothing is discarded silently on conflict.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

const TOAST_MS = 6000;      // A4: bottom-left, 6 seconds, one at a time

/** Everything rendered here may carry text a person typed, so nothing is trusted. */
const esc = value => String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const _actions = actions => (actions||[]).length ?
    `<div class="actions">${actions.map(a =>
        `<button class="btn${a.primary?" pri":""}${a.danger?" danger":""}" data-action="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div>` : "";

/**
 * Loading. Skeletons match the real layout — a full-page spinner tells a person
 * nothing about what is arriving.
 * @param {object} options {rows}
 */
const loading = (options={}) => `<div class="skel" aria-busy="true" aria-live="polite">${
    Array.from({length: options.rows||5}, _ => `<div class="line"></div>`).join("")}</div>`;

/**
 * Empty on first use. Says what will appear here and offers the thing that makes
 * it appear — an empty list with no way forward is a dead end.
 * @param {object} options {title, body, actions}
 */
const empty = (options={}) => `<div class="state empty">
    <h3>${esc(options.title)}</h3>
    <p>${esc(options.body)}</p>
    ${_actions(options.actions)}</div>`;

/**
 * Empty because of filters, which is a different situation from having nothing —
 * so it names the filters and offers to clear them.
 * @param {object} options {title, filters:[{label}], actions}
 */
const filteredEmpty = (options={}) => `<div class="state empty">
    <h3>${esc(options.title)}</h3>
    <div class="filters">${(options.filters||[]).map(f => `<span class="chip">${esc(f)}</span>`).join("")}</div>
    ${_actions(options.actions||[{id: "clear", label: "Clear filters"}])}</div>`;

/**
 * Error. Three things in order: what happened, whether the person's work is safe,
 * and what to do next. The reference id sits beside the sentence for support to
 * quote, and never inside it where it would be read as part of the explanation.
 * @param {object} options {title, what, safe, reference, actions}
 */
const error = (options={}) => `<div class="state error" role="alert">
    <h3>${esc(options.title||"Something went wrong")}</h3>
    <p>${esc(options.what)}</p>
    ${options.safe ? `<p class="safety">${esc(options.safe)}</p>` : ""}
    <div class="row" style="gap:8px;margin-top:6px">
        ${_actions(options.actions||[{id: "retry", label: "Retry", primary: true}])}
        ${options.reference ? `<span class="ref">${esc(options.reference)}</span>` : ""}
    </div></div>`;

/**
 * Offline. The clock never stops, so this states what is still happening rather
 * than only what is not.
 * @param {object} options {buffered}
 */
const offline = (options={}) => `<div class="state offline" role="status">
    <h3>You are offline</h3>
    <p>Time is still recording locally and syncs when you reconnect.${
        options.buffered ? ` ${esc(options.buffered)} buffered.` : ""}</p>
    <p class="t3 xs">Writes queue. The clock never stops.</p></div>`;

/**
 * Permission denied. Names who can instead, because a refusal with nobody
 * attached to it becomes a support ticket.
 * @param {object} options {title, who_can, actions}
 */
const denied = (options={}) => `<div class="state denied" role="alert">
    <h3>${esc(options.title||"You cannot open this")}</h3>
    <p>${esc(options.who_can||"")}</p>
    ${_actions(options.actions||[{id: "request", label: "Request access"}])}</div>`;

/**
 * Degraded. The age of the data is part of the message — stale data presented
 * without its age is the failure A8 exists to prevent.
 * @param {object} options {source, age, safe}
 */
const degraded = (options={}) => `<div class="state" role="status">
    <h3>${esc(options.source||"This")} is behind</h3>
    <p>Last synced ${esc(options.age)}. ${esc(options.safe||"Your own edits are safe.")}</p>
    ${_actions([{id: "sync", label: "Sync now", primary: true}])}</div>`;

/**
 * Conflict. Two versions side by side; the person picks and the discarded one
 * stays in the record. Never auto-merged.
 * @param {object} options {title, mine, theirs}
 */
const conflict = (options={}) => `<div class="state" role="alert">
    <h3>${esc(options.title||"This changed while you were away")}</h3>
    <p>Your version and theirs, side by side. Nothing is discarded silently.</p>
    <div class="conflict">
        <div class="side"><h4>Keep mine</h4><pre>${esc(options.mine)}</pre></div>
        <div class="side"><h4>Keep theirs</h4><pre>${esc(options.theirs)}</pre></div>
    </div>
    ${_actions([{id: "mine", label: "Keep mine"}, {id: "theirs", label: "Keep theirs"}])}</div>`;

/**
 * A confirm that states its consequences before it offers the verb.
 *
 * Used for both the destructive case, where A4 requires the collateral damage to
 * be itemised, and for C2's clock-out, where what is being confirmed is a total
 * and a list of things still open behind it. Same dialog, different tone.
 *
 * @param {object} options {title, body, collateral:[string], irreversible,
 *      confirmLabel, danger}
 * @returns {Promise<boolean>} true only on an explicit confirm
 */
function confirmAction(options={}) {
    return new Promise(resolve => {
        const back = document.createElement("div");
        back.className = "confirm-back";
        back.innerHTML = `<div class="confirm" role="dialog" aria-modal="true">
            <h3>${esc(options.title)}</h3>
            ${options.body ? `<p class="t2 sm" style="margin-top:6px">${esc(options.body)}</p>` : ""}
            ${(options.collateral||[]).length ? `<ul class="collateral">${
                options.collateral.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
            ${options.irreversible ? `<div class="irreversible">This cannot be undone.</div>` : ""}
            <div class="actions">
                <button class="btn" data-x="cancel">${esc(options.cancelLabel||"Cancel")}</button>
                <button class="btn ${options.danger?"danger":"pri"}" data-x="confirm">${esc(options.confirmLabel||"Confirm")}</button>
            </div></div>`;

        const done = answer => {back.remove(); document.removeEventListener("keydown", onKey); resolve(answer);};
        const onKey = event => {if (event.key == "Escape") done(false);};
        back.addEventListener("click", event => {
            const choice = event.target.getAttribute?.("data-x");
            if (choice) done(choice == "confirm");
            else if (event.target == back) done(false);     // clicking the backdrop cancels, never confirms
        });
        document.addEventListener("keydown", onKey);
        document.body.appendChild(back);
        back.querySelector('[data-x="cancel"]').focus();
    });
}

/**
 * The undo toast. One at a time, bottom-left, six seconds — an optimistic update
 * without an undo is a change the person did not agree to.
 * @param {object} options {message, undo}
 */
function toast(options={}) {
    const region = document.querySelector(".toasts") || (_ => {
        const created = document.createElement("div"); created.className = "toasts";
        document.body.appendChild(created); return created;})();
    region.innerHTML = "";      // one at a time

    const element = document.createElement("div");
    element.className = "toast"; element.setAttribute("role", "status");
    element.innerHTML = `<span>${esc(options.message)}</span>${
        options.undo ? `<button class="undo">Undo</button>` : ""}`;
    region.appendChild(element);

    const timer = setTimeout(_ => element.remove(), options.ms || TOAST_MS);
    if (options.undo) element.querySelector(".undo").addEventListener("click", _ => {
        clearTimeout(timer); element.remove(); options.undo();
    });
    return _ => {clearTimeout(timer); element.remove();};
}

/**
 * Wires the buttons a state renderer produced. Screens call this rather than
 * attaching listeners to markup they did not write.
 * @param {HTMLElement} root The element the state was rendered into
 * @param {object} handlers Keyed by the action id
 */
function bind(root, handlers={}) {
    for (const button of root.querySelectorAll("[data-action]")) {
        const id = button.getAttribute("data-action");
        if (handlers[id]) button.addEventListener("click", handlers[id]);
    }
}

/** The destructive case: collateral itemised, irreversible stated, danger tone. */
const confirmDestructive = (options={}) => confirmAction({...options, danger: true,
    irreversible: options.irreversible !== false, confirmLabel: options.confirmLabel||"Delete"});

export const states = {loading, empty, filteredEmpty, error, offline, denied, degraded, conflict,
    confirmAction, confirmDestructive, toast, bind, esc};
