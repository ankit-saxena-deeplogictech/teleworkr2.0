-- 030_candidate_diversity.sql — K12 slice 3: diversity data, collected
-- optionally and stored apart from the candidate record decision-makers
-- see. Never joined into candidateRecordAsync/pipelineBoardAsync — only
-- lib/diversity.js's own aggregate-only reporting ever reads this table.

CREATE TABLE candidate_diversity_data (
    candidate_id varchar not null primary key,
    org_id varchar not null,
    gender varchar,              -- woman | man | non_binary | prefer_not_to_say
    ethnicity varchar,           -- free text, or prefer_not_to_say — no universal taxonomy across jurisdictions
    disability_status varchar,   -- yes | no | prefer_not_to_say
    collected_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
