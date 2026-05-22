/**
 * B2: LLM-judge quality rubric for the bench suite.
 *
 * Calls claude-haiku via the credential proxy (http://127.0.0.1:3001/v1/messages)
 * to score each bench output 0–5 on relevance, concision, and formatting.
 * Returns null on any failure so callers can treat scoring as best-effort
 * and still record runs.
 */
import http from 'http';

const PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const JUDGE_TIMEOUT_MS = 30_000;

export interface JudgeResult {
  score: number;   // 0.0 – 5.0
  rationale: string;
}

const JUDGE_SYSTEM =
  'You are an objective AI benchmark judge. Evaluate the RESPONSE to the REQUEST on three criteria:\n' +
  '  1. Relevance  — did it answer the question asked?\n' +
  '  2. Concision  — appropriately brief, no padding or hedging?\n' +
  '  3. Formatting — well-structured, readable, uses markdown only when it helps?\n' +
  'Average the three 0–5 sub-scores for your final score.\n' +
  'Reply with ONLY valid JSON in this exact shape, no prose before or after:\n' +
  '{"score": <number 0.0–5.0>, "rationale": "<one sentence explaining the score>"}';

/**
 * Score a single bench output. Returns null if the judge call fails so
 * the caller can still record the run with quality_score = null.
 */
export async function judgeOutput(
  requestText: string,
  outputText: string,
): Promise<JudgeResult | null> {
  const userContent =
    `REQUEST:\n${requestText.slice(0, 2000)}\n\nRESPONSE:\n${outputText.slice(0, 4000)}`;

  const requestBody = JSON.stringify({
    model: JUDGE_MODEL,
    max_tokens: 256,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });

  const raw = await callProxy(requestBody);
  if (raw === null) return null;

  const text = extractText(raw);
  if (!text) return null;

  return parseJudgeJson(text);
}

// ── Proxy HTTP call ──────────────────────────────────────────────────────────

function callProxy(body: string): Promise<string | null> {
  return new Promise((resolve) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: PROXY_PORT,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': 'placeholder',
        'anthropic-version': '2023-06-01',
      },
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn(`[judge] proxy returned HTTP ${res.statusCode}: ${raw.slice(0, 200)}`);
          resolve(null);
        } else {
          resolve(raw);
        }
      });
      res.on('error', (err) => {
        console.warn(`[judge] response error: ${(err as Error).message}`);
        resolve(null);
      });
    });

    req.on('error', (err) => {
      console.warn(`[judge] request error: ${(err as Error).message}`);
      resolve(null);
    });

    req.setTimeout(JUDGE_TIMEOUT_MS, () => {
      console.warn('[judge] timed out');
      req.destroy();
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

// ── Response parsing ─────────────────────────────────────────────────────────

function extractText(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as {
      content?: { type: string; text?: string }[];
    };
    const texts = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
    return texts.join('') || null;
  } catch {
    console.warn('[judge] failed to parse proxy response JSON');
    return null;
  }
}

function parseJudgeJson(text: string): JudgeResult | null {
  // Strip markdown code fences in case the model wraps the JSON.
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Extract the first {...} block.
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn(`[judge] no JSON object found in response: ${text.slice(0, 100)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; rationale?: unknown };
    const score = typeof parsed.score === 'number' ? parsed.score : parseFloat(String(parsed.score ?? ''));
    if (Number.isNaN(score) || score < 0 || score > 5) {
      console.warn(`[judge] score out of range: ${parsed.score}`);
      return null;
    }
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
    return { score: Math.round(score * 10) / 10, rationale };
  } catch {
    console.warn(`[judge] failed to parse judge JSON: ${match[0].slice(0, 100)}`);
    return null;
  }
}
