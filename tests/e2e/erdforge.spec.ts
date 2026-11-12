import { expect, test } from '@playwright/test';

test.describe('ERDForge end-to-end workflow', () => {
  test('starts with a blank project, adds a table, edits it, and exports DDL', async ({ page }) => {
    await page.goto('/');

    // A first-time user must see a clean workspace, never the old Pharmacy Chain demo.
    await expect(page.getByLabel('ERDForge schema design studio')).toBeVisible();
    await expect(page.getByText('No entities yet')).toBeVisible();
    await expect(page.getByText('Pharmacy Chain')).toHaveCount(0);

    // Create a table directly on the canvas and rename it in the inspector.
    await page.locator('.diagram-add-table-button').click();
    await expect(page.getByLabel('New table entity')).toBeVisible();
    await page.getByLabel('New table entity').click();
    const entityNameInput = page.getByLabel('Entity name');
    await expect(entityNameInput).toHaveValue('New table');
    await entityNameInput.fill('Customer');
    await entityNameInput.blur();
    await expect(page.getByLabel('Customer entity')).toBeVisible();

    // Add a second table and create a visible relationship between the two.
    await page.locator('.diagram-add-table-button').click();
    await expect(page.getByLabel('New table entity')).toBeVisible();
    await page.locator('.react-flow__pane').click({ position: { x: 480, y: 340 } });
    await page.getByRole('button', { name: 'Create relationship' }).click();
    await expect(page.getByRole('dialog', { name: 'Create relationship' })).toBeVisible();
    await page.getByLabel('Relationship label').fill('places');
    await page.getByRole('button', { name: 'Create relationship' }).last().click();
    await expect(page.getByText('places', { exact: true })).toBeVisible();

    // Export the manually-created normalized schema as MySQL DDL.
    await page.getByRole('button', { name: 'Export schema' }).click();
    await expect(page.getByRole('dialog', { name: /Export schema/i })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /MySQL DDL/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.mysql.sql');
  });
});
