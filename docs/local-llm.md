# Local LLM for Class Deploys

NanoClaw's credential proxy multiplexes `/openai/*` traffic to whatever host is in `OPENAI_BASE_URL`. Point it at a local OpenAI-compatible server on your host and the class runs entirely offline — no OpenAI API spend, no rate limits, no network dependency. Cost-economical for RAG / experiment-heavy lab content where every query would otherwise hit a paid API.

This runbook covers three popular options on Apple Silicon (mlx-omni-server, Ollama, LM Studio) and the matching `.env` config. The NanoClaw side is **one env var flip**; the work is choosing + running the server.

## How it fits together

```
Class agent group (agent_provider=codex)
   └─ Codex CLI in container
       └─ HTTP POST → ${OPENAI_BASE_URL}/v1/chat/completions
           └─ NanoClaw credential proxy (host:3001)
               └─ Rewrites Authorization: Bearer ${OPENAI_API_KEY}
                   └─ Forwards to ${OPENAI_BASE_URL} (your local server)
                       └─ Local model on the Mac Studio
```

The proxy passes the `model` parameter through unchanged. Whatever model name your local server advertises, the codex CLI can request by name.

## Option 1 — mlx-omni-server (recommended on Apple Silicon)

[mlx-omni-server](https://github.com/madroidmaq/mlx-omni-server) is an OpenAI-compatible server built on MLX. Loads GGUF / MLX-native models from local disk; exposes `/v1/chat/completions` and `/v1/models`.

### Install + run

```bash
# Install (Python — uses uv or pip)
pip install mlx-omni-server

# Run on port 8080, load a model from local cache (Hugging Face cache by default)
mlx-omni-server \
  --host 127.0.0.1 \
  --port 8080 \
  --model Qwen/Qwen2.5-Coder-32B-Instruct-MLX-4bit
```

First start downloads the model (~18 GB for the 32B Q4). Subsequent starts are instant.

### `.env` config

```bash
# Point NanoClaw's /openai/* route at the local server.
OPENAI_BASE_URL=http://127.0.0.1:8080

# OpenAI SDKs refuse to init without a key — set anything non-empty.
# mlx-omni-server ignores it (no auth on a localhost-only listener).
OPENAI_API_KEY=local

# Default model the codex CLI requests when no per-agent model is set.
OPENAI_MODEL=qwen2.5-coder-32b-instruct-mlx-4bit
```

Restart NanoClaw (`systemctl --user restart nanoclaw` on Linux; `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` on macOS) and the proxy picks up the new upstream.

## Option 2 — Ollama (cross-platform, slower than MLX)

[Ollama](https://ollama.com) ships an OpenAI-compatible endpoint at `/v1/*` since v0.1.30. Backend is llama.cpp + Metal on Apple Silicon — slower than MLX but the install story is friendlier and the model catalog is larger.

### Install + run

```bash
brew install ollama   # or download the .app

# Pull a model (one-time per model)
ollama pull qwen2.5-coder:32b

# Daemon runs on 11434 by default
ollama serve
```

### `.env` config

```bash
OPENAI_BASE_URL=http://127.0.0.1:11434
OPENAI_API_KEY=local
OPENAI_MODEL=qwen2.5-coder:32b
```

## Option 3 — LM Studio (GUI)

[LM Studio](https://lmstudio.ai) has a built-in OpenAI-compatible server toggle. Easiest for instructors who'd rather click than CLI.

1. Open LM Studio → Models → download a model (e.g. Qwen 2.5 Coder 32B Q4).
2. Open the **Local Server** tab → load the model → click **Start Server**.
3. Note the URL it prints (default `http://127.0.0.1:1234`).
4. Set `.env`:

```bash
OPENAI_BASE_URL=http://127.0.0.1:1234
OPENAI_API_KEY=local
OPENAI_MODEL=qwen2.5-coder-32b-instruct
```

## Sizing for a class

A single local model on one Mac Studio queues student requests serially. Some math:

- **30 students** in a 90-minute lab session.
- Each message ≈ **5 s** wall time on a 32B Q4 MLX model (depends on prompt + output length).
- If every student sends a message **simultaneously**, last student waits **~2.5 minutes**.
- Realistically request distribution is uneven — expect ≤10 s tail latency, not 2.5 min.

If queueing bites:

- **Drop to a smaller model.** Qwen 2.5 14B is ~3× faster and 80% as smart for most coding tasks.
- **Run two servers** on two ports, route half the agent groups to each via per-group `OPENAI_BASE_URL` overrides (Phase 2 work — provider-settings panel).
- **Switch to vLLM** if you have a GPU host elsewhere. It batches inference and scales much better than llama.cpp / MLX for concurrent load. Same OpenAI-compat surface.

## How to verify it's working

After `.env` change + restart:

```bash
# Should return your local server's model list, not OpenAI's
curl -s http://127.0.0.1:3001/openai/v1/models \
  -H "Authorization: Bearer placeholder" \
  -H "X-NanoClaw-Agent-Group: <some-agent-id>" \
  | head
```

Then trigger a real agent message via Telegram / playground and watch the model server logs — you should see the request hit your local server, not `api.openai.com`.

## Troubleshooting

### `502 OPENAI_API_KEY is not set on the host`

Set any non-empty placeholder: `OPENAI_API_KEY=local` in `.env`, restart.

### `connect ECONNREFUSED 127.0.0.1:8080`

Your local model server isn't running. Start it; verify with `curl http://127.0.0.1:8080/v1/models`.

### Codex CLI complains about model name

The model name in `OPENAI_MODEL` (and any per-group `model` override) must exactly match what your local server advertises. List via `curl http://127.0.0.1:<port>/v1/models | jq .data[].id`.

### Container can't reach `127.0.0.1`

Inside a container `127.0.0.1` is the container, not the host. **You don't need to change anything** — the container's `OPENAI_BASE_URL` env points at the credential proxy on `host.docker.internal:3001`, and the proxy (running on the host) sees `127.0.0.1` as the host. Only `OPENAI_BASE_URL` in `.env` (read by the host proxy) matters.

### Slow on first request after idle

mlx-omni-server lazy-loads the model. First request after `--model` mismatch or idle eviction takes ~30 s of "warming up." Subsequent requests are fast. Use `mlx-omni-server --preload` (or LM Studio's "keep loaded" toggle) to avoid the cold start.

## Tool calling

The OpenAI Chat Completions API supports tool calls via the `tools` parameter; the model returns `tool_calls` in its response. NanoClaw's agents lean on this heavily (MCP tools are exposed to the model as OpenAI-style tools). Local models can do this, but **two things have to be true**:

1. **The server has to expose the tool-call surface.** mlx-omni-server, Ollama (≥ 0.5), and LM Studio all do as of late 2025. Earlier Ollama versions silently dropped `tools` from the request — verify with a curl test if you're on an old install.
2. **The model has to be trained for it.** Not all local models can emit well-formed tool-call JSON. Even ones that can sometimes hallucinate tool names, malform arguments, or ignore the schema.

### Models that work well

These have been validated for tool calling on at least one local server (your mileage varies by quantization and server):

- **Qwen 2.5 Coder family (7B / 14B / 32B)** — best in class for agent use. Trained explicitly for function calling. The 32B Q4 is the sweet spot on a single Mac Studio.
- **Qwen 2.5 (non-coder) 32B+** — solid generalist tool use; slightly weaker on code than the Coder variant.
- **Llama 3.1 (70B for quality; 8B for speed)** — Meta's official function-calling format works through the OpenAI-compat shim, with some quirks.
- **Llama 3.3 70B Instruct** — best Llama for tool use, but ~40 GB even at Q4; only viable on the biggest Mac Studio.
- **DeepSeek Coder V2 16B** — solid on coding + tool use; smaller footprint than the Llamas.

### Models that struggle

- **Anything under 7B parameters** — generally too small to emit reliable structured outputs.
- **Models not explicitly fine-tuned for tool use** — base models, raw chat tunes, older RLHF models. They'll emit prose where JSON is expected.
- **Heavy quantization (Q2/Q3) of even good models** — quantization noise often shows up as malformed JSON first.

### Diagnostics

If your agent is misbehaving and you suspect tool calling is the issue:

```bash
# Hit the local server directly with a tool-call request.
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "qwen2.5-coder-32b-instruct-mlx-4bit",
    "messages": [{"role": "user", "content": "What is 2+2? Use the calculator tool."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "calculator",
        "description": "Evaluate an arithmetic expression",
        "parameters": {
          "type": "object",
          "properties": {"expression": {"type": "string"}},
          "required": ["expression"]
        }
      }
    }]
  }' | jq '.choices[0].message'
```

A working model returns `{"role": "assistant", "tool_calls": [{...}]}`. A struggling model returns `{"role": "assistant", "content": "I'll compute 2+2 = 4..."}` — prose instead of a tool call. If you see prose, swap models before debugging anything else.

### When tool use fails partway through

The codex CLI inside the container handles tool-call retries with a small budget. If the local model emits malformed JSON, you'll see `[agent-runner]` logs reporting parse errors. The session usually recovers within 2–3 retries; if it consistently fails, the model isn't suitable for the workload.

## Model selection — making local models show up

Once your local server is running, models discoverable to NanoClaw fall out of two pieces:

### How model discovery works

1. **The server's `/v1/models` endpoint** lists what's loaded / available locally. mlx-omni-server, Ollama, and LM Studio all expose this. Try `curl http://127.0.0.1:<port>/v1/models | jq '.data[].id'` to see your local list.
2. **NanoClaw's `/model` Telegram command** (installed via `/add-admintools`) calls that endpoint via `src/model-discovery.ts`. Results are cached for 1 hour. It uses `OPENAI_BASE_URL` to find the upstream — so if you've set that to your local server, `/model` automatically shows local models.

### Per-group model picking

Each agent group has a `model` column. Three layers, in priority order:

1. **Per-group override** — `ncl groups update <id> --model <name>` sets `agent_groups.model`. Takes precedence over everything.
2. **`OPENAI_MODEL` env var** — provider default when no per-group override.
3. **Codex CLI's hardcoded fallback** — if neither of the above is set, codex picks a default (cloud) model. Not useful for local-LLM mode.

For a class running on local LLM, set `OPENAI_MODEL` in `.env` once. Students inherit it via their student_NN agent groups. Instructor can override per-group from Telegram with `/model <alias>`.

### Agent playground UI

The playground UI doesn't yet have a model picker — that's **Phase 4 work** (classroom Phase 4 provider-settings panel, deferred until OAuth + Mac Studio LAN IP unblock). Today, model switching is via:

- `/model <alias>` from Telegram (per-group)
- `ncl groups update <id> --model <name>` from CLI (per-group)
- `OPENAI_MODEL` in `.env` (default for new groups)

When Phase 4 lands, the UI will surface the discovered model list as a dropdown — the discovery code (`src/model-discovery.ts`) is already provider-agnostic and will work for local servers without further changes.

## shared-classroom mode and per-person mode compatibility

Local LLM works in either deployment mode:

- **shared-classroom mode** (shared class workspace): all class agents share the local model. No per-student auth needed — the local server doesn't care about the Bearer token.
- **per-person mode** (per-person Google + provider auth): students choose between local LLM and their own OAuth'd provider via the Phase 4 provider-settings panel. The codex `auth.json` resolver chain picks the class-shared local-LLM config when no per-student override exists; per-student OAuth shadows it when present.
