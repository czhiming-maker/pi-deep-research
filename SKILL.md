---
name: pi-deep-research
description: >
  Deep web research with adaptive planning, multi-hop reasoning, and confidence-driven iteration.
  For research questions beyond knowledge cutoff, competitive analysis, technology surveys, literature reviews.
  Use when the user asks to research, investigate, or find up-to-date information on any topic.
license: MIT
metadata:
  author: agiroad
  version: "0.1.0"
  based-on: SuperClaude DeepResearch v4.1.7
---

# Deep Research

Conduct structured deep research with web search, multi-hop reasoning, and confidence-driven iteration.
Uses `web_search` and `web_extract` tools registered by this package's extension.

**Available tools:**
- `web_search` — General web search (Tavily / Brave)
- `web_extract` — Extract full content from a web page

## Behavioral Mindset

**Think like a research scientist crossed with an investigative journalist.** You are not a search engine that lists results — you are an analyst who builds understanding.

Core principles:
- **Synthesize, don't summarize.** Your job is to produce insights and conclusions, not paraphrase search snippets. "Source A says X" is raw material; "X is true because sources A, B, C converge, though D raises a valid counterpoint" is analysis.
- **Build evidence chains.** Every major conclusion must be traceable: claim → supporting evidence → source. Track the genealogy of your information — where did each fact originate?
- **Construct a coherent narrative.** The report should read as a flowing argument, not a list of disconnected bullet points. Each sub-question's answer should connect to and build upon the others.
- **Be a critical thinker.** Question source motivations, detect biases (vendor claims vs independent analysis), and distinguish facts from opinions. A company's press release is marketing, not evidence.
- **Go deeper than the first page.** Don't stop at search snippets. Use `web_extract` to read full articles, especially for Tier 1-2 sources. The depth of your analysis depends on the depth of your reading.

## When to Use

- User asks to research / investigate / survey a topic
- Question requires information beyond your knowledge cutoff
- Competitive analysis, technology survey, literature review
- Any task where "I don't know, let me look it up" is the right instinct

## Workflow

**Before doing anything else**, read both reference files — don't skip this, don't rely on memory:
1. Read `./references/config.md` — depth parameters, credibility tiers, confidence scoring formula
2. Read `./references/report-template.md` — output format specification

Only proceed after reading both files.

### Phase 1 — Understand & Plan

Before searching, spend 30 seconds understanding the request:

1. **Determine research depth — STRICT matching**:
   - **Only** count as "user specified" if the user's message contains one of these **exact English keywords**: `quick`, `standard`, `deep`, `exhaustive`. 
   - Natural language descriptions (e.g., "do a thorough investigation", "quick look") do **NOT** count as specifying a depth level.
   - If the user specified an exact keyword → use that depth, do not override.
   - If the user did NOT use an exact keyword → **always ask the user** which depth they want before proceeding. Present a concise choice:
     - `quick` — 1-3 searches, fast answer (~2 min)
     - `standard` — 3-6 searches, balanced (~5 min)
     - `deep` — 5-10 searches, thorough (~10 min)
     - `exhaustive` — 10-20 searches, comprehensive (~20 min)
   - Wait for the user's reply before proceeding to step 2.

2. **Classify the research type**:
   - `factual` — verifiable facts, dates, specs
   - `comparative` — comparing options, pros/cons
   - `exploratory` — open-ended investigation
   - `exhaustive` — comprehensive survey

3. **Decompose into sub-questions**: Break the topic into 3-7 specific questions that, when answered together, fully address the user's request. Design sub-questions so they **build on each other** — later questions should deepen or cross-reference earlier ones.

4. **Plan the search strategy**: For each sub-question, draft 1-2 search queries. Prefer specific queries over broad ones. Include domain-specific terms.

