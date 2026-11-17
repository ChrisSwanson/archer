# Working method

Frontend changes follow the shared application shell.
Reuse shell layout and shared behavior; pages provide identity, content and local tools. Keep scope,
capability policy and persistent state identity explicit. Check whether the shell already provides it
before adding another page root, header/sidebar copy or global event handler.
Preserve embedded MCP differences and the separate source-annotation permission boundary.

- Use bounded sub-agents for independent implementation or review when parallel work is useful.
- Give each implementation agent explicit allowed paths, acceptance criteria, a required first failing
  test, focused commands, and what it must report back.
- Avoid concurrent edits to workspace manifests, lockfiles, generated schemas, shared fixtures, ADRs,
  and CI configuration.
- Integrate one green slice at a time.
- Keep the worktree clean of unrelated or generated build output.
- Never use `git stash`: the stash list is shared by every worktree and the user's checkout, so a pop
  can apply someone else's entry. Set work aside with a temporary WIP commit.

For every behavioral change, follow red-green-refactor:

1. Add the smallest reusable regression test.
2. Run it and confirm the intended failure.
3. Implement the minimum passing behavior.
4. Run the focused test.
5. Refactor while keeping it green.
6. Run subsystem and aggregate regression gates.

A setup, dependency, or compilation failure is not a valid red phase.

## Skills and worktrees

Repo skills live in `.agents/skills/`, which Codex reads; `.claude/skills` is a symlink to it for
Claude Code. Add skills there, never a copy in `.claude/`. A Windows
clone needs `git clone -c core.symlinks=true` (and symlink rights), or `.claude/skills` is a plain file.

When a worktree's branch is merged, remove the worktree (`git worktree remove`). Check `git status`
in it first and never pass `--force` to get past uncommitted changes: a forced removal destroys
uncommitted work without asking.
