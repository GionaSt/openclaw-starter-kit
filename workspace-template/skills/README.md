# skills/

Your custom skills live here, one folder per skill:

```
skills/
  my-skill/
    SKILL.md
```

Minimal `SKILL.md` skeleton:

```markdown
---
name: my-skill
description: One line saying WHEN to use this skill (triggers) and what it does.
---

# My Skill

Step-by-step procedure the assistant follows when this skill triggers.
```

Guidelines:
- The `description` is what the model reads to decide relevance: put trigger
  phrases in it.
- One skill = one procedure. Split big ones.
- Keep environment-specific values (hosts, IDs) in `TOOLS.md`, not in the skill,
  so skills stay shareable.
