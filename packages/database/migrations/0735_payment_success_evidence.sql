-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Hosted checkout must not turn absence of evidence into permission (ADR-032 D4).
-- With no checkout row, FALSE OR FALSE OR NULL is NULL. PL/pgSQL IF NOT NULL does not refuse it.
-- Keep the current native payment/checkout guards and require explicitly true success evidence.
DO $$
DECLARE body text; changed text;
BEGIN
  body:=pg_get_functiondef('billing.check_payment_change()'::regprocedure);
  IF position('checkout.state' in body)=0 THEN
    RAISE EXCEPTION 'PAYMENT_SUCCESS_GUARD_UNEXPECTED' USING ERRCODE='55000';
  END IF;
  changed:=replace(body,'IF NOT evidence THEN','IF evidence IS NOT TRUE THEN');
  IF changed=body THEN
    RAISE EXCEPTION 'PAYMENT_SUCCESS_GUARD_UNEXPECTED' USING ERRCODE='55000';
  END IF;
  EXECUTE changed;
END $$;
