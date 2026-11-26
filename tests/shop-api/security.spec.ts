import { Client } from 'pg';
import { test, expect } from './api.fixture';

// The API's own database connection, as the API opens it (global-setup.ts
// builds it from DB_URL with the shop_api user). These tests check that the
// API itself runs with least privilege, not only that the role is defined.
function apiConnectionUrl(): string {
  const url = new URL(process.env.DB_URL!);
  url.username = 'shop_api';
  url.password = 'shop_api';
  return url.toString();
}

test('the API connects as shop_api, which is not a superuser and ignores no RLS', async () => {
  const client = new Client({ connectionString: apiConnectionUrl() });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls
      FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toEqual({ role: 'shop_api', superuser: false, bypass_rls: false });

    // A bug or an injection in the API could not change data around the procedures.
    await expect(client.query('UPDATE products SET price = 1')).rejects.toMatchObject({ code: '42501' });
    await expect(client.query('DELETE FROM audit_log')).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.end();
  }
});
