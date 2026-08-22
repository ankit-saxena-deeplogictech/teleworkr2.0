/**
 * certificate-row — one P5 certificate, and its countdown states.
 *
 * A certificate is a record, not a file: the PDF is rendered from it on
 * demand. Expiry is warned, not discovered — the 90/30/7-day countdown is
 * derived from the record and never stored. Expired and superseded records
 * stay, because "was she certified in March" is the question an audit asks.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {states} from "../states.mjs";

const _esc = states.esc;
const _ymd = seconds => seconds ? new Date(seconds*1000).toLocaleDateString(undefined,
    {year: "numeric", month: "short", day: "numeric"}) : "—";

/**
 * Renders one certificate row.
 * @param {object} row The certificate from the certificates API
 * @returns {string} HTML
 */
function render(row) {
    const tone = row.state == "expired" ? "expired" :
        row.state == "superseded" ? "superseded" :
        row.warning ? "warn" : "valid";
    return `<div class="cert ${tone}" data-cert="${_esc(row.certificate_id)}">
        <div class="cert-main">
            <div class="grow">
                <div class="cert-title">${_esc(row.title)}
                    <span class="cert-state s-${row.state}">${_esc(row.state)}</span>
                    ${row.external ? `<span class="cert-state s-ext">external${row.verified_by ? "" : " · unverified"}</span>` : ""}
                </div>
                <div class="sm t3">v${row.version} · issued ${_ymd(row.issued_at)}${
                    row.expires_on ? ` · expires ${_esc(row.expires_on)}` : " · does not expire"}</div>
            </div>
            <div class="cert-right">
                ${row.warning ? `<span class="cert-warn">Expires in ${row.days_left} days</span>` : ""}
                <span class="mono cert-code" title="Verification code">${_esc(row.verification_code)}</span>
            </div>
        </div>
        <div class="cert-actions">
            <button class="btn" data-cert="view">View</button>
            <button class="btn" data-cert="verify">Verify</button>
        </div>
    </div>`;
}

/** Wires the buttons of a rendered list. @param {object} handlers {view, verify} keyed by certificate_id */
function wire(root, handlers={}) {
    for (const row of root.querySelectorAll("[data-cert]")) {
        const id = row.getAttribute("data-cert");
        row.querySelector("[data-cert=\"view\"]")?.addEventListener("click",
            _ => handlers.view?.(id));
        row.querySelector("[data-cert=\"verify\"]")?.addEventListener("click",
            _ => handlers.verify?.(id));
    }
}

export const certificateRow = {render, wire};
