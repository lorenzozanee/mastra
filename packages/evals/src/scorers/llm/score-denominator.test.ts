import { convertArrayToReadableStream, MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';

import { createAgentTestRun, createTestMessage } from '../utils';
import { createFaithfulnessScorer } from './faithfulness';
import { createHallucinationScorer } from './hallucination';

const claims = ['A', 'B', 'C', 'D'];
const claimResponse = JSON.stringify({ claims });
const makeVerdict = (verdict: string, index: number) => ({
  claim: claims[index],
  statement: claims[index],
  verdict,
  reason: 'r',
});

function mockJudge(responses: string[]) {
  let call = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      throw new Error('judge should stream');
    },
    doStream: async () => {
      const text = responses[call];
      if (text === undefined) {
        throw new Error('unexpected judge call');
      }
      call += 1;
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `r${call}`, modelId: 'scripted-judge', timestamp: new Date(0) },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: text },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
      };
    },
  });
}

const run = createAgentTestRun({
  inputMessages: [createTestMessage({ content: 'q', role: 'user' })],
  output: [createTestMessage({ content: 'A. B. C. D.', role: 'assistant' })],
});

describe('faithfulness and hallucination score denominators', () => {
  it('counts missing faithfulness verdicts against extracted claims', async () => {
    const verdicts = JSON.stringify({ verdicts: [makeVerdict('yes', 0), makeVerdict('yes', 1)] });
    const scorer = createFaithfulnessScorer({ model: mockJudge([claimResponse, verdicts, 'reason']), options: { context: ['A', 'B'] } });

    const result = await scorer.run(run);

    expect(result.score).toBe(0.5);
  });

  it('normalizes faithfulness verdict case and whitespace', async () => {
    const verdicts = JSON.stringify({ verdicts: claims.map((_, index) => makeVerdict(' Yes ', index)) });
    const scorer = createFaithfulnessScorer({ model: mockJudge([claimResponse, verdicts, 'reason']), options: { context: ['A', 'B'] } });

    const result = await scorer.run(run);

    expect(result.score).toBe(1);
  });

  it('caps faithfulness when the judge returns extra positive verdicts', async () => {
    const verdicts = JSON.stringify({ verdicts: [...claims.map((_, index) => makeVerdict('yes', index)), makeVerdict('yes', 0)] });
    const scorer = createFaithfulnessScorer({ model: mockJudge([claimResponse, verdicts, 'reason']), options: { context: ['A', 'B'] } });

    const result = await scorer.run(run);

    expect(result.score).toBe(1);
  });

  it('counts missing hallucination verdicts against extracted claims', async () => {
    const verdicts = JSON.stringify({ verdicts: [makeVerdict('yes', 0)] });
    const scorer = createHallucinationScorer({ model: mockJudge([claimResponse, verdicts, 'reason']), options: { context: ['A', 'B'] } });

    const result = await scorer.run(run);

    expect(result.score).toBe(0.25);
  });

  it('normalizes hallucination verdict case and whitespace', async () => {
    const verdicts = JSON.stringify({ verdicts: claims.map((_, index) => makeVerdict(' Yes ', index)) });
    const scorer = createHallucinationScorer({ model: mockJudge([claimResponse, verdicts, 'reason']), options: { context: ['A', 'B'] } });

    const result = await scorer.run(run);

    expect(result.score).toBe(1);
  });

  it('caps hallucination when the judge returns extra positive verdicts', async () => {
    const verdicts = JSON.stringify({ verdicts: [...claims.map((_, index) => makeVerdict('yes', index)), makeVerdict('yes', 0)] });
    const scorer = createHallucinationScorer({ model: mockJudge([claimResponse, verdicts, 'reason']), options: { context: ['A', 'B'] } });

    const result = await scorer.run(run);

    expect(result.score).toBe(1);
  });
});
