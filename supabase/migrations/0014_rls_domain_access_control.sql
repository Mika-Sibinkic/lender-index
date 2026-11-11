-- 0014: Restrict all data-access policies to authorized users only.
--
-- Previously every SELECT policy used qual='true' meaning any authenticated
-- Clerk user could read all lender data. This migration locks every table
-- down to the @yourcompany.example email domain and owner@yourcompany.example only.
-- Superseded by 0025, which reads the allowlist from public.access_allowlist.
--
-- Rollback: drop _is_authorized_user(), re-create the dropped policies with
-- qual='true', drop the *_authorized replacements.

CREATE OR REPLACE FUNCTION _is_authorized_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT (
    lower(auth.jwt() ->> 'email') LIKE '%@yourcompany.example'
    OR lower(auth.jwt() ->> 'email') = 'owner@yourcompany.example'
  )
$$;

-- funding_sources
DROP POLICY IF EXISTS fs_select_authenticated ON funding_sources;
CREATE POLICY fs_select_authorized ON funding_sources
  FOR SELECT USING (_is_authorized_user());

-- funding_source_tag
DROP POLICY IF EXISTS fst_select ON funding_source_tag;
CREATE POLICY fst_select_authorized ON funding_source_tag
  FOR SELECT USING (_is_authorized_user());

-- funding_source_embeddings
DROP POLICY IF EXISTS fse_select_authenticated ON funding_source_embeddings;
CREATE POLICY fse_select_authorized ON funding_source_embeddings
  FOR SELECT USING (_is_authorized_user());

-- funding_source_contacts
DROP POLICY IF EXISTS fsc_select ON funding_source_contacts;
CREATE POLICY fsc_select_authorized ON funding_source_contacts
  FOR SELECT USING (_is_authorized_user());

-- funding_source_edits
DROP POLICY IF EXISTS fse_select ON funding_source_edits;
CREATE POLICY fse_select_authorized ON funding_source_edits
  FOR SELECT USING (_is_authorized_user());

-- funding_source_documents (was ALL qual=true — split: domain read, editor write)
DROP POLICY IF EXISTS fsd_all ON funding_source_documents;
CREATE POLICY fsd_select_authorized ON funding_source_documents
  FOR SELECT USING (_is_authorized_user());
CREATE POLICY fsd_insert_editor ON funding_source_documents
  FOR INSERT WITH CHECK (_is_editor());
CREATE POLICY fsd_update_editor ON funding_source_documents
  FOR UPDATE USING (_is_editor()) WITH CHECK (_is_editor());
CREATE POLICY fsd_delete_editor ON funding_source_documents
  FOR DELETE USING (_is_editor());

-- borrower
DROP POLICY IF EXISTS borrower_select ON borrower;
CREATE POLICY borrower_select_authorized ON borrower
  FOR SELECT USING (_is_authorized_user());

-- borrower_funding_source_link
DROP POLICY IF EXISTS bfsl_select ON borrower_funding_source_link;
CREATE POLICY bfsl_select_authorized ON borrower_funding_source_link
  FOR SELECT USING (_is_authorized_user());

-- closed_deal
DROP POLICY IF EXISTS cd_select ON closed_deal;
CREATE POLICY cd_select_authorized ON closed_deal
  FOR SELECT USING (_is_authorized_user());

-- deal_outcomes
DROP POLICY IF EXISTS deal_outcomes_select_authenticated ON deal_outcomes;
CREATE POLICY deal_outcomes_select_authorized ON deal_outcomes
  FOR SELECT USING (_is_authorized_user());

-- graph_entity
DROP POLICY IF EXISTS graph_entity_select ON graph_entity;
CREATE POLICY graph_entity_select_authorized ON graph_entity
  FOR SELECT USING (_is_authorized_user());

-- graph_edge
DROP POLICY IF EXISTS graph_edge_select ON graph_edge;
CREATE POLICY graph_edge_select_authorized ON graph_edge
  FOR SELECT USING (_is_authorized_user());

-- proposed_field
DROP POLICY IF EXISTS pf_select ON proposed_field;
CREATE POLICY pf_select_authorized ON proposed_field
  FOR SELECT USING (_is_authorized_user());

-- parse_logs: restrict SELECT + tighten UPDATE to admin-only
DROP POLICY IF EXISTS parse_logs_select_authenticated ON parse_logs;
CREATE POLICY parse_logs_select_authorized ON parse_logs
  FOR SELECT USING (_is_authorized_user());
DROP POLICY IF EXISTS parse_logs_update_authenticated ON parse_logs;
CREATE POLICY parse_logs_update_admin ON parse_logs
  FOR UPDATE USING (_is_admin());

-- cost_log
DROP POLICY IF EXISTS cost_log_select_authenticated ON cost_log;
CREATE POLICY cost_log_select_authorized ON cost_log
  FOR SELECT USING (_is_authorized_user());

-- tag (metadata but still domain-gate)
DROP POLICY IF EXISTS tag_select ON tag;
CREATE POLICY tag_select_authorized ON tag
  FOR SELECT USING (_is_authorized_user());

-- users (org members can see each other; still domain-gated)
DROP POLICY IF EXISTS users_select_authenticated ON users;
CREATE POLICY users_select_authorized ON users
  FOR SELECT USING (_is_authorized_user());
