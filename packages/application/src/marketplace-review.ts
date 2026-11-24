import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { AppError } from './errors';
import { idSchema } from './ids';

/** Only the public receipt comes from the native projection, never the rest of the review. */
export async function getMarketplaceListingReview(
  database: AppDatabase,
  context: TenantContext,
  listingId: string,
) {
  const id = idSchema.safeParse(listingId);
  if (!id.success) throw new AppError('INVALID_INPUT');
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const result = await tx.execute<{ reviewerLabel: string; decidedAtMs: number }>(
      sql`select reviewer_label as "reviewerLabel",
                 (extract(epoch from decided_at) * 1000)::float8 as "decidedAtMs"
          from marketplace.listing_review_summary(${id.data}::uuid)`,
    );
    const review = result.rows[0];
    if (!review) throw new AppError('NOT_FOUND');
    return { reviewerLabel: review.reviewerLabel, decidedAt: new Date(review.decidedAtMs) };
  });
}
