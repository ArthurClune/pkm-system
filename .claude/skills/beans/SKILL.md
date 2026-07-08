---
name: beans
description: Track Henderson development work with beans issue tracker. Use when working on Henderson's code, implementing features, fixing bugs, or when user asks to create/manage issues.
---

# Beans Issue Tracker

Use this skill when working on Henderson development tasks. Beans tracks issues, features, bugs, and tasks for this project.

## When to Use

- Working on Henderson's code or configuration
- Implementing new features or fixing bugs in this repo
- User explicitly asks to create an issue or track work

## Workflow

1. **Before starting work**: Create a bean or find an existing one
   ```bash
   beans create "Title" -t <type> -d "Description..." -s in-progress
   ```

2. **While working**: Update checklists in the bean as you complete items

3. **When done**: Mark completed (only if no unchecked items remain)
   ```bash
   beans update <bean-id> --status completed
   ```

4. **When committing**: Include bean files with your code changes

## Quick Reference

### Find work
```bash
beans query '{ beans(filter: { excludeStatus: ["completed", "scrapped", "draft"], isBlocked: false }) { id title status type priority } }'
```

### Read a bean
```bash
beans query '{ bean(id: "<id>") { title status type body } }'
```

### Create a bean
```bash
beans create "Fix login bug" -t bug -d "Users cannot log in when..." -s todo
```

Always specify a type with `-t`:
- **milestone**: Target release or checkpoint
- **epic**: Thematic container for related work
- **bug**: Something broken
- **feature**: User-facing capability
- **task**: Concrete piece of work

### Update status
```bash
beans update <bean-id> --status in-progress
beans update <bean-id> --status completed
```

### Relationships
```bash
# Set parent
beans update <bean-id> --parent <other-id>

# Mark as blocking another bean
beans update <bean-id> --blocking <other-id>
```

## Statuses

- **draft**: Needs refinement
- **todo**: Ready to work on
- **in-progress**: Currently being worked on
- **completed**: Done
- **scrapped**: Won't do

## Priorities

Use `-p` when creating: critical, high, normal, low, deferred

## GraphQL

For complex queries, use `beans query`:

```bash
# All beans with filters
beans query '{ beans(filter: { type: ["bug"], priority: ["critical", "high"] }) { id title status body } }'

# Search by text
beans query '{ beans(filter: { search: "authentication" }) { id title } }'

# Full schema
beans query --schema
```

## Notes

- Prefix bean titles with their IDs when showing to user
- Check for existing similar beans before creating new ones
- Include detailed descriptions with checklists where appropriate
- `beans archive` deletes completed/scrapped beans - only run when explicitly asked
