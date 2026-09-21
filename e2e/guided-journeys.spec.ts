import { expect, test } from '@playwright/test'

test.describe('guided operator journeys', () => {
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
      data: { label: 'Browser recovery sensor' },
    })
    const token = await tokenResponse.json()
    const enrollmentResponse = await request.post('http://127.0.0.1:8787/api/v1/sensors/enroll', {
      data: { enrollmentToken: token.token, sensorId, name: 'Browser recovery sensor' },
    })
    const enrollment = await enrollmentResponse.json()
    const commandResponse = await request.post(`http://127.0.0.1:8787/api/v1/sensors/${sensorId}/commands`, {
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
    await expect(recovery.getByText('browser recovery test failure')).toBeVisible()
    await recovery.getByRole('button', { name: 'Retry' }).click()
    await expect(recovery.getByText('No commands need attention')).toBeVisible()
  })
})
