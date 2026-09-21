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
