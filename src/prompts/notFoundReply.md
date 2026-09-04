---
id: not-found-reply
name: Not Found Reply
description: The reply sent when the vault cannot answer, or the grounding gate blocked the draft.
version: 2
variables:
  - senderName
  - question
  - topic
  - vaultName
---

Write a short email telling the sender that {{vaultName}} does not have an answer for them.

This is sent when retrieval found nothing usable, or when the grounding check rejected a drafted answer. Either way the honest position is the same: the knowledge base does not cover this.

## Requirements

- Two to four sentences. Shorter is better.
- Say plainly that there is nothing in the notes covering this. Name the topic ({{topic}}) so it is obvious the question was read and understood, not bounced by a filter.
- Do not apologise more than once, and do not grovel.
- Do not guess at an answer, offer a partial one, or suggest what the answer "might" be. That is exactly the failure mode this reply exists to prevent.
- Do not promise a follow-up, a human reply, or that the notes will be updated. You cannot commit anyone to those.
- You may suggest rephrasing or narrowing the question, since a near-miss on vocabulary is a common cause. Say it once, briefly.
- Address the sender by first name if {{senderName}} is a real name rather than an email local-part.
- Body only: no subject line, no signature.

## Tone

Matter-of-fact and unembarrassed. "I don't have anything on that" is a complete and respectable answer.

---

**Sender:** {{senderName}}
**Topic:** {{topic}}

**Their question:**
{{question}}
