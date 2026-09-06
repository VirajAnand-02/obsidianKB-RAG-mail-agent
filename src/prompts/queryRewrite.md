---
id: query-rewrite
name: Query Rewrite
description: Expands a question into retrieval variants that match how notes are actually written.
version: 4
variables:
  - question
  - count
output: json
---
Rewrite the question below into exactly {{count}} short search queries for a personal Obsidian knowledge base.

The goal is retrieval coverage, not answering the question.

A user's wording and a note's wording may differ significantly. Generate queries that preserve the original intent while deliberately varying vocabulary, phrasing, and likely terminology used by the source note.

## Query generation strategy

Use these query types in order whenever {{count}} is at least 3:

1. **Keyword query**
   Use the concrete nouns, technical terms, identifiers, mechanisms, and likely note-heading language that a note author would use.
   Remove question words, conversational filler, and unnecessary grammar.
   Prefer domain-specific terminology over casual wording.

2. **Restated query**
   Express the original question using different wording.
   Use plausible domain synonyms and expand acronyms where useful.
   Preserve the same subject, scope, and intent.

3. **Answer-shaped query**
   Phrase the query like a short declarative statement that a source note might contain.
   Do not invent facts, values, causes, mechanisms, or conclusions that are not present or implied by the original question.
   Convert only the grammatical form, not the factual content.

If {{count}} is greater than 3, use the remaining queries for distinct sub-questions, mechanisms, or terminology appearing in the original question.

For a compound question, prioritize the separate factual components that could plausibly appear in different sections of the same relevant note. Do not invent additional sub-questions.

## Vocabulary translation

Casual wording is often absent from technical notes.

Translate informal phrases into concrete domain vocabulary where appropriate.

Examples:

* "wifi credentials" → `SSID`, `password`
* "driver limits" → `ampere rating`, `current limit`
* "hardware config" → `register`, `bit`, `mode`
* "detection filtering" → `NMS`, `IoU`
* "navigation stuff" → `tile`, `waypoint`, `odometry`

For questions such as "why is X slow?", "why is X broken?", or "why is X limited?", include terminology for the likely mechanism or subsystem rather than repeating only the symptom.

Examples of mechanism-oriented terms include:
`loop`, `post-processing`, `inference latency`, `memory arena`

Only introduce a mechanism term when it is reasonably implied by the question. Do not invent a specific implementation detail.

## Identifier preservation

Keep the following exactly as written whenever they appear in the question:

* proper nouns
* product names
* model names
* file names
* code identifiers
* paths
* URLs
* version numbers
* numeric values
* error codes

Do not normalize, translate, or replace these high-signal tokens.

When an acronym appears:

* keep the acronym unchanged in at least one query
* expand it in another query when its meaning is reasonably unambiguous

Do not invent an acronym expansion when the meaning is ambiguous.

## Retrieval boundaries

Every query must be answerable by the same source material that would answer the original question.

Do not:

* broaden the subject
* introduce related but separate topics
* add assumptions about the user's environment
* invent implementation details
* turn a factual question into a recommendation
* turn a "why" question into a different "how" question
* replace a specific entity with a broader category

Queries may change vocabulary and grammatical form, but must preserve the original subject, intent, and scope.

## Length

* Keep every query concise.
* Target no more than 15 words per query.
* Prefer concrete technical terms over complete sentences when that improves retrieval.

## Output

Return exactly {{count}} strings in a JSON array.

Return only valid JSON.

Do not return Markdown fences, numbering, labels, explanations, or any text outside the JSON array.

The output must have exactly {{count}} items.

Each item must be a non-empty search query string.

## Question

{{question}}
