---
id: query-rewrite
name: Query Rewrite
description: Expands a question into retrieval variants that match how notes are actually written.
version: 2
variables:
  - question
  - count
output: json
---

Rewrite the question below into {{count}} short search queries for a personal Obsidian knowledge base.

The point is coverage. A question and the note that answers it rarely share vocabulary — someone asks "how long before it gives up?" and the note says "timeout defaults". Each variant should attack the vocabulary gap from a different angle:

1. **Keyword form** — the nouns a note author would actually write as a heading. Drop question words and filler entirely.
2. **Restated form** — the same question in different words, using likely domain synonyms and expanded acronyms.
3. **Hypothetical answer** — one sentence phrased as if it were the answer, in the declarative voice a note would use. (This retrieves well because it lands in the same embedding neighbourhood as the target passage.)

If more than three variants are requested, add narrower sub-questions for the distinct parts of a compound question.

Rules:
- Every variant must be answerable by the same source that answers the original. Do not broaden the topic.
- Keep proper nouns, product names, file names and numbers exactly as written — those are the highest-signal retrieval tokens available.
- Expand an acronym in one variant, keep it in another. You do not know which form the note uses.
- No variant longer than about 15 words.
- No preamble, no numbering, no explanation.

Return only a JSON array of strings:

```json
["...", "...", "..."]
```

## Question

{{question}}
