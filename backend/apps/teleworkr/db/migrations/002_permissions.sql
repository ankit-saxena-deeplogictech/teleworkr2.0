-- 002_permissions.sql — L2 roles as named bundles over capability x scope.
--
-- capability_grant already exists in 001 because L2 scopes are read on every
-- request. This adds the bundles that produce grants, and the last-used stamp
-- the quarterly access review needs.
--
-- Roles are not versioned. They do not need to be: H4 pins the effective
-- permission set into each audit row, so "who could see this in March" is
-- answered from the audit entry rather than from a role history.

CREATE TABLE role (
    role_id varchar not null primary key,
    org_id varchar not null,
    name varchar not null,
    description varchar,
    is_builtin integer not null default 0,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_role_name ON role(org_id, name);

-- An edge with its own attributes: the same capability appears in several roles
-- at different scopes, and that difference is the whole point of the model.
CREATE TABLE role_capability (
    role_capability_id varchar not null primary key,
    org_id varchar not null,
    role_id varchar not null,
    capability varchar not null,
    scope_type varchar not null,
    scope_ref varchar,
    effect varchar not null default 'allow',
    created_at integer not null,
    FOREIGN KEY (role_id) REFERENCES role(role_id)
);
CREATE INDEX idx_role_capability ON role_capability(org_id, role_id);
CREATE UNIQUE INDEX idx_role_capability_unique ON role_capability(role_id, capability, scope_type, IFNULL(scope_ref,''));

-- The access review lists every grant outside the built-in roles with its owner
-- and last-used date, and proposes anything unused for 90 days for removal.
ALTER TABLE capability_grant ADD COLUMN last_used_at integer;
