import type { Blueprint, Domain, Incident, Integration, Sensor, Summary, Deployment } from './types'

export const blueprints: Blueprint[] = [
  {
    id: 'threat-intelligence',
    name: 'Threat intelligence',
    eyebrow: 'External attack surface',
    description: 'Internet-facing decoys collect tools, payloads, infrastructure, and attacker tradecraft in real time.',
    signal: 'Live adversary engagement',
    color: '#8b7bff',
    assets: ['Web apps', 'APIs', 'VPN portals', 'IPv6 services'],
    coverage: ['Reconnaissance', 'Exploit attempts', 'Credential attacks'],
  },
  {
    id: 'active-directory',
    name: 'Active Directory',
    eyebrow: 'Identity fabric',
    description: 'Plant high-fidelity honey users, SPNs, computers, trusts, and privileged paths across multiple domains.',
    signal: 'Identity misuse',
    color: '#45d9c5',
    assets: ['Honey users', 'SPNs', 'Domain trusts', 'Privileged groups'],
    coverage: ['Kerberoasting', 'DCSync', 'Recon', 'Golden SAML'],
  },
  {
    id: 'cloud',
    name: 'Cloud deception',
    eyebrow: 'Multi-cloud control plane',
    description: 'Agentless AWS, Azure, and GCP lures spanning IAM, storage, workloads, containers, and serverless.',
    signal: 'Cloud lateral movement',
    color: '#63a8ff',
    assets: ['IAM roles', 'Storage buckets', 'Secrets', 'Containers'],
    coverage: ['Key misuse', 'Privilege escalation', 'Workload discovery'],
  },
  {
    id: 'endpoint',
    name: 'Endpoint decoys',
    eyebrow: 'Windows, macOS & Linux',
    description: 'Deploy safe breadcrumb packages with honey files, cached credentials, shares, and connections.',
    signal: 'Endpoint intrusion',
    color: '#f5b86a',
    assets: ['Honey files', 'RDP profiles', 'SSH keys', 'Browser secrets'],
    coverage: ['Ransomware', 'Credential theft', 'Local discovery'],
  },
  {
    id: 'mitm',
    name: 'Man-in-the-middle',
    eyebrow: 'Layer 2 defense',
    description: 'Expose poisoning and interception across LLMNR, NBNS, mDNS, ARP, and rogue authentication paths.',
    signal: 'Protocol poisoning',
    color: '#f0748f',
    assets: ['LLMNR', 'NBNS', 'mDNS', 'ARP sentinels'],
    coverage: ['Responder', 'Relay', 'Spoofing'],
  },
  {
    id: 'internal',
    name: 'Internal decoys',
    eyebrow: 'Network, IT, OT & IoT',
    description: 'Project believable servers, services, applications, databases, and industrial assets into any segment.',
    signal: 'Lateral movement',
    color: '#ef8d61',
    assets: ['Servers', 'Services', 'Databases', 'OT / IoT'],
    coverage: ['Scanning', 'Exploitation', 'Persistence'],
  },
  {
    id: 'zero-trust',
    name: 'Zero Trust decoys',
    eyebrow: 'Private access layer',
    description: 'Redirect unauthorized private-app access into instrumented clones and synthetic business services.',
    signal: 'Policy bypass',
    color: '#65d37e',
    assets: ['Private apps', 'Admin portals', 'VPN lures', 'SaaS clones'],
    coverage: ['Access abuse', 'Insider threat', 'Session theft'],
  },
  {
    id: 'ai-infrastructure',
    name: 'AI infrastructure',
    eyebrow: 'Models, agents & toolchains',
    description: 'Deceive autonomous attackers with synthetic model endpoints, MCP tools, vector stores, and agent secrets.',
    signal: 'Agentic attack behavior',
    color: '#d96bff',
    assets: ['Model APIs', 'MCP tools', 'Vector stores', 'Agent credentials'],
    coverage: ['Prompt injection', 'Tool abuse', 'Model theft', 'Agent breakout'],
  },
]

export const fallbackSummary: Summary = {
  protectedAssets: 93,
  activeDetections: 2,
  sensorsOnline: 4,
  totalSensors: 4,
  coverage: 87,
  meanTimeToDetect: '11s',
}

