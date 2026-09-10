-- Enforce recipient authority after the controlled legacy backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.sync_appointment_customer_parties()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.recipient_customer_id IS NULL THEN
    RAISE EXCEPTION 'appointment recipient_customer_id is required' USING ERRCODE='23502';
  END IF;
  IF NEW.booker_customer_id IS NULL THEN
    RAISE EXCEPTION 'appointment booker_customer_id is required' USING ERRCODE='23502';
  END IF;
  IF NEW.customer_id IS NULL THEN NEW.customer_id:=NEW.recipient_customer_id; END IF;
  IF NEW.customer_id IS DISTINCT FROM NEW.recipient_customer_id THEN
    RAISE EXCEPTION 'appointment customer_id must equal recipient_customer_id' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER appointments_customer_parties_sync_trigger
BEFORE INSERT OR UPDATE OF customer_id,booker_customer_id,recipient_customer_id
ON public.appointments FOR EACH ROW
EXECUTE FUNCTION public.sync_appointment_customer_parties();

ALTER TABLE public.appointments ADD CONSTRAINT appointments_customer_recipient_match_check
  CHECK (customer_id=recipient_customer_id) NOT VALID;
ALTER TABLE public.appointments VALIDATE CONSTRAINT appointments_customer_recipient_match_check;
ALTER TABLE public.appointments ALTER COLUMN booker_customer_id SET NOT NULL;
ALTER TABLE public.appointments ALTER COLUMN recipient_customer_id SET NOT NULL;

COMMIT;
