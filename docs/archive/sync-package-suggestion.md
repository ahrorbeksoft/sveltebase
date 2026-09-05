> Historical proposal. Superseded by the current sync package API and implementation evidence in `docs/plan-audit.md`; do not use these examples for new integrations.

# Sync Package Suggestion: PocketBase-Style Rules

## Problem

The current sync handler API is flexible, but application handlers can become complex once real row-level permissions are needed.

Today each channel manually repeats the same kinds of work:

- load authenticated user, active role, branch, and school
- check operation permissions like `groupPermissions.includes("update")`
- build SQL filters for visible rows
- load the original row before update/delete
- check that the row belongs to the active branch/school
- prevent unsafe field changes like moving a row to another branch
- decide who receives broadcasts through `scope`

This is correct but noisy. It also makes it easy for one handler to accidentally miss a security check.

The desired DX is closer to PocketBase collection rules:

- `listRule`
- `viewRule`
- `createRule`
- `updateRule`
- `deleteRule`

For this project, the sync package should not know CRM concepts like branches, teachers, students, parents, or owners. But it can provide a policy wrapper that makes those concepts easy to express in the app.

## Main Idea

Add a higher-level helper on top of `defineSync` that supports explicit rules for each operation.

The helper should handle the boring runtime flow:

1. Build app-specific context once.
2. Apply the list SQL rule during `fetch`.
3. Apply create rules before insert.
4. Load the original row before update/delete.
5. Apply update/delete rules against the original row.
6. Return the canonical row after mutation.
7. Keep `scope` as broadcast targeting, not as the security boundary.

The application still owns the business rules.

## Proposed API

```ts
export const groupSync = definePolicySync<Group, User, CrmContext>({
  channel: (ctx) => resolveChannel(ctx, 'groups'),
  table: groups,
  id: groups.id,
  updatedAt: groups.updatedAt,

  context: getCrmContext,

  rules: {
    list: (app) => {
      if (app.role.type === 'owner') {
        return eq(groups.branchId, app.role.branchId);
      }

      if (app.role.type === 'teacher') {
        return and(
          eq(groups.branchId, app.role.branchId),
          eq(groups.teacherId, app.role.id),
        );
      }

      if (app.role.type === 'student') {
        return sql`exists (
          select 1
          from student_subscriptions ss
          where ss.group_id = ${groups.id}
          and ss.student_id = ${app.role.id}
        )`;
      }

      return sql`false`;
    },

    create: (app, data) => {
      return (
        hasPermission(app.role, 'groupPermissions', 'create') &&
        data.branchId === app.role.branchId
      );
    },

    update: (app, original, changes) => {
      if (!hasPermission(app.role, 'groupPermissions', 'update')) return false;
      if (original.branchId !== app.role.branchId) return false;
      if ('branchId' in changes) return false;
      return true;
    },

    delete: (app, original) => {
      return (
        hasPermission(app.role, 'groupPermissions', 'delete') &&
        original.branchId === app.role.branchId
      );
    },
  },
});
```

The generated handler would behave like a normal `defineSync` handler, but with the permission flow standardized.

## Rule Types

The first version should avoid a custom string DSL. A TypeScript API is simpler, typed, and easier to integrate with Drizzle.

Recommended split:

```ts
type PolicyRules<TApp, TRow, TInsert, TChanges> = {
  list: (app: TApp) => SQL;
  create?: (app: TApp, data: TInsert) => boolean | Promise<boolean>;
  update?: (
    app: TApp,
    original: TRow,
    changes: TChanges,
  ) => boolean | Promise<boolean>;
  delete?: (app: TApp, original: TRow) => boolean | Promise<boolean>;
};
```

Why this split:

- `list` needs to become SQL, because fetch must return only visible rows.
- `create`, `update`, and `delete` often need TypeScript business logic.
- `update` and `delete` need the original trusted database row, not the client's local row.

## Generated Fetch Behavior

The helper should generate a `fetch` implementation like this:

```ts
fetch: async (ctx, since) => {
  const app = await context(ctx);
  const listWhere = rules.list(app);

  return db
    .select()
    .from(table)
    .where(and(listWhere, since ? gt(updatedAt, since) : undefined));
};
```

This turns row visibility into the security boundary for sync snapshots and reconnects.

## Generated Update Behavior

The helper should generate update behavior like this:

```ts
update: async (ctx, id, changes) => {
  const app = await context(ctx);

  const original = await loadRowById(app.db, table, idColumn, id);
  if (!original) throw new Error('Not found');

  const visible = await rowMatchesListRule(app, original);
  if (!visible) throw new Error('Forbidden');

  const allowed = await rules.update?.(app, original, changes);
  if (!allowed) throw new Error('Forbidden');

  const [updated] = await app.db
    .update(table)
    .set(changes)
    .where(eq(idColumn, id))
    .returning();

  return updated;
};
```

The important part is that update rules receive `original`, because the original row must come from the server database.

## Views And SQL Policy Queries

Some relationship-heavy rules should be expressed as reusable SQL views or query helpers.

Example view idea:

```sql
create view role_visible_group_edges as

select
  teacher_id as role_id,
  id as group_id,
  'teacher' as reason
from groups
where teacher_id is not null

union all

select
  student_id as role_id,
  group_id as group_id,
  'student_subscription' as reason
from student_subscriptions
where group_id is not null;
```

Then the policy rule becomes smaller:

```ts
list: (app) => sql`exists (
  select 1
  from role_visible_group_edges edge
  where edge.group_id = ${groups.id}
  and edge.role_id = ${app.role.id}
)`;
```

This gives the PocketBase feel without creating a full rule parser.

## Delta Sync Warning

Relationship-based visibility can change even when the target row does not change.

Example: a student is added to a group. The `student_subscriptions` row changes, but the `groups.updatedAt` value might not change. If the client only fetches groups where `groups.updatedAt > since`, it may not receive the newly visible group.

Possible solutions:

- touch the target row when access changes, for example update `groups.updatedAt`
- include relationship timestamps in the list query
- publish a channel-change event and force clients to refetch the channel
- introduce a materialized access table with its own `updatedAt`

The first version can use explicit target-row touching because it is simple and easy to debug.

## What The Sync Package Should Own

The sync package can own generic mechanics:

- shared context creation per operation
- a policy wrapper around `defineSync`
- original-row loading for update/delete
- standardized forbidden/not-found handling
- optional validation integration
- optional CRUD generation for common Drizzle tables
- scoped broadcasting hooks

The sync package should not own app-specific policy decisions.

## What The App Should Own

The app should own CRM-specific authorization:

- role hierarchy: owner, employee, teacher, student, lead, parent
- mapping resources to permission fields like `groupPermissions`
- branch and school ownership rules
- teacher/student/parent relationship rules
- sensitive field rules, such as preventing `branchId` changes
- SQL views or query helpers for complex visibility
- permission invalidation when `roles.accessVersion` changes

## Suggested Implementation Path

1. Build `definePolicySync` inside the app first.
2. Convert one difficult channel, probably `groups` or `roles`.
3. Add tests or manual examples for owner, employee, teacher, student, and parent visibility.
4. Convert more channels once the rule shape feels stable.
5. Move the helper into `@sveltebase/sync` only after the app proves the API.

This keeps the sync package general while making the CRM handlers much easier to read and audit.
