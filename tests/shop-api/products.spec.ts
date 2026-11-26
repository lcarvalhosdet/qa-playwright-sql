import { test, expect } from './api.fixture';

// GET /products, the optimistic-locking price update, and the reports.

test.describe('products', () => {
  test('GET /products lists the seed products with price as a string', async ({ api }) => {
    const response = await api.get('/products');
    expect(response.status()).toBe(200);
    const products = await response.json();
    expect(products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sku: 'KB-01', name: 'Keyboard', price: '150.00' }),
        expect.objectContaining({ sku: 'MN-01', name: 'Monitor', price: '900.00' }),
      ]),
    );
  });

  test('GET /products/:id is 404 for an unknown id', async ({ api }) => {
    const response = await api.get('/products/999999');
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ code: 'P0002', error: 'product 999999 does not exist' });
  });
});

test.describe('PATCH /products/:id/price (optimistic locking)', () => {
  test('saves with the current version and returns the next one', async ({ api, scratch }) => {
    const id = await scratch.product(5, 10);
    const { version } = await (await api.get(`/products/${id}`)).json();

    const response = await api.patch(`/products/${id}/price`, { data: { price: 12.5, version } });

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id, price: '12.50', version: version + 1 });
  });

  test('409 SH005 when another client saved first', async ({ api, db, scratch }) => {
    const id = await scratch.product(5, 10);
    // Two clients open the product and see the same version.
    const { version } = await (await api.get(`/products/${id}`)).json();

    await api.patch(`/products/${id}/price`, { data: { price: 11, version } });
    const late = await api.patch(`/products/${id}/price`, { data: { price: 13, version } });

    expect(late.status()).toBe(409);
    expect(await late.json()).toEqual({
      code: 'SH005',
      error: `product ${id} was changed by someone else`,
      detail: `expected version ${version}, current version ${version + 1}`,
      hint: 'Read the product again and repeat the change.',
    });
    const { rows } = await db.query('SELECT price FROM products WHERE id = $1', [id]);
    expect(rows[0].price).toBe('11.00'); // the first save stands
  });

  test('400 for a price that is not positive', async ({ api, scratch }) => {
    const id = await scratch.product(5, 10);
    const response = await api.patch(`/products/${id}/price`, { data: { price: 0, version: 1 } });
    expect(response.status()).toBe(400);
  });
});

test.describe('reports', () => {
  test('a sale made through the API shows up in the product-sales report', async ({ api, scratch }) => {
    const product = await scratch.product(10, 40);
    const customer = await scratch.customer();
    await api.post('/orders', { data: { customerId: customer, items: [{ productId: product, quantity: 3 }] } });

    const report = await (await api.get('/reports/product-sales')).json();

    expect(report).toContainEqual(expect.objectContaining({ productId: product, units: 3, revenue: '120.00' }));
  });

  test('the product-sales report is ordered by revenue, with consistent ranks', async ({ api }) => {
    const report: { revenue: string; rank: number; denseRank: number }[] = await (
      await api.get('/reports/product-sales')
    ).json();

    const revenues = report.map((r) => Number(r.revenue));
    expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
    expect(report[0]).toMatchObject({ rank: 1, denseRank: 1 });
    for (const [i, row] of report.entries()) {
      expect(row.rank).toBeLessThanOrEqual(i + 1); // RANK never runs ahead of the position
      expect(row.denseRank).toBeLessThanOrEqual(row.rank); // DENSE_RANK has no gaps
    }
  });

  test('GET /reports/category-sales returns the tree', async ({ api }) => {
    const report = await (await api.get('/reports/category-sales')).json();
    expect(report.map((r: { path: string }) => r.path)).toContain('Electronics > Computers > Peripherals > Keyboards');
  });
});

test('GET /health checks the database connection', async ({ api }) => {
  const response = await api.get('/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});
