export type PageId = 'overview' | 'mesh' | 'incidents' | 'surfaces' | 'integrations' | 'system'

export type BlueprintId =
  | 'threat-intelligence'
  | 'active-directory'
  | 'cloud'
  | 'endpoint'
  | 'mitm'
  | 'internal'
  | 'zero-trust'
  | 'ai-infrastructure'

export interface Blueprint {
  id: BlueprintId
  name: string
  eyebrow: string
  description: string
  signal: string
  color: string
  assets: string[]
  coverage: string[]
}

export interface Deployment {
  id: string
  name: string
  blueprintId: BlueprintId
  environment: string
  location: string
  mode: string
  status: 'healthy' | 'learning' | 'attention' | 'provisioning'
  decoys: number
  interactions: number
  updatedAt: string
}

export interface Incident {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  source: string
  target: string
  technique: string
  confidence: number
  status: string
  age: string
  timestamp: string
  summary: string
  steps: string[]
}

export interface Sensor {
  id: string
  name: string
  type: string
  version: string
  health: number
  latency: number
  address: string
  lastSeen: string
  status?: string
  platform?: string
  capabilities?: string[]
  decoyCount?: number
  enrolledAt?: string
  lastSeenAt?: string
}

export interface SensorCommand {
  id: string
  sensorId: string
  type: string
  status: string
  attempts: number
  maxAttempts: number
  error?: string
  deadLetterReason?: string
  deadLetteredAt?: string
}

export interface Domain {
  id: string
  name: string
  forest: string
  controllers: number
  honeyObjects: number
  status: string
}

export interface Integration {
  id: string
  name: string
  category: string
  status: string
  lastSync: string
}

export interface Summary {
  protectedAssets: number
  activeDetections: number
  sensorsOnline: number
  totalSensors: number
  coverage: number
  meanTimeToDetect: string
}

export interface AuthUser {
  id: string
  email: string
  displayName: string
  role: 'platform_admin' | 'deception_engineer' | 'analyst' | 'auditor' | 'service'
  groups: string[]
  organizationIds: string[]
  provider: string
  mfa: boolean
}

export interface Organization {
  id: string
  name: string
  slug: string
  status: 'active' | 'suspended'
  plan: string
  createdAt: string
}

export interface OrganizationResponse {
  items: Organization[]
  activeOrganizationId: string
}

export interface AuthSession {
  enabled: boolean
  mode: 'disabled' | 'api_key' | 'oidc' | 'saml'
  providerLabel: string
  requireMfa: boolean
  authenticated: boolean
  user: AuthUser | null
  permissions: string[]
}

export interface SecretRecord {
  id: string
  name: string
  type: 'integration' | 'cloud' | 'identity' | 'response' | 'api'
  description: string
  provider: 'local' | 'vault-transit' | 'aws-kms'
  keyId: string
  fingerprint: string
  status: 'active'
  createdAt: string
  updatedAt: string
  createdBy: string
  updatedBy?: string
}

export interface AuditEvent {
  schemaVersion: number
  id: string
  occurredAt: string
  organizationId: string | null
  actor: { id: string; displayName?: string; role?: string; provider?: string; mfa?: boolean }
  action: string
  target: { type: string; id: string }
  outcome: 'success' | 'denied' | 'error'
  request: { id: string; method?: string; path?: string; status?: number; sourceIp?: string }
  previousHash: string
  signingKeyId: string
  hash: string
}

export interface AuditResponse {
  items: AuditEvent[]
  verification: { valid: boolean; checked: number; headHash?: string; failedEventId?: string }
}