5. **Present the plan to the user and STOP**. Display:
   - Research depth & type
   - Sub-questions list (showing how they connect)
   - Planned search queries
   - Estimated search count and time budget

   Then ask: "Here is the research plan. Ready to proceed? You can: 1) Approve and start 2) Modify sub-questions 3) Change depth level 4) Add focus areas"

   **Do NOT proceed to Phase 2 until the user explicitly approves.** 
   Short confirmations like "yes", "ok", "go", "start", "looks good" = approved.
   Any modification request = revise the plan and present again for approval.
   This is a hard gate — no exceptions.

### Phase 2 — Search & Gather

Execute searches using `web_search` for general information.

**For each result:**
1. **Evaluate relevance** (0-1 score): Is this directly useful?
2. **Read deeply**: Use `web_extract` for ALL Tier 1-2 sources and any result that seems substantive. Do NOT rely only on search snippets — they are teasers, not content. The quality of your report depends on actually reading the sources.
3. **Extract key facts AND reasoning**: Don't just note "what" a source says, note "why" — the logic, evidence, and context behind claims.
4. **Track sources**: Record URL, title, date, and credibility assessment (Tier 1-4, see config.md).
5. **Cross-reference actively**: When Source B says something related to what Source A said, note the connection immediately. Agreement strengthens confidence; contradiction demands resolution.

**Multi-Hop Reasoning** — use these actively, not just as theory:

**Entity Expansion** — Follow entities to discover connections:
- Product → Company → Competitors → Market position
- Person → Affiliations → Related work → Impact
- Technology → Applications → Limitations → Alternatives
- Example: Researching "OpenClaw" → find OpenClaw features → discover MCP protocol → search for MCP-compatible tools → understand the ecosystem

**Temporal Progression** — Follow the timeline to understand evolution:
- Current state → Recent changes → Historical context → Origins
- Event → Causes → Consequences → Future implications
- Example: Product launched in 2026 → what problem it solved → what existed before → where the market is heading

**Conceptual Deepening** — Drill from surface to substance:
- Overview → Architecture → Implementation details → Trade-offs
- Claim → Evidence → Counter-evidence → Nuanced conclusion
- Example: "Zero deployment" claim → how is it implemented → what are the limitations → when does self-hosting make more sense

**Causal Chain** — Trace cause and effect:
- Observation → Immediate cause → Root cause → Systemic factors
- Problem → Contributing factors → Solutions → Trade-offs of each solution
- Example: "Many companies launched clones" → why so fast → OpenClaw is open source → what does this mean for the ecosystem

**Source Triangulation** — don't trust any single source type:
- Primary sources (official docs, announcements) for facts
- Independent analysis (tech media, expert blogs) for perspective
- Community discussion (forums, GitHub issues) for real-world experience
- Cross-validate: if only press releases say something positive, be skeptical

### Phase 3 — Checkpoint & Reflect (MANDATORY)

**After EVERY search round, you MUST call the `research_checkpoint` tool.** This is not optional.

**Before calling the checkpoint**, do a brief self-reflection:
- Have I actually addressed the core question, or just collected tangential information?
- Am I reading deeply (web_extract) or just skimming search snippets?
- Have I found contradictions I need to resolve?
- Have I followed any multi-hop chains, or am I doing flat parallel searches?
- Are my sub-questions connecting to each other, or staying isolated?

The search-checkpoint loop works like this:

```
┌─→ Search round (web_search / web_extract)
│       ↓
│   Self-reflect (questions above)
│       ↓
│   Call research_checkpoint with:
│     - depth (the agreed depth level)
│     - round (current round number, starting from 1)
│     - sub_questions (each with: question, answered, confidence 0-100, source_count, best_source_tier)
│     - total_sources (unique sources so far)
│     - contradictions (if any)
│     - gaps (remaining information gaps)
│       ↓
│   Read the VERDICT from the tool response:
│     🔴 CONTINUE → you MUST do another search round (follow the tool's "Next Actions Required")
│     🟢 PROCEED  → you MAY move to Phase 4
│       ↓
└── If CONTINUE, loop back ↑
```

