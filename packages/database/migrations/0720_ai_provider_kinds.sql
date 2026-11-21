-- Five more provider kinds for model profiles (ADR-028 FD-10, FD-11, FD-21): Gemini, Azure OpenAI and Bedrock
-- for generation, and Cohere and Voyage for native rerank. Each is a hosted kind, so a key for one needs the
-- operator's review interlock, and its address is checked against fixed host rules in
-- packages/policy/src/endpoint.ts. Nothing else changes: an existing row keeps its kind, `provider_kind` is
-- still fixed once written (0101), and packages/domain/src/ai.ts holds the same list.
ALTER TABLE "ai"."model_profiles" DROP CONSTRAINT "model_profiles_kind_check";
--> statement-breakpoint
ALTER TABLE "ai"."model_profiles" ADD CONSTRAINT "model_profiles_kind_check" CHECK ("ai"."model_profiles"."provider_kind" in ('openai_hosted','anthropic_hosted','openai_compatible','local_openai_compatible','gemini_hosted','azure_openai','bedrock_hosted','cohere_hosted','voyage_hosted'));
