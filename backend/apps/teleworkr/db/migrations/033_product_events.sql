-- 033_product_events.sql — A10, the product-analytics event store. Deliberately
-- not audit_event: that table is append-only, hash-chained, 7-year, per-person
-- (H4, a compliance obligation). This one is disposable — 90 days raw, then
-- rolled into product_event_daily_agg with the person reference dropped. No
-- person_id column exists here at all, only the derived, non-reversible
-- person_ref, so this table is structurally outside the person-erasure
-- cascade (entityshapes.js/candidateretention.js) — there is nothing in it to
-- delete per person.

CREATE TABLE product_event (
    event_id varchar not null primary key,
    org_id varchar not null,
    action varchar not null,            -- object.action, past tense, lower snake (A10 naming)
    person_ref varchar,                 -- pseudonymous, stable within an org; never a person_id
    occurred_at integer not null,
    source varchar not null,            -- web | mobile | api | system
    schema_version integer not null,
    detail varchar,                     -- JSON shapes and counts; never content a person typed
    created_at integer not null         -- when stored; the 90-day raw retention is anchored to this
);
CREATE INDEX idx_product_event_action ON product_event(org_id, action, occurred_at);
CREATE INDEX idx_product_event_created ON product_event(org_id, created_at);

-- What survives the 90-day rollup: the long count series, with the individual
-- trail (and the person reference) gone.
CREATE TABLE product_event_daily_agg (
    org_id varchar not null,
    event_date varchar not null,        -- ISO date
    action varchar not null,
    event_count integer not null,
    PRIMARY KEY (org_id, event_date, action)
);
