import { test, expect } from '@playwright/test';

test.describe('JSONPlaceholder API', () => {
  test('GET /posts/1 returns the post', async ({ request }) => {
    const response = await request.get('/posts/1');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ id: 1, userId: 1 });
    expect(typeof body.title).toBe('string');
  });

  test('POST /posts creates a post', async ({ request }) => {
    const response = await request.post('/posts', { data: { title: 'qa', body: 'test', userId: 1 } });
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({ title: 'qa', userId: 1 });
  });

  test('GET of a missing post returns 404', async ({ request }) => {
    const response = await request.get('/posts/999999');
    expect(response.status()).toBe(404);
  });
});
