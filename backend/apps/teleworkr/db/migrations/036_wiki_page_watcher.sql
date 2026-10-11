-- 036_wiki_page_watcher.sql — completes comment_mention's wiki half ("...wiki
-- change"). The exact task_watcher shape (007_tasks.sql), renamed: no
-- invention, wiki pages simply never had this concept until now.

CREATE TABLE wiki_page_watcher (
    wiki_page_watcher_id varchar not null primary key,
    org_id varchar not null,
    page_id varchar not null,
    person_id varchar not null,
    created_at integer not null,
    FOREIGN KEY (page_id) REFERENCES wiki_page(page_id)
);
CREATE UNIQUE INDEX idx_wiki_page_watcher ON wiki_page_watcher(org_id, page_id, person_id);
