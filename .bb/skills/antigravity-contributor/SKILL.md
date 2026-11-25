---
name: antigravity-contributor
description: Use when designing, implementing, documenting, or reviewing changes to the bb-plugin-antigravity repository.
---

# Contribute to the Antigravity provider

## Define the benefit

Before choosing a design, name the person who needs the change. Describe the task they are trying to finish and what goes wrong today. Choose an outcome you can check. In the PR, explain that outcome in words the person would use. For example, “When a command needs my permission, I can see what it will do before I decide.”

## Design and review for security

Trace the changed data or action from its source to its destination. Identify who controls the input, what access the action needs, and which component enforces that limit. Use the [plugin security policy](../../../SECURITY.md) to check assumptions about BB, the host, and `agy`. For example, Plan mode describes CLI behavior. A filesystem restriction needs an enforcement point in the host or bridge.

During review, follow the same path through the diff. Check what happens when permission is denied or input is missing. For changes to task storage or diagnostics, inspect what a saved record or error message reveals. Use synthetic data for test evidence. Report the check that supports the security decision and any remaining uncertainty.

## Adapt upstream provider practices

- **Permission changes.** BB's Codex tests vary permission mode and escalation policy independently. For an Antigravity approval change, exercise Accept edits with automatic approval enabled and escalation denied. Check that the host does not grant the request. Also check the default path that asks the user. [Codex session policy tests](https://github.com/get-bb/bb/blob/fb045a046653cc127656ca3c7243d44ae4c94f3f/plugins/provider-codex/src/session-params.test.ts)
- **Usage changes.** BB's Claude Code tests translate fixtures with both missing and zero token counts. Test these cases with Antigravity's own quota rules. For example, `usage.ts` skips a bucket that reports only a remaining amount. For an active bucket with neither an amount nor a fraction, it reports 100% used. Check the displayed result with synthetic CLI output in `tests/usage.test.mjs`. [Claude Code usage translation tests](https://github.com/get-bb/bb/blob/fb045a046653cc127656ca3c7243d44ae4c94f3f/plugins/provider-claude-code/src/delta-translation.usage.test.ts)

## Write technical documentation

Use ASD-STE100 Issue 9 (January 2025) for new or changed English technical documentation. Check the writing rules and the dictionary in the official standard. Use the same technical name for the same item. Give one instruction per sentence. Put the condition before the action. [Official ASD-STE100 Issue 9 source](https://asd-ste100.org/STE_downloads.html)

Original example for a permission prompt

> Read the command. If you do not recognize the command, deny the request.

State which checks you performed. Claim compliance only if a review against Issue 9 supports that claim.
