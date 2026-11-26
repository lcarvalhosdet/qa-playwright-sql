import type { FastifyInstance } from 'fastify';

// Read-only reports, straight from the views in 07_advanced_queries.sql.
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports/product-sales', async () => {
    const { rows } = await app.db.query(
      `SELECT product_id AS "productId", sku, name, units, revenue,
              rank, dense_rank AS "denseRank", pct_of_revenue AS "pctOfRevenue"
       FROM product_sales
       ORDER BY row_number`,
    );
    return rows;
  });

  app.get('/reports/category-sales', async () => {
    const { rows } = await app.db.query(
      `SELECT id, path, depth, products, units, revenue
       FROM category_sales
       ORDER BY path`,
    );
    return rows;
  });
}
