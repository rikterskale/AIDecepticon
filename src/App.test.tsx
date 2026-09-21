import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('AIDecepticon control plane', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('/api/v1/auth/session')) {
        return Promise.resolve(new Response(JSON.stringify({
          enabled: false,
          mode: 'disabled',
          providerLabel: 'Local development',
          requireMfa: false,
          authenticated: true,
          user: { id: 'test-admin', email: 'admin@example.test', displayName: 'Test Admin', role: 'platform_admin', groups: [], provider: 'development', mfa: true },
          permissions: ['*'],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return Promise.reject(new Error('offline test'))
    }))
  })

  afterEach(() => cleanup())

  it('renders the command center and primary guided action', async () => {
    render(<App />)
    expect(await screen.findByText('Make every attack path')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /deploy deception/i }).length).toBeGreaterThan(0)
  })

  it('exposes every required decoy class in the blueprint library', async () => {
    render(<App />)
    await screen.findByText('Make every attack path')
    fireEvent.click(screen.getByRole('button', { name: /deception mesh/i }))

    for (const name of [
      'Threat intelligence',
      'Active Directory',
      'Cloud deception',
      'Endpoint decoys',
      'Man-in-the-middle',
      'Internal decoys',
      'Zero Trust decoys',
      'AI infrastructure',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    }
  })

  it('opens the GUI deployment workflow', async () => {
    render(<App />)
    await screen.findByText('Make every attack path')
    fireEvent.click(screen.getAllByRole('button', { name: /deploy deception/i })[0])
    expect(screen.getByRole('dialog', { name: /guided deception deployment/i })).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
  })

  it('opens the guided encrypted-secret workflow', async () => {
    render(<App />)
    await screen.findByText('Make every attack path')
    fireEvent.click(screen.getByRole('button', { name: 'Platform & API' }))
    fireEvent.click(screen.getAllByRole('button', { name: /^Add secret$/ })[0])
    expect(screen.getByRole('dialog', { name: 'Add encrypted secret' })).toBeInTheDocument()
    expect(screen.getByText('Encrypted at rest')).toBeInTheDocument()
    expect(screen.getByText('No plaintext reads')).toBeInTheDocument()
  })

  it('guides unauthenticated operators to enterprise sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: true,
      mode: 'oidc',
      providerLabel: 'Enterprise SSO',
      requireMfa: true,
      authenticated: false,
      user: null,
      permissions: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Sign in to the control plane' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Continue with enterprise SSO/i })).toHaveAttribute('href', '/api/v1/auth/login?returnTo=/')
  })
})
