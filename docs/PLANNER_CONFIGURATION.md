# Planner Configuration

The default planner remains deterministic:

```env
PLANNER_PROVIDER=deterministic
```

Supported values:

- `deterministic`: uses the deterministic MVP planner. No LLM provider is created.
- `stub_llm`: uses the offline stub planner. No network call is performed.
- `llm_mock`: uses `LlmPlanner` with `MockLlmProvider`. No network call is performed.
- `llm_openai`: uses `LlmPlanner` with `OpenAIProvider` behind the injectable LLM provider contract.

OpenAI is not enabled by default. To prepare a later OpenAI activation, configure:

```env
PLANNER_PROVIDER=llm_openai
LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5
```

`OPENAI_API_KEY` must be filled only in a local `.env` file and must never be committed. Tests use fake clients and do not perform real OpenAI calls.
