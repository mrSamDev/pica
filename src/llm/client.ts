export interface LLMClient {
  review(prompt: string): Promise<string>;
}
