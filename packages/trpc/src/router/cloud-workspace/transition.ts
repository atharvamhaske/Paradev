import { db } from "@superset/db/client";
import type { CloudWorkspaceStatus } from "@superset/db/schema";
import { cloudWorkspaces } from "@superset/db/schema";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Moves a cloud workspace between statuses only from the ones it may leave.
 * The provisioning job and a delete race on the same row: a delete that
 * lands while the box is being made must win, or the job would flip a
 * `archived` row back to `awake` and strand a billed sandbox nothing lists.
 * Returns false when the row was no longer in any of `from`.
 */
export async function transitionCloudWorkspace(args: {
	id: string;
	from: readonly CloudWorkspaceStatus[];
	to: CloudWorkspaceStatus;
	set?: Partial<typeof cloudWorkspaces.$inferInsert>;
	/** Only while the row still names this box: an unarchive may have given it another. */
	onBox?: string;
}): Promise<boolean> {
	const moved = await db
		.update(cloudWorkspaces)
		.set({ ...args.set, status: args.to })
		.where(
			and(
				eq(cloudWorkspaces.id, args.id),
				inArray(cloudWorkspaces.status, [...args.from]),
				args.onBox === undefined
					? undefined
					: eq(cloudWorkspaces.providerSandboxId, args.onBox),
			),
		)
		.returning({ id: cloudWorkspaces.id });
	return moved.length > 0;
}
