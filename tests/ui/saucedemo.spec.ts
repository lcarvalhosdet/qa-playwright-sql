import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login-page';

test.describe('Sauce Demo', () => {
  test('standard user adds a product to the cart', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('standard_user');

    await expect(page).toHaveURL(/inventory/);
    await page.getByTestId('add-to-cart-sauce-labs-backpack').click();
    await expect(page.getByTestId('shopping-cart-badge')).toHaveText('1');
  });

  test('locked out user sees an error', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('locked_out_user');

    await expect(loginPage.error).toContainText('locked out');
  });

  test('sorting by price puts the cheapest product first', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('standard_user');

    await page.getByTestId('product-sort-container').selectOption('lohi');
    const prices = page.getByTestId('inventory-item-price');
    await expect(prices.first()).toHaveText('$7.99'); // waits for the list to re-render

    const values = (await prices.allTextContents()).map((text) => Number(text.replace('$', '')));
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});
