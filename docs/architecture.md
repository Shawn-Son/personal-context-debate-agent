# Architecture

Context Debate pairs spoken English with a personal, inspectable memory. Bootstrap collects a learning goal, real topics, and feedback preferences. A conversation can explore a topic or challenge a position. Its review connects useful language and the next question to the session that produced them.

## Request and storage paths

- The browser uses WebRTC for live microphone and speaker audio. The application server exchanges the browser offer with GPT-Live using a server-side API key. Relevant memory and a limited session history seed each new voice session.
- Live input and output transcript fragments are timestamped, batched, and saved with event IDs. The server normalizes fragments into utterances for review and history. Typed turns use the same records, and remain available without a microphone.
- Ending a session summarizes the stored transcript, produces a few English suggestions, and proposes memory changes. The application verifies evidence against learner utterances before persisting a change. An ended session can be fetched again without running another review.
- SQLite owns the session history and durable memory. The voice provider does not control which memory is active. The transcript and current memory can be examined independently.

## Memory decisions

A memory addresses one topic, setting, or preference. Its key and scope determine whether a candidate refers to the same information. Evidence points to the learner's actual session text.

| Input | Operation |
| --- | --- |
| Clear new information useful in later sessions | Add an active item |
| Same content within the same scope | Attach evidence without changing the value |
| A clear correction or change of mind | Add a revision and update the current value |
| Different preference limited to another setting | Create a scoped item |
| Inference, unresolved contradiction, or uncertain wording | Leave for review |
| A quote, role-play line, or hypothetical argument | Keep it in the session record |
| User deletes an item | Suppress it from future context and automatic re-extraction |

The context for a new session contains applicable settings, selected topic memories, and recent conversation context. User edits take precedence over automatic extraction. A memory deletion affects future context. The session history remains available to the owner.

## Deployment assumptions

Run one application instance against its persistent volume. It holds a single person's workspace, protected by HTTP Basic authentication when deployed. Terminate HTTPS at a reverse proxy, and keep the upstream port private. The local preview uses deterministic text prompts when OpenAI credentials are absent.
