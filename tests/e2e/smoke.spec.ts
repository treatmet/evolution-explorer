import { expect, test } from '@playwright/test';

test('app renders foundation UI', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Pending Selection' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Difficulty' })).toBeVisible();
  await expect(page.getByText('Decision Lens')).toBeVisible();
  await expect(page.getByLabel('Master difficulty: 55%')).toBeVisible();
  await expect(page.getByLabel('Evolution tree canvas')).toBeVisible();

  await page.getByRole('button', { name: 'Lock Difficulty + Select Target' }).click();
  await expect(page.getByText('Session phase: active')).toBeVisible();
  await expect(page.getByText('Action Menu')).toBeVisible();

  await page.getByRole('button', { name: 'Quit / Score Now' }).dispatchEvent('click');
  await expect(page.getByText('Results', { exact: true })).toBeVisible();
  await expect(page.getByText('Shared traits:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore from Here' })).toBeVisible();

  await page.getByRole('button', { name: 'Explore from Here' }).dispatchEvent('click');
  await expect(page.getByText('Session phase: active')).toBeVisible();
});