export const fallbackDeployments: Deployment[] = [
  { id: 'dep-fin-01', name: 'Finance identity mesh', blueprintId: 'active-directory', environment: 'Production', location: 'corp.east / finance', mode: 'agentless', status: 'healthy', decoys: 38, interactions: 4, updatedAt: new Date().toISOString() },
  { id: 'dep-cloud-02', name: 'AWS production veil', blueprintId: 'cloud', environment: 'AWS / us-east-1', location: 'prod-platform', mode: 'cloud-native', status: 'healthy', decoys: 26, interactions: 2, updatedAt: new Date().toISOString() },
  { id: 'dep-ai-03', name: 'AI platform guardrails', blueprintId: 'ai-infrastructure', environment: 'Kubernetes', location: 'ml-platform / gpu-west', mode: 'sensor', status: 'learning', decoys: 17, interactions: 1, updatedAt: new Date().toISOString() },
  { id: 'dep-end-04', name: 'Executive endpoint shield', blueprintId: 'endpoint', environment: 'Windows', location: 'executive-device-group', mode: 'package', status: 'attention', decoys: 12, interactions: 3, updatedAt: new Date().toISOString() },
]

export const fallbackIncidents: Incident[] = [
  { id: 'INC-2481', severity: 'critical', title: 'Deceptive AWS key invoked from unmanaged host', source: '172.22.14.38', target: 'ci-prod-backup', technique: 'T1552.001', confidence: 99, status: 'contained', age: '4m', timestamp: new Date().toISOString(), summary: 'A seeded cloud credential was enumerated from a developer workstation and used against the decoy STS endpoint.', steps: ['Credential file read', 'STS GetCallerIdentity', 'Decoy S3 listing', 'Host isolated by EDR'] },
  { id: 'INC-2479', severity: 'high', title: 'LLM agent traversed synthetic admin share', source: '10.42.7.19', target: 'FIN-JUMP-04', technique: 'T1021.002', confidence: 97, status: 'investigating', age: '18m', timestamp: new Date().toISOString(), summary: 'Automation-like SMB discovery and rapid credential reuse matched an agentic attack sequence.', steps: ['Share enumeration', 'Honeyfile opened', 'Credential extracted', 'Decoy service login'] },
  { id: 'INC-2476', severity: 'medium', title: 'Kerberoast request for honey service account', source: '10.18.2.44', target: 'svc_erp_archive', technique: 'T1558.003', confidence: 94, status: 'triaged', age: '47m', timestamp: new Date().toISOString(), summary: 'A SPN-backed honey account was requested from a workstation outside the approved administrator segment.', steps: ['LDAP enumeration', 'SPN discovered', 'TGS requested', 'SIEM case created'] },
  { id: 'INC-2471', severity: 'low', title: 'Honey document opened by approved scanner', source: '10.4.1.12', target: 'FY27_Board_Plan.xlsx', technique: 'T1083', confidence: 72, status: 'closed', age: '2h', timestamp: new Date().toISOString(), summary: 'The interaction was traced to the approved DLP scanner and added to the safe list.', steps: ['File enumerated', 'Beacon resolved', 'Scanner identified', 'Source allowlisted'] },
]

export const fallbackSensors: Sensor[] = [
  { id: 'sen-east-01', name: 'East datacenter', type: 'projection', version: '0.9.4', health: 100, latency: 18, address: '10.42.0.18', lastSeen: '12s ago' },
  { id: 'sen-aws-01', name: 'AWS production', type: 'cloud-native', version: '0.9.4', health: 100, latency: 31, address: 'us-east-1', lastSeen: '19s ago' },
  { id: 'sen-azure-01', name: 'Azure identity', type: 'projection', version: '0.9.3', health: 96, latency: 44, address: 'eastus2', lastSeen: '36s ago' },
  { id: 'sen-plant-01', name: 'Factory edge', type: 'rugged', version: '0.9.4', health: 89, latency: 72, address: '10.88.4.10', lastSeen: '2m ago' },
]

export const fallbackDomains: Domain[] = [
  { id: 'dom-1', name: 'corp.east', forest: 'corp.global', controllers: 4, honeyObjects: 148, status: 'protected' },
  { id: 'dom-2', name: 'corp.west', forest: 'corp.global', controllers: 3, honeyObjects: 96, status: 'protected' },
  { id: 'dom-3', name: 'lab.internal', forest: 'lab.internal', controllers: 2, honeyObjects: 42, status: 'learning' },
]

export const fallbackIntegrations: Integration[] = [
  { id: 'int-splunk', name: 'Splunk Enterprise Security', category: 'SIEM', status: 'connected', lastSync: '2m ago' },
  { id: 'int-crowdstrike', name: 'CrowdStrike Falcon', category: 'EDR', status: 'connected', lastSync: '1m ago' },
  { id: 'int-tines', name: 'Tines', category: 'SOAR', status: 'connected', lastSync: '5m ago' },
  { id: 'int-defender', name: 'Microsoft Defender XDR', category: 'XDR', status: 'available', lastSync: '—' },
]
