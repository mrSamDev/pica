CREATE UNIQUE INDEX "rule_evidence_rule_finding_unique" ON "rule_evidence" USING btree ("rule_id","finding_id");

-- Immutable event stream (§3): learning_events is append-only. A worker bug
-- or manual mistake must not be able to rewrite history, because the rebuild
-- test relies on the log being trustworthy. Enforced in the DB, not by convention.
CREATE OR REPLACE FUNCTION prevent_learning_event_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'learning_events are immutable: UPDATE/DELETE rejected';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_events_immutable ON learning_events;
CREATE TRIGGER learning_events_immutable
    BEFORE UPDATE OR DELETE ON learning_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_learning_event_mutation();