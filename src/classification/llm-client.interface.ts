// returns raw text on purpose, not a typed object. a real LLM gives you
// text, not truth. run it through parseClassificationResponse before you
// trust any of it
export interface LlmTicketInput {
  subject: string;
  body: string;
}

export interface LlmClient {
  classify(ticket: LlmTicketInput): Promise<string>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');
