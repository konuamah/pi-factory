---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any "grill" trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map the work as a design tree: every decision branches into the decisions that depend on it.

Work the tree in rounds. The frontier is every decision whose prerequisites are already settled: the questions you can ask now without guessing at answers you have not heard yet. Ask the whole frontier in one round, number each question, and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like this:

```text
Q1 - <question title>: <question body, which may be multiple paragraphs>
-> <your recommended answer>

---

Q2 - <question title>: <question body, which may be multiple paragraphs>
-> <your recommended answer>
```

Each round, the user's answers reshape the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a later round, not this one.

Finding facts is your job, never the user's. When a frontier question needs a fact from the environment, dispatch a sub-agent to find it. Do not block the whole interview on a lookup when you can keep asking the other frontier questions now.

The session is done when the frontier is empty: every branch of the design tree has been visited and nothing is left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
