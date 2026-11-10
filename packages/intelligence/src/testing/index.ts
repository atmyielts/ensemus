// Test doubles. Lint blocks this path from apps/ and workers/, so it can never reach a shipped image.
export { ScriptedModelAdapter, type ScriptStep } from './scripted-adapter';
export { RecordingLender } from './recording-lender';
