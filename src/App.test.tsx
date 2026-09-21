import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('AIDecepticon control plane', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline test')))
  })

  afterEach(() => cleanup())

  it('renders the command center and primary guided action', () => {
    render(<App />)
    expect(screen.getByText('Make every attack path')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /deploy deception/i }).length).toBeGreaterThan(0)
  })

  it('exposes every required decoy class in the blueprint library', () => {
    render(<App />)
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

  it('opens the GUI deployment workflow', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /deploy deception/i })[0])
    expect(screen.getByRole('dialog', { name: /guided deception deployment/i })).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
  })
})
