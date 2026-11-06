// What knowledge's Activities are handed, by the process that runs them. Nothing here reaches the web tier
// (lint). The knowledge worker has no credential and no model. Only the agent worker gets `model`, and only
// the connector worker gets a connector.
import type { IngestDeps } from '@ensemus/application/knowledge/ingest';
import type { AgentRuns, RunTranscriptPurge } from '@ensemus/application/knowledge/ports';
import type { ObjectStore } from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import type { KnowledgeModelPort } from '@ensemus/knowledge/ports';

export type KnowledgeWorkerDeps = {
  database: AppDatabase;
  store: ObjectStore;
  ingest: IngestDeps;
  transcripts: RunTranscriptPurge;
};

export type KnowledgeModelDeps = {
  database: AppDatabase;
  model: KnowledgeModelPort;
};

export type OnboardingDeps = {
  database: AppDatabase;
  agentRuns: AgentRuns;
};
