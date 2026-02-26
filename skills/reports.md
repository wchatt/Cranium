# Reports — Writing Decision Briefs & Analysis

## When to Use
The user asks for a report, brief, analysis, or write-up on a topic. Usually ends with "put it in Notion" or "I'll read it later."

## Workflow

1. **Research.** Gather all relevant data — read files, check configs, run commands, search the web. Don't start writing until you have the full picture.
2. **Write the report as a Notion page** under a designated Reports parent page. Use the Notion API (MCP tools or curl).
3. **Create a Notion task** linking to the report. Use a page mention (not a raw URL) so it's clickable.
4. **Report back to the user** with the task link and a one-liner summary.

## Report Style

- **Lead with the decision framework.** "If X, then Y." The user doesn't want to read background — they want to know what to do.
- **No technical deep-dives** unless the user asks for them. They can always ask follow-up questions.
- **Use headings and bullets.** Dense paragraphs get skipped.
- **Keep it scannable.** The user should be able to read the whole thing in 2-3 minutes.
- **Include a recommendation** unless the user explicitly says they just want the facts.
- **Quantify where possible.** "600 MB of RAM" beats "some memory." "$50/mo" beats "some cost."

## Notion Page Structure

Use the Notion API's block children to structure the report:

```json
"children": [
  {"type": "heading_2", "heading_2": {"rich_text": [{"type": "text", "text": {"content": "Section Title"}}]}},
  {"type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": "Body text..."}}]}},
  {"type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "Bullet point"}}]}}
]
```

Supported block types for reports: `heading_2`, `heading_3`, `paragraph`, `bulleted_list_item`, `numbered_list_item`.

## Task Creation

Every report gets a linked task so the user can find it later:
- **Name:** Action-oriented title (e.g., "Decide: Auth strategy for cron jobs before going public")
- **Status:** To Do
- **Priority:** Match the urgency of the decision
- **Project:** Match the relevant project
- **Notes:** 1-2 sentence summary + page mention linking to the full report

```json
"Notes": {"rich_text": [
  {"type": "text", "text": {"content": "Brief summary of what the report covers.\n\nFull report: "}},
  {"type": "mention", "mention": {"type": "page", "page": {"id": "REPORT-PAGE-UUID"}}}
]}
```
