-- 019_recruitment_offers.sql — K8, offer, approval matrix & acceptance.
--
-- The wireframe is explicit that the offer approval matrix is not a future
-- enhancement: offers carry compensation, legal and equity risk, and an
-- out-of-band approval is exactly what causes pay disparity. Unlike K3's
-- requisition approval (one step, deliberately simplified), K8 keeps the
-- wireframe's core claim — the approval route is COMPUTED from the offer's
-- own attributes, never a fixed chain.
--
-- One real constraint reshapes that computation. The wireframe names
-- specific approver roles (hiring manager, HR, Finance); this app's actual
-- permission model has four built-in roles (employee/lead/hr/admin) and no
-- "finance" or per-requisition "hiring manager" concept. Rather than
-- fabricate roles the system doesn't have, the offer computes a
-- REQUIRED-APPROVAL-COUNT (1/2/3) from band percentile and bonus size; each
-- approval still needs offer.approve (hr/admin) but must come from a
-- distinct person — the risk-scaling mechanism survives; the invented role
-- names don't. `offer_approval` is what enforces "distinct."
--
-- A negotiation creates a revision, not a second offer — the same
-- versioned-with-supersession shape as every other definition in this
-- schema. Version 1 is retained, exactly as the wireframe asks.
--
-- band_min/band_max on requisition let the percentile be computed against
-- the requisition's own declared range. Percentile against current team
-- members' actual compensation is NOT attempted — employment carries no
-- compensation field anywhere in this schema, and adding one is an
-- employment-domain change outside recruitment's scope.
--
-- No e-signature integration (sent/viewed are plain status the recruiter
-- sets), no legal-owned versioned letter templates (letter_note is a plain
-- field). Erasure is declared in entityshapes.js: offer_version and
-- offer_approval follow application — erase, 6 months, anchored to the
-- requisition closing.

ALTER TABLE requisition ADD COLUMN band_min integer;
ALTER TABLE requisition ADD COLUMN band_max integer;

-- One offer sequence per application. Negotiation supersedes the current
-- version and inserts the next; withdrawn is a legal event, so it always
-- carries a reason.
CREATE TABLE offer_version (
    offer_version_id varchar not null primary key,
    org_id varchar not null,
    application_id varchar not null,
    version integer not null,
    status varchar not null default 'pending_approval',
        -- pending_approval | approved | sent | viewed | negotiating | accepted | declined | expired | withdrawn
    fixed_amount integer not null,
    variable_amount integer,
    joining_bonus integer,
    start_date varchar not null,           -- ISO date
    expires_on varchar not null,           -- ISO date
    band_min integer,                      -- snapshot from the requisition at creation
    band_max integer,
    percentile integer,                    -- computed; shown on screen, never recomputed on read
    rationale varchar,                     -- required whenever required_approvals > 1
    required_approvals integer not null,   -- 1 | 2 | 3, computed at creation
    decline_reason varchar,                -- compensation | counter_offer | another_offer | location | role_scope | timing | personal | other
    decline_detail varchar,
    superseded_by_version_id varchar,      -- set once a negotiation creates the next version
    letter_note varchar,
    offered_by varchar not null,
    created_at integer not null,
    sent_at integer,
    responded_at integer,
    withdrawn_at integer,
    withdrawn_reason varchar,
    client_event_id varchar,               -- offline-sync idempotency, same contract as A8
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_offer_version ON offer_version(org_id, application_id, version);
CREATE UNIQUE INDEX idx_offer_client ON offer_version(org_id, client_event_id)
    WHERE client_event_id IS NOT NULL;

-- One row per approval received. The unique index over (offer_version_id,
-- approver_person_id) is what makes "a distinct person" a fact the database
-- enforces, not a rule the application layer has to remember to check.
CREATE TABLE offer_approval (
    offer_approval_id varchar not null primary key,
    org_id varchar not null,
    offer_version_id varchar not null,
    approver_person_id varchar not null,
    approved_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_offer_approval_once ON offer_approval(org_id, offer_version_id, approver_person_id);
