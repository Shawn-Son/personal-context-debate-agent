# Personal Context Debate Agent

Context Debate is an English conversation partner that remembers your interests, positions, and learning preferences. It is designed for one person's workspace and keeps memory in a SQLite database you control.

- **Bootstrap** through a voice interview about English goals, interests, and feedback preferences.
- **Converse** in Explore or Debate mode. Begin on a new topic or pick up an earlier thread.
- **Reflect** with a session summary, an open question, and a small set of English language suggestions.
- **Manage memory** by reviewing the evidence behind each item, editing stale information, or forgetting it.

## Run locally

Requires **Node.js 22.16 or newer**. The application has no npm runtime dependencies.

```sh
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000). Add your own `OPENAI_API_KEY` to `.env` and restart to enable live voice, model-generated typed turns, and AI reviews. OpenAI API usage is billed to the API project. Without a key, a scripted text preview exercises the workspace and session flow.

| Setting | Default or purpose |
| --- | --- |
| `OPENAI_VOICE_MODEL` | `gpt-live-1` |
| `OPENAI_TEXT_MODEL` | `gpt-6-luna` for typed replies and review |
| `OPENAI_VOICE` | `marin` |
| `HOST`, `PORT` | `127.0.0.1`, `3000` |
| `DB_PATH` | `./data/context-debate.sqlite` |
| `APP_USERNAME` | `owner` |
| `APP_PASSWORD` | At least 16 characters for a production or non-loopback bind |
| `APP_ORIGIN` | Complete external origin, such as `https://debate.example.com`, when using a proxy |

## Run in Docker

Set `APP_PASSWORD` and `OPENAI_API_KEY` in `.env`, then start the service.

```sh
docker compose up --build -d
docker compose ps
```

Compose binds to localhost and stores the database in the `debate-data` volume. For a remote deployment, point an HTTPS reverse proxy at that port and set `APP_ORIGIN` to the external HTTPS origin. Serve over HTTPS outside localhost so browsers can access the microphone. Keep the application port behind the proxy and run one replica per workspace.

Back up the SQLite database before replacing the host or removing the named volume. For a simple filesystem backup, stop the app and preserve the data directory, including SQLite sidecar files if present.

## How memory works

Each interview and conversation has its own transcript. Session reviews can propose memory changes. The backend checks their source utterances, preserves revisions, and distinguishes explicit facts from tentative interpretations. Later sessions receive a small set of relevant memories plus recent conversation context.

The application stores transcripts, rather than audio recordings. Live audio and relevant context go to OpenAI when voice is enabled. Forgetting an individual memory removes it from future context while preserving the historical conversation in History. See [architecture and memory rules](docs/architecture.md).

## Verification

```sh
npm test
```

Tests cover the HTTP session lifecycle, memory decisions, transcript replay, and provider requests with mocked transport. GitHub Actions also builds the container and checks startup and authentication.

OpenAI Docs cover the [live voice connection](https://developers.openai.com/api/docs/guides/live), [transcript events](https://developers.openai.com/api/docs/guides/live-conversations), and [model pricing](https://developers.openai.com/api/docs/models/gpt-live-1).
