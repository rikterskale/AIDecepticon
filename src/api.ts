let activeOrganizationId = ''

export function setApiOrganization(organizationId: string) {
  activeOrganizationId = organizationId
}

function requestHeaders(json = false): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(activeOrganizationId ? { 'X-AIDecepticon-Organization': activeOrganizationId } : {}),
  }
}

export async function apiGet<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`/api/v1/${path}`, { headers: requestHeaders(), credentials: 'same-origin' })
    if (!response.ok) throw new Error(`API returned ${response.status}`)
    return (await response.json()) as T
  } catch {
    return fallback
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method: 'POST',
    headers: requestHeaders(true),
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || `API returned ${response.status}`)
  }
  return (await response.json()) as T
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method: 'PATCH',
    headers: requestHeaders(true),
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`API returned ${response.status}`)
  return (await response.json()) as T
}
