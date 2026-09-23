-- 021_wiki.sql — N, wiki & documentation.
--
-- Same shape as every other published thing in this app: space -> page tree
-- -> page -> version, with the published version a pointer and history
-- append-only. Nothing here is edited in place; a revert moves the pointer.
--
-- capabilities.js already declared wiki.publish_public, with
-- irreversible:true, before this module existed — audit.performAsync
-- refuses to run an irreversible capability without a precheck function,
-- which is exactly the pre-publish scan N3 calls for. The scan was
-- expected before it had anywhere to run.
--
-- Narrowed, deliberately: no G2 (files) exists, so an embedded reference is
-- a plain URL/text string and the public-publish scan blocks on any
-- non-empty reference rather than checking a sharing state that doesn't
-- exist. No rich/collaborative editor exists anywhere in this app; a page
-- body is an ordered list of {heading, body} plain-text sections, not
-- blocks/tables/code/embeds, and there is no concurrent-edit presence or
-- locking. Page-to-page links are author-curated (linked_page_ids), not
-- parsed from text — no markup parser exists anywhere in this app either.
-- Space membership is its own plain edge table rather than routed through
-- the permission engine's TEAM scope, which needs scope_ref plumbing no
-- builtin role has (the same gap K already hit). Personal spaces are
-- deferred, same as the wireframe's own "Open" note defers them.

CREATE TABLE wiki_space (
    space_id varchar not null primary key,
    org_id varchar not null,
    name varchar not null,
    slug varchar not null,
    description varchar,
    kind varchar not null default 'team',              -- team | client
    default_visibility varchar not null default 'space',  -- private | space | org
    public_approver_person_id varchar,     -- named per-space approver for wiki.publish_public requests
    owner_person_id varchar not null,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_wiki_space_slug ON wiki_space(org_id, slug);

CREATE TABLE wiki_space_member (
    org_id varchar not null,
    space_id varchar not null,
    person_id varchar not null,
    added_at integer not null,
    added_by varchar,
    PRIMARY KEY (space_id, person_id)
);

-- The page's mutable wrapper: status, owner, visibility and review
-- metadata. Content itself lives in wiki_page_version, append-only, below.
CREATE TABLE wiki_page (
    page_id varchar not null primary key,
    org_id varchar not null,
    space_id varchar not null,
    parent_page_id varchar,
    title varchar not null,
    slug varchar not null,
    owner_person_id varchar,          -- NULL = unowned; cannot publish (N1 item 5)
    status varchar not null default 'draft',   -- draft | in_review | published | archived | deprecated
    visibility varchar,               -- NULL = inherit space default; else private | space | org | public
    review_cadence_months integer,    -- 3 | 6 | 12 | NULL
    last_reviewed_at integer,
    last_reviewed_by varchar,
    requires_acknowledgement integer not null default 0,
    superseded_by_page_id varchar,
    source_type varchar,              -- NULL | 'leave_policy' — N5's "renders, never copies"
    source_ref varchar,               -- e.g. a jurisdiction code, for source_type='leave_policy'
    public_slug varchar,
    allow_indexing integer,
    public_unpublished_at integer,    -- set on unpublish; the URL still resolves, stated as retracted
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_wiki_page_slug ON wiki_page(org_id, space_id, slug);
CREATE UNIQUE INDEX idx_wiki_public_slug ON wiki_page(org_id, public_slug) WHERE public_slug IS NOT NULL;
CREATE INDEX idx_wiki_page_space ON wiki_page(org_id, space_id);

CREATE TABLE wiki_page_pointer (
    org_id varchar not null,
    page_id varchar not null,
    wiki_page_version_id varchar not null,
    updated_at integer not null,
    PRIMARY KEY (org_id, page_id)
);

-- Append-only. sections: JSON [{heading, body}]. linked_page_ids: JSON
-- array of page_id, author-curated — the backlink source and the
-- pre-publish scan's own input. embedded_file_refs: JSON array of plain
-- strings (URL or text reference — no G2 object to point at yet).
CREATE TABLE wiki_page_version (
    wiki_page_version_id varchar not null primary key,
    org_id varchar not null,
    page_id varchar not null,
    version integer not null,
    sections varchar not null,
    linked_page_ids varchar not null default '[]',
    embedded_file_refs varchar not null default '[]',
    reason varchar,
    author_person_id varchar not null,
    based_on_version integer,
    created_at integer not null
);
CREATE UNIQUE INDEX idx_wiki_page_version ON wiki_page_version(org_id, page_id, version);

CREATE TABLE wiki_review (
    review_id varchar not null primary key,
    org_id varchar not null,
    page_id varchar not null,
    wiki_page_version_id varchar not null,
    reviewer_person_id varchar not null,
    status varchar not null default 'pending',   -- pending | approved
    requested_at integer not null,
    decided_at integer
);
CREATE INDEX idx_wiki_review_page ON wiki_review(org_id, page_id, wiki_page_version_id);

-- One request per decision. Approving needs BOTH wiki.publish_public and
-- being the space's named public_approver_person_id — real per-space
-- routing without TEAM-scoped capability grants.
CREATE TABLE wiki_public_request (
    request_id varchar not null primary key,
    org_id varchar not null,
    page_id varchar not null,
    requested_by varchar not null,
    reason varchar not null,
    scan_result varchar not null,     -- JSON {blocks:[...], warnings:[...], clear:bool}
    status varchar not null default 'pending',   -- pending | approved | declined
    slug varchar,
    allow_indexing integer,
    approver_person_id varchar,
    decided_at integer,
    decision_reason varchar,
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_wiki_public_request_page ON wiki_public_request(org_id, page_id);

CREATE TABLE wiki_share_link (
    share_link_id varchar not null primary key,
    org_id varchar not null,
    page_id varchar not null,
    recipient_name varchar not null,
    token varchar not null,
    expires_at integer not null,
    revoked_at integer,
    created_by varchar not null,
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_wiki_share_token ON wiki_share_link(token);
CREATE INDEX idx_wiki_share_page ON wiki_share_link(org_id, page_id);

CREATE TABLE wiki_acknowledgement (
    org_id varchar not null,
    page_id varchar not null,
    person_id varchar not null,
    wiki_page_version_id varchar not null,
    acknowledged_at integer not null,
    PRIMARY KEY (page_id, person_id)
);

CREATE TABLE wiki_page_task_link (
    org_id varchar not null,
    page_id varchar not null,
    task_ref varchar not null,
    created_at integer not null,
    created_by varchar,
    PRIMARY KEY (page_id, task_ref)
);
