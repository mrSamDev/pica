// Shared LLM test double: records each request (url + init) and answers with
// a canned Response from the test's responder.
export interface CapturedCall {
  url: string;
  init: RequestInit;
}

export function captureFetch(responder: (call: CapturedCall) => Response) {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return { fetchImpl, calls };
}