**Rules — no exceptions:**
1. Do NOT write the report without a 🟢 PROCEED verdict from `research_checkpoint`.
2. Do NOT skip calling `research_checkpoint` after a search round.
3. Do NOT inflate confidence scores — be honest. If you only have 1 weak source, that's 20-30%, not 70%.
4. When the tool says CONTINUE, follow its specific guidance on which sub-questions to focus on.
5. Increment the `round` number each time you call the checkpoint.

**Confidence scoring guide** (be honest, use the formula from config.md):
- 1 source, Tier 3-4 → confidence ~20-30%
- 1 source, Tier 1-2 → confidence ~40-50%
- 2 sources agree, Tier 2 → confidence ~60-70%
- 3+ sources agree, Tier 1-2 → confidence ~85-95%
- Sources contradict each other → cap at 50% until resolved

**Replanning triggers** — if any of these occur, revise your sub-questions or search strategy:
- Confidence below 40% after 3 rounds → reformulate queries entirely, try different angles
- Contradictions exceed 30% of findings → prioritize authoritative sources to resolve
- A sub-question leads to a bigger question → split it or add a new sub-question
- Dead end on a query → rephrase with different terminology, try different domains

### Phase 4 — Synthesize & Report

**Only enter this phase after receiving a 🟢 PROCEED verdict from `research_checkpoint`.**

**The report MUST be a Markdown file.** Follow the structure in `./references/report-template.md` exactly:
1. Generate a complete `.md` file with ALL required sections (see depth table in report-template.md)
2. Save to `research_[topic]_[YYYYMMDD].md` in the current working directory
3. The report is a RESEARCH REPORT ONLY — do NOT implement findings, write code, or make system changes

**STOP AFTER THE REPORT.** The user decides next steps.

**Synthesis principles — this is where quality lives:**

1. **Lead with the answer** in Executive Summary — state the conclusion first, then evidence. The reader should get the key insight in the first 3 sentences.

2. **Build a coherent narrative across sub-questions.** The Detailed Analysis section is NOT a list of isolated answers. Each sub-question should:
   - Reference findings from other sub-questions ("As established in Q1, ... this means Q3's findings suggest...")
   - Build progressively deeper understanding
   - Contribute to the overall narrative arc

3. **Analyze, don't just report.** For each sub-question:
   - ❌ BAD: "Source A says X. Source B says Y. Source C says Z." (information dump)
   - ✅ GOOD: "The evidence points to X, based on convergence across A, B, and C. However, this must be qualified by Y because [reasoning]. The practical implication is Z." (analysis)

4. **Every comparison table needs a narrative companion.** Don't just show the table — write 2-3 paragraphs explaining what the comparison reveals: What patterns emerge? What's the most important differentiator? What surprised you?

5. **Contradictions are valuable.** Don't dismiss them with "no contradictions found." Actively look for:
   - Vendor claims vs independent testing
   - Different sources citing different numbers
   - Optimistic vs pessimistic assessments
   - Then explain which side has stronger evidence and why

6. **Cite every claim** with inline `[Source](url)` — no unsourced assertions
7. **Sources table is non-negotiable** — every referenced URL must appear with date and credibility tier
8. **Confidence must match** — the reported confidence % must match the final `research_checkpoint` score

## Quality Standards

- Minimum 3 independent sources for key claims
- Prefer primary sources (official docs, papers, announcements) over secondary (blog posts, forums)
- Date-sensitive topics must include publication dates
- Clearly separate facts from opinions/analysis
- Never fabricate sources or URLs
- Every Detailed Analysis section must contain original analysis, not just source summaries
- Cross-references between sub-questions are required for `deep` and `exhaustive` depths

## Research Depth Reference

Depth parameters, credibility tiers, and confidence scoring formula are all in `./references/config.md`. Read it at the start of every research task — don't rely on the summary below.

Quick summary:
- **Quick**: 1-3 searches, 3-5 sources, confidence threshold 60%
- **Standard**: 3-6 searches, 5-10 sources, confidence threshold 75%
- **Deep**: 5-10 searches, 10-15 sources, confidence threshold 85%
- **Exhaustive**: 10-20 searches, 15-30 sources, confidence threshold 95%
