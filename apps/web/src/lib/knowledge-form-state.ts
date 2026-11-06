export type KnowledgePassageResult = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  text: string;
  classification: string;
};
export type KnowledgeFormState = {
  code?: string;
  values?: Record<string, string>;
  passages?: readonly KnowledgePassageResult[];
  searched?: boolean;
  simulation?: readonly {
    key: string;
    classification: string;
    purpose: string;
    wouldTransmit: boolean;
    reasonCode: string;
  }[];
  coverage?: 'knowledge_only' | 'complete';
};
export type KnowledgeField = {
  name: string;
  label: string;
  kind?: 'text' | 'textarea' | 'email' | 'select' | 'checkbox' | 'file';
  required?: boolean;
  maxLength?: number;
  value?: string;
  help?: string;
  options?: readonly { value: string; label: string }[];
};
