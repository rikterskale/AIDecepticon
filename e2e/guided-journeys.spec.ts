import { expect, test } from '@playwright/test'

const controlPlaneApiKey = 'e2e-control-plane-key-with-at-least-32-bytes'

test.describe('guided operator journeys', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Control-plane API key').fill(controlPlaneApiKey)
    await page.getByRole('button', { name: 'Sign in securely' }).click()
    await expect(page.getByRole('heading', { name: 'Make every attack path untrustworthy.' })).toBeVisible()
  })

  test('deploys an AI infrastructure deception through the four-step wizard', async ({ page }) => {
    const deploymentName = `AI projection ${Date.now()}`
    await page.goto('/')

    await page.getByRole('button', { name: 'Deploy deception' }).click()
    const wizard = page.getByRole('dialog', { name: 'Guided deception deployment' })
    await expect(wizard).toBeVisible()
    await wizard.getByRole('button', { name: /AI infrastructure/i }).click()
    await wizard.getByRole('button', { name: /Continue/i }).click()

    await wizard.getByLabel('Deployment name').fill(deploymentName)
    await wizard.getByLabel('Placement / scope').fill('ml-platform / inference')
    await wizard.getByRole('button', { name: 'Projection sensor Project decoys into remote segments', exact: true }).click()
    await wizard.getByRole('button', { name: /Continue/i }).click()

    await wizard.getByRole('button', { name: 'Fake servers' }).click()
    await wizard.getByRole('button', { name: 'Fake services' }).click()
    await wizard.getByRole('button', { name: /Continue/i }).click()

    await expect(wizard.getByText('Ready to deploy')).toBeVisible()
    await wizard.getByRole('button', { name: /Deploy now/i }).click()
    await expect(page.getByText(`${deploymentName} is provisioning`)).toBeVisible()
  })

  test('creates and arms a canary token entirely in the GUI', async ({ page }) => {
    const tokenName = `Finance tripwire ${Date.now()}`
    await page.goto('/')

    await page.getByRole('button', { name: 'Generate token' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('Create a deception token')).toBeVisible()
    await modal.getByLabel('Token name').fill(tokenName)
    await modal.getByRole('button', { name: 'Connection', exact: true }).click()
    await modal.getByRole('button', { name: /Generate & arm token/i }).click()

    await expect(modal.getByText('Your token is armed')).toBeVisible()
    await expect(modal.getByText(/\/api\/v1\/beacon\/tok-/)).toBeVisible()
  })

  test('creates a one-time sensor enrollment through protected surfaces', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Protected surfaces' }).click()
    await page.getByRole('button', { name: 'Add sensor' }).click()
    const modal = page.getByRole('dialog', { name: 'Enroll projection sensor' })
    await modal.getByLabel('Sensor name').fill(`Edge sensor ${Date.now()}`)
    await modal.getByRole('button', { name: /Create enrollment/i }).click()

    await expect(modal.getByText('Enrollment ready')).toBeVisible()
    await expect(modal.getByText('Build the sensor image')).toBeVisible()
    await expect(modal.getByText('Run in the target segment')).toBeVisible()
    await expect(modal.getByText(/AID_ENROLLMENT_TOKEN=/)).toBeVisible()
  })

  test('recovers a dead-lettered sensor command through protected surfaces', async ({ page, request }) => {
    const sensorId = `sen-browser-recovery-${Date.now()}`
    const tokenResponse = await request.post('http://127.0.0.1:8787/api/v1/sensor-enrollment-tokens', {
      headers: { Authorization: `Bearer ${controlPlaneApiKey}` },
      data: { label: 'Browser recovery sensor' },
    })
    const token = await tokenResponse.json()
    const enrollmentResponse = await request.post('http://127.0.0.1:8787/api/v1/sensors/enroll', {
      data: { enrollmentToken: token.token, sensorId, name: 'Browser recovery sensor' },
    })
    const enrollment = await enrollmentResponse.json()
    const commandResponse = await request.post(`http://127.0.0.1:8787/api/v1/sensors/${sensorId}/commands`, {
      headers: { Authorization: `Bearer ${controlPlaneApiKey}` },
      data: { type: 'snapshot', maxAttempts: 1 },
    })
    const command = await commandResponse.json()
    await request.get(`http://127.0.0.1:8787/api/v1/sensors/${sensorId}/commands`, {
      headers: { Authorization: `Bearer ${enrollment.accessToken}` },
    })
    await request.post(`http://127.0.0.1:8787/api/v1/sensors/${sensorId}/commands/${command.id}/ack`, {
      headers: { Authorization: `Bearer ${enrollment.accessToken}` },
      data: { status: 'failed', error: 'browser recovery test failure' },
    })

    await page.goto('/')
    await page.getByRole('button', { name: 'Protected surfaces' }).click()
    const recovery = page.locator('.command-recovery-panel')
    await expect(recovery.getByRole('heading', { name: 'Command dead-letter queue' })).toBeVisible()
    const recoveryRow = recovery.locator('article').filter({ hasText: sensorId })
    await expect(recoveryRow).toBeVisible()
    await recoveryRow.getByRole('button', { name: 'Retry' }).click()
    await expect(recoveryRow).not.toBeVisible()
  })

  test('protects and rotates a provider credential with a verified audit chain', async ({ page }) => {
    const secretName = `Splunk HEC ${Date.now()}`
    await page.goto('/')
    await page.getByRole('button', { name: 'Platform & API' }).click()
    await page.locator('.secret-vault-panel').getByRole('button', { name: 'Add secret', exact: true }).first().click()

    const createModal = page.getByRole('dialog', { name: 'Add encrypted secret' })
    await createModal.getByLabel('Display name').fill(secretName)
    await createModal.getByLabel('Description').fill('Browser-tested SIEM export credential')
    await createModal.getByLabel('Secret value').fill('initial-browser-secret-value')
    await createModal.getByRole('button', { name: 'Encrypt & store secret' }).click()

    const vault = page.locator('.secret-vault-panel')
    const secretRow = vault.locator('article').filter({ hasText: secretName }).first()
    await expect(secretRow).toBeVisible()
    await expect(secretRow.getByText(/fp:[a-f0-9]{16}/)).toBeVisible()
    await secretRow.getByRole('button', { name: `Rotate ${secretName}` }).click()

    const rotateModal = page.getByRole('dialog', { name: `Rotate ${secretName}` })
    await rotateModal.getByLabel('Replacement secret value').fill('rotated-browser-secret-value')
    await rotateModal.getByRole('button', { name: 'Rotate encrypted value' }).click()
    await secretRow.getByRole('button', { name: 'Verify' }).click()
    await expect(page.getByText(`${secretName} decrypted and matched its integrity fingerprint`)).toBeVisible()

    const audit = page.locator('.audit-panel')
    await expect(audit.getByText('Chain verified')).toBeVisible()
    await expect(audit.getByText('secret verify')).toBeVisible()
  })

  test('creates and switches to an isolated MSSP organization through the GUI', async ({ page }) => {
    const organizationName = `Managed tenant ${Date.now()}`
    await page.goto('/')
    await page.getByRole('button', { name: 'Platform & API' }).click()
    await page.locator('.organization-panel').getByRole('button', { name: 'Add organization' }).click()

    const modal = page.getByRole('dialog', { name: 'Add organization' })
    await modal.getByLabel('Organization name').fill(organizationName)
    await modal.getByLabel('Operating model').selectOption('managed')
    await modal.getByRole('button', { name: 'Create organization' }).click()

    await expect(page.getByText(`${organizationName} is ready with an isolated workspace`)).toBeVisible()
    await expect(page.getByLabel('Active organization').locator('option:checked')).toHaveText(organizationName)
    await expect(page.locator('.organization-panel').getByText(organizationName)).toBeVisible()
    await page.getByLabel('Active organization').selectOption({ label: 'AIDecepticon Demo' })
    await expect(page.getByLabel('Active organization').locator('option:checked')).toHaveText('AIDecepticon Demo')
  })

  test('creates and validates an encrypted recovery point through the GUI', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Platform & API' }).click()
    const recovery = page.locator('.backup-panel')
    await recovery.getByRole('button', { name: 'Create backup' }).first().click()

    const row = recovery.locator('article').filter({ hasText: /bkp-\d{8}T\d{6}Z-[a-f0-9]{8}/ }).first()
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Validate' }).click()
    await expect(page.getByText(/verified: \d+ audit events/)).toBeVisible()

    await row.getByRole('button', { name: 'Restore' }).click()
    const restore = page.getByRole('dialog', { name: /Restore bkp-/ })
    await expect(restore.getByText('This replaces all current control-plane state.')).toBeVisible()
    await expect(restore.getByRole('button', { name: 'Validate, checkpoint & restore' })).toBeDisabled()
  })
})
