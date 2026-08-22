-- 016_surveys.sql — Q, the survey domain, and its anonymity contract.
--
-- Q is the riskiest module in the wireframe set, so the anonymity contract is
-- structural rather than procedural (Q1): the mode is a property of the survey,
-- fixed at publish, and it cannot be changed afterwards — because the promise
-- was made to people who have already answered.
--
-- Three entities, as always: a versioned survey definition with a published
-- pointer, an invitation edge (person × survey, records that you were asked and
-- whether you responded — never what you answered), and an append-only response
-- ledger pinned to the version answered.
--
-- The link between the last two is what the mode controls:
--   attributed   responses carry person_id and link to the invitation
--   confidential invitation marked responded; responses carry only a
--                respondent token — no link back (the honest default)
--   anonymous    no invitation rows at all; responses carry only a token;
--                response count is the only progress signal
--
-- Erasure is declared in entityshapes.js: the definition is retained, the
-- invitation erases after 13 months, and confidential/anonymous responses are
-- already anonymous — an L3 erasure request cannot damage a survey result.

CREATE TABLE survey_version (
    survey_version_id varchar not null primary key,
    org_id varchar not null,
    survey_code varchar not null,
    version integer not null,
    status varchar not null default 'published',   -- draft | published | closed | results_published | withdrawn
    title varchar not null,
    mode varchar not null,             -- attributed | confidential | anonymous — fixed at publish
    sections varchar not null,         -- JSON: [{id, title, questions: [{id, text, type, options, required, free_text}]}]
    audience varchar not null,         -- JSON: {jurisdictions, contract_types, roles, include_contractors}
    opens_on varchar not null,         -- ISO date
    closes_on varchar not null,        -- ISO date; the only field that may change after publish
    owner_person_id varchar not null,  -- the named survey owner
    results_visible_to varchar not null default 'invited',  -- chosen before any answer exists
    owner_response varchar,            -- written by the owner before results publish
    published_at integer,
    published_by varchar,
    results_published_at integer,
    withdrawn_at integer,
    withdrawn_reason varchar,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_survey_version ON survey_version(org_id, survey_code, version);

-- The published pointer per survey code.
CREATE TABLE survey_pointer (
    org_id varchar not null,
    survey_code varchar not null,
    survey_version_id varchar not null,
    updated_at integer not null,
    PRIMARY KEY (org_id, survey_code)
);

-- The invitation edge. Written at publish for attributed and confidential
-- modes; NEVER written for anonymous mode, where nobody knows who to remind.
CREATE TABLE survey_invitation (
    invitation_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    survey_code varchar not null,
    survey_version_id varchar not null,
    status varchar not null default 'invited',     -- invited | responded
    responded_at integer,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_survey_invitation_person ON survey_invitation(org_id, person_id, status);
CREATE INDEX idx_survey_invitation_survey ON survey_invitation(org_id, survey_code, status);

-- The append-only response ledger. person_id is set ONLY in attributed mode;
-- respondent_token is the client-held resume key for confidential and anonymous
-- modes; invitation_id is set ONLY in attributed mode. The columns a mode does
-- not use stay NULL — the link cannot be rebuilt later because it was never
-- written.
CREATE TABLE survey_response_event (
    response_event_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar,               -- attributed mode only
    survey_code varchar not null,
    survey_version_id varchar not null,
    invitation_id varchar,           -- attributed mode only
    respondent_token varchar,        -- confidential + anonymous modes; the resume key
    kind varchar not null,           -- answer | skipped | submitted
    section_id varchar,
    question_id varchar,             -- NULL for kind=submitted
    value varchar,                   -- JSON: a scale number, an option code, or free text
    client_event_id varchar,         -- offline-sync idempotency, same contract as A8
    recorded_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_survey_response_survey ON survey_response_event(org_id, survey_code);
CREATE INDEX idx_survey_response_person ON survey_response_event(org_id, person_id);
CREATE INDEX idx_survey_response_token ON survey_response_event(org_id, survey_code, respondent_token);
CREATE UNIQUE INDEX idx_survey_response_client ON survey_response_event(org_id, client_event_id)
    WHERE client_event_id IS NOT NULL;
