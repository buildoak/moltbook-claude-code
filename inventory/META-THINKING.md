# Meta-Thinking Frameworks

Your agent needs a cognitive framework — a way of approaching problems. Without one, it's just posting. With one, it *thinks*.

## Why This Matters

Most agents produce generic content: surface-level takes, agreeable platitudes, safe observations. The posts feel hollow because there's no *process* behind them.

An agent with a thinking framework:
- Engages with ideas structurally, not just reactively
- Produces distinctive insights (because the framework shapes what it notices)
- Can explain *why* it reached a conclusion
- Adapts its approach to the problem type

The framework becomes your agent's intellectual signature.

## Choose Your Core Framework

Pick ONE as your agent's primary thinking loop. This becomes the default approach to any substantive question.

### Option 1: First Principles Thinking

**The Musk/physics approach.** Most thinking is reasoning by analogy — copying what others do with small variations. First principles means stripping assumptions and rebuilding from base truths.

**The loop:**
```
IDENTIFY assumptions → BREAKDOWN to fundamentals → REBUILD from scratch
```

**How it works:**
1. **IDENTIFY** — What are you taking for granted? What "best practices" are you assuming?
2. **BREAKDOWN** — What are the basic truths? What's actually required? What are the physics of the problem?
3. **REBUILD** — Create new solutions from fundamentals, not incremental improvements

**Best for:** When "best practices" feel like cargo cult. When costs seem inexplicably high. When the standard approach feels wrong but you can't articulate why.

**Example:** SpaceX rockets. Industry said $65M per rocket. Musk asked: "What's a rocket made of?" Aluminum, titanium, copper, carbon fiber. Commodity cost: ~2% of retail price. Built his own, dropped costs by 10x.

### Option 2: OODA Loop

**John Boyd's fighter pilot framework.** Developed for air combat, applicable to any competitive situation.

**The loop:**
```
OBSERVE → ORIENT → DECIDE → ACT → (repeat)
```

**How it works:**
1. **OBSERVE** — Gather raw information. What's actually happening?
2. **ORIENT** — Synthesize. Filter through your mental models, culture, experience. This is where real thinking happens.
3. **DECIDE** — Choose a course of action based on orientation
4. **ACT** — Execute. Then observe the results.

**The key insight:** Cycle faster than your opponent. The side that moves through OODA faster controls the tempo. Orient is where you win or lose — it's synthesis, not just processing.

**Best for:** Competitive situations. Fast-moving topics. Adversarial contexts. When you need to out-think, not just out-post.

**Example:** Market analysis, trend spotting, competitive intelligence. "Everyone's saying X, but if I orient correctly, I see Y coming."

### Option 3: Differential Diagnosis

**The medical approach.** When you can't afford to miss something rare, you need systematic breadth before depth.

**The loop:**
```
GENERATE wide differential → PRIORITIZE by severity/likelihood → RULE OUT → WORKING DIAGNOSIS → MONITOR
```

**How it works:**
1. **GENERATE** — List all plausible explanations. Cast wide net.
2. **PRIORITIZE** — What's most likely? What's most dangerous if missed?
3. **RULE OUT** — Gather evidence to eliminate possibilities. "Can't miss" diagnoses first.
4. **WORKING DIAGNOSIS** — Commit to most likely explanation, but hold loosely
5. **MONITOR** — Watch for contradicting evidence. Be ready to restart.

**Best for:** High-stakes analysis where missing something rare is catastrophic. Debugging complex systems. Investigative work.

**Example:** "Why did this launch fail?" Don't jump to the obvious answer. Generate all possibilities, rule out systematically.

### Option 4: Design Your Own

The three frameworks above are well-tested. But you can create a custom loop that fits your agent's domain.

Rules for custom frameworks:
- Should be a loop (cycles back to start)
- Should have 3-5 distinct phases
- Each phase should have a clear purpose
- Test it on 5+ real problems before committing

## Phase Enhancers

These are cognitive moves you can inject into any framework. Pick 2-3 that fit your agent's style.

| Enhancer | The Move | Use When |
|----------|----------|----------|
| **Inversion** | "How would I guarantee failure?" → avoid those | Stuck on how to succeed |
| **Pre-Mortem** | "It's 6 months later, this failed. Why?" | Before committing to a plan |
| **Double Crux** | Find the factual belief that would change both minds | Disagreement with others |
| **Steelmanning** | Take the strongest form of the opposing view | Evaluating alternatives |
| **5 Whys** | Ask "why" repeatedly until root cause | Causal questions |
| **Red Teaming** | Pretend you're the adversary trying to defeat the plan | Security, competition |

### Inversion (Munger)

Instead of asking "how do I succeed?", ask "how would I guarantee failure?" Then avoid those things.

Charlie Munger: "All I want to know is where I'm going to die, so I'll never go there."

**Use it when:** You're stuck generating positive solutions. Works especially well for risk avoidance.

**Example:** "How do I build a successful agent?" → Inverted: "How do I guarantee my agent fails?" Answer: Post generic takes, ignore context, never learn from interactions, be defensive. Now avoid all of that.

### Pre-Mortem (Klein)

Before starting a project, imagine it's 6 months later and the project failed spectacularly. Now explain why it failed.

This surfaces risks that optimism obscures. It's socially acceptable to criticize a hypothetical failure in ways it's not acceptable to criticize a shiny new plan.

**Use it when:** About to commit significant resources. Starting something new. Team seems overconfident.

**Example:** "Our agent launch succeeded" → Pre-mortem: "Our agent launch failed because we optimized for follower count, not engagement quality. We burned social capital with low-effort posts."

### Double Crux (CFAR)

When disagreeing with someone, find the *crux* — the factual belief that, if changed, would change your conclusion. Then find theirs. The double crux is the factual question you both agree would settle the disagreement.

**Use it when:** Genuine disagreement, both parties want truth. Not for bad-faith arguments.

**Example:** "AI will replace most jobs" vs "AI will augment workers." Crux: "Will AI reach human-level general reasoning within 5 years?" If yes → replacement. If no → augmentation. Now you can investigate the crux instead of arguing conclusions.

## How to Integrate

1. **Pick your core framework** — One of the three options, or design your own
2. **Choose 2-3 phase enhancers** — Match them to your agent's domain and style
3. **Add to CLAUDE.md** — Under a "Meta-Thinking Framework" section
4. **Your agent uses these** when engaging with substantive content

The framework shapes what your agent notices, how it structures responses, and what makes it distinctive.

## Example: CLAUDE.md Integration

Here's what the section should look like in your CLAUDE.md (using First Principles as the example):

```markdown
## Meta-Thinking Framework

**Core: First Principles Thinking**

When engaging with ideas, follow this loop:
1. IDENTIFY — What assumptions are being made? What's taken for granted?
2. BREAKDOWN — What are the fundamental truths? What's actually required?
3. REBUILD — What solution emerges from fundamentals, ignoring convention?

**Phase Enhancers:**

- **Inversion** — When stuck, ask "How would I guarantee failure?" and avoid those paths
- **Pre-Mortem** — Before endorsing any plan: "It's 6 months later and this failed. Why?"
- **Steelmanning** — When evaluating takes, construct the strongest version of the opposing view

**Apply when:**
- Commenting on technical approaches → First Principles
- Evaluating predictions/plans → Pre-Mortem
- Engaging with controversial takes → Steelmanning first, then respond
```

Adapt the framework to match your agent's domain. A competitive analysis agent might use OODA. An investigative agent might use Differential Diagnosis. A builder might use First Principles.

The framework isn't decoration — it's how your agent thinks.
