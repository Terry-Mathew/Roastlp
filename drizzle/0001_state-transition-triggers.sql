CREATE FUNCTION enforce_roastmylp_state_transition() RETURNS trigger AS $$
DECLARE
	allowed boolean := false;
BEGIN
	IF OLD.state = NEW.state THEN
		RETURN NEW;
	END IF;

	allowed := CASE TG_TABLE_NAME
		WHEN 'roasts' THEN (OLD.state::text, NEW.state::text) IN (
			('awaiting_payment', 'ready_for_fulfillment'), ('awaiting_payment', 'terminal_failure'), ('awaiting_payment', 'deleted'),
			('ready_for_fulfillment', 'queued'), ('ready_for_fulfillment', 'refund_pending'), ('ready_for_fulfillment', 'terminal_failure'),
			('queued', 'processing'), ('queued', 'refund_pending'), ('queued', 'terminal_failure'),
			('processing', 'completed'), ('processing', 'refund_pending'), ('processing', 'terminal_failure'),
			('completed', 'deleted'), ('terminal_failure', 'refund_pending'), ('terminal_failure', 'deleted'),
			('refund_pending', 'refunded'), ('refunded', 'deleted')
		)
		WHEN 'payments' THEN (OLD.state::text, NEW.state::text) IN (
			('created', 'authorized'), ('created', 'captured'), ('created', 'failed'),
			('authorized', 'captured'), ('authorized', 'failed'),
			('captured', 'partially_refunded'), ('captured', 'refunded'),
			('partially_refunded', 'refunded')
		)
		WHEN 'audit_jobs' THEN (OLD.state::text, NEW.state::text) IN (
			('pending', 'leased'), ('pending', 'cancelled'),
			('leased', 'retry_scheduled'), ('leased', 'succeeded'), ('leased', 'failed'),
			('retry_scheduled', 'leased'), ('retry_scheduled', 'cancelled')
		)
		WHEN 'job_attempts' THEN (OLD.state::text, NEW.state::text) IN (
			('running', 'succeeded'), ('running', 'retryable_failure'), ('running', 'terminal_failure')
		)
		WHEN 'webhook_events' THEN (OLD.state::text, NEW.state::text) IN (
			('received', 'processing'), ('received', 'rejected'),
			('processing', 'processed'), ('processing', 'failed'),
			('failed', 'processing'), ('failed', 'rejected')
		)
		WHEN 'refunds' THEN (OLD.state::text, NEW.state::text) IN (
			('requested', 'processing'), ('requested', 'succeeded'), ('requested', 'failed'),
			('processing', 'succeeded'), ('processing', 'failed'), ('failed', 'processing')
		)
		ELSE false
	END;

	IF NOT allowed THEN
		RAISE EXCEPTION 'invalid % state transition: % -> %', TG_TABLE_NAME, OLD.state, NEW.state
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER roasts_state_transition BEFORE UPDATE OF state ON roasts FOR EACH ROW EXECUTE FUNCTION enforce_roastmylp_state_transition();
--> statement-breakpoint
CREATE TRIGGER payments_state_transition BEFORE UPDATE OF state ON payments FOR EACH ROW EXECUTE FUNCTION enforce_roastmylp_state_transition();
--> statement-breakpoint
CREATE TRIGGER audit_jobs_state_transition BEFORE UPDATE OF state ON audit_jobs FOR EACH ROW EXECUTE FUNCTION enforce_roastmylp_state_transition();
--> statement-breakpoint
CREATE TRIGGER job_attempts_state_transition BEFORE UPDATE OF state ON job_attempts FOR EACH ROW EXECUTE FUNCTION enforce_roastmylp_state_transition();
--> statement-breakpoint
CREATE TRIGGER webhook_events_state_transition BEFORE UPDATE OF state ON webhook_events FOR EACH ROW EXECUTE FUNCTION enforce_roastmylp_state_transition();
--> statement-breakpoint
CREATE TRIGGER refunds_state_transition BEFORE UPDATE OF state ON refunds FOR EACH ROW EXECUTE FUNCTION enforce_roastmylp_state_transition();
